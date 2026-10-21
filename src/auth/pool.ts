/** Request-local Codex account selection at every authenticated use. */
export interface Quota {
  provider: string;
  kind: 'ready' | 'watch' | 'low' | 'blocked' | 'error' | 'missing-auth';
  remainingPercent?: number;
  weeklyResetAt?: number;
}
export interface AuthLease {
  provider: string;
  apiKey: string;
  accountId: string;
  headers: Record<string, string>;
}
export type Operation = 'chat' | 'web' | 'image' | 'compact';
export interface SelectorContext {
  members: string[];
  timestamp: number;
  reason: 'auth-use';
  modelId: string;
  getQuota: (provider: string) => Promise<Quota | undefined>;
}
export type Selector = (context: SelectorContext) => Promise<string | undefined>;
export interface PoolOptions {
  members: readonly string[];
  selector: Selector;
  getQuota: (provider: string, signal?: AbortSignal) => Promise<Quota>;
  resolveAuth: (provider: string, signal?: AbortSignal) => Promise<AuthLease>;
  initialAccount?: string;
  cacheMs?: number;
  now?: () => number;
}

/** Safe error code only; upstream response bodies or credentials must not appear in diagnostics. */
export class PoolError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'PoolError'; }
}

/** Interpret WHAM quota windows as their conservative minimum. */
export function quotaFromUsage(provider: string, body: unknown): Quota {
  const value = body as { rate_limit?: { allowed?: boolean; limit_reached?: boolean; primary_window?: unknown; secondary_window?: unknown } };
  const rate = value?.rate_limit;
  if (!rate || typeof rate !== 'object') return { provider, kind: 'error' };
  const windows = [rate.primary_window, rate.secondary_window].filter(w => w != null) as Array<{ used_percent?: number; limit_window_seconds?: number; reset_at?: number }>;
  const valid = windows.length > 0 && windows.every(w => w && typeof w === 'object' && typeof w.used_percent === 'number' && Number.isFinite(w.used_percent) && w.used_percent >= 0 && w.used_percent <= 100 && typeof w.limit_window_seconds === 'number' && w.limit_window_seconds > 0);
  const weekly = windows.find(w => w?.limit_window_seconds === 604800);
  const remainingPercent = rate.allowed === false || rate.limit_reached === true ? 0 : valid ? Math.min(...windows.map(w => 100 - w.used_percent!)) : undefined;
  return { provider, kind: remainingPercent === undefined ? 'error' : remainingPercent === 0 ? 'blocked' : remainingPercent < 20 ? 'low' : 'ready', remainingPercent,
    weeklyResetAt: typeof weekly?.reset_at === 'number' && Number.isFinite(weekly.reset_at) ? weekly.reset_at : undefined };
}

/** Default policy: at least 20% left, nearest future weekly reset first, then most remaining. */
export const weeklyResetSelector: Selector = async ({ members, getQuota, timestamp }) => {
  const candidates = await Promise.all(members.map(async provider => {
    const quota = await getQuota(provider);
    const left = quota?.remainingPercent;
    if (!quota || ['error', 'missing-auth', 'blocked'].includes(quota.kind) || typeof left !== 'number' || !Number.isFinite(left) || left < 20 || left > 100) return undefined;
    const reset = quota.weeklyResetAt !== undefined && Number.isFinite(quota.weeklyResetAt) && quota.weeklyResetAt * 1000 > timestamp ? quota.weeklyResetAt : Infinity;
    return { provider, left, reset };
  }));
  return candidates.filter((v): v is NonNullable<typeof v> => v !== undefined).sort((a, b) => a.reset === b.reset ? b.left - a.left : a.reset - b.reset)[0]?.provider;
};

/** No global credential slot is changed: each operation receives a frozen selected credential. */
export class CodexPool {
  private selected?: string;
  private queue: Promise<void> = Promise.resolve();
  private cache = new Map<string, { expires: number; quota: Quota }>();
  private cooldowns = new Map<string, number>();
  private now: () => number;
  constructor(private readonly options: PoolOptions) {
    if (!options.members.length || new Set(options.members).size !== options.members.length || options.members.some(m => !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(m))) throw new PoolError('INVALID_POOL', 'Pool must list distinct lowercase hyphenated account names.');
    this.selected = options.members.includes(options.initialAccount ?? '') ? options.initialAccount : undefined;
    this.now = options.now ?? Date.now;
  }
  private async quota(provider: string, signal?: AbortSignal): Promise<Quota> {
    signal?.throwIfAborted();
    const hit = this.cache.get(provider);
    if (hit && hit.expires > this.now()) return hit.quota;
    let quota: Quota;
    try { quota = await this.options.getQuota(provider, signal); }
    catch (error) { if (signal?.aborted) throw error; quota = { provider, kind: 'error' }; }
    this.cache.set(provider, { expires: this.now() + (this.options.cacheMs ?? 30_000), quota });
    return quota;
  }
  async acquire(_operation: Operation, modelId = '', signal?: AbortSignal): Promise<AuthLease> {
    const prior = this.queue;
    let unlock!: () => void;
    this.queue = new Promise<void>(resolve => { unlock = resolve; });
    await prior;
    try {
      signal?.throwIfAborted();
      const members = this.options.members.filter(p => (this.cooldowns.get(p) ?? 0) <= this.now());
      const selected = await this.options.selector({ members: [...members], timestamp: this.now(), reason: 'auth-use', modelId, getQuota: p => members.includes(p) ? this.quota(p, signal) : Promise.resolve(undefined) });
      signal?.throwIfAborted();
      if (selected !== undefined && !members.includes(selected)) throw new PoolError('INVALID_SELECTION', 'Selector returned an account outside the active pool.');
      // An undefined selection keeps the current account.
      const provider = selected ?? (this.selected && members.includes(this.selected) ? this.selected : undefined);
      if (!provider) throw new PoolError('POOL_UNAVAILABLE', 'No eligible Codex account. Check authentication, quota and cooldowns.');
      const auth = await this.options.resolveAuth(provider, signal);
      signal?.throwIfAborted();
      if (!auth.apiKey || !auth.accountId || auth.provider !== provider) throw new PoolError('INVALID_AUTH', 'Selected account authentication is incomplete.');
      this.selected = provider;
      return Object.freeze({ ...auth, headers: Object.freeze({ ...auth.headers }) });
    } finally { unlock(); }
  }
  markLimited(provider: string, retryAfterMs = 30_000): void {
    if (!this.options.members.includes(provider)) return;
    this.cooldowns.set(provider, this.now() + Math.max(1000, retryAfterMs));
    this.cache.delete(provider);
  }
  /** Metadata-only status: never returns account IDs or OAuth values. */
  status() {
    return { selected: this.selected, members: this.options.members.map(provider => ({ provider, cooldownUntil: this.cooldowns.get(provider), quota: this.cache.get(provider)?.quota })) };
  }
}
