import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { Api, Model, MutableModels } from '@earendil-works/pi-ai';
import { CodexPool, PoolError, quotaFromUsage, weeklyResetSelector, type AuthLease, type Operation, type Selector } from './pool.ts';
import { accountId, openPiBackend, PiAccountStore, type LockedBackend } from './pi-store.ts';

export interface BrokerConfig {
  authPath: string;
  poolConfigPath: string;
  poolName?: string;
  usageBaseURL?: string;
  cacheMs?: number;
}
interface PoolConfig {
  standardLogin?: boolean;
  pools?: Array<{ name: string; baseProvider: string; members: string[]; enabled?: boolean; strategy: string; selectionTiming?: string; selectorScript?: string }>;
}
type BrokerOverrides = { backend?: LockedBackend; fetch?: typeof fetch };
export class AuthBroker {
  readonly catalog = builtinModels();
  #pool?: CodexPool;
  #pending?: Promise<CodexPool>;
  private constructor(pool: CodexPool | undefined, private readonly load?: () => Promise<CodexPool>) { this.#pool = pool; }
  /** Open the Pi pool now; any missing or invalid Pi setup rejects. */
  static async create(config: BrokerConfig, overrides: BrokerOverrides = {}): Promise<AuthBroker> {
    return new AuthBroker(await openPool(config, overrides));
  }
  /**
   * Open the Pi pool on first authenticated use. A missing Pi login fails that request
   * (and is retried by the next one) instead of the plugin, so signing in through Pi
   * later needs no DSH restart or reconfiguration.
   */
  static deferred(config: BrokerConfig, overrides: BrokerOverrides = {}): AuthBroker {
    return new AuthBroker(undefined, () => openPool(config, overrides));
  }
  /** The opened pool; only valid after an `acquire` succeeded. */
  get pool(): CodexPool {
    if (!this.#pool) throw new PoolError('POOL_NOT_OPEN', 'Pi Codex pool has not been opened yet.');
    return this.#pool;
  }
  private ready(): Promise<CodexPool> {
    if (this.#pool) return Promise.resolve(this.#pool);
    this.#pending ??= this.load!().then(pool => (this.#pool = pool), error => { this.#pending = undefined; throw error; });
    return this.#pending;
  }
  /** Metadata-only status; before the pool opens it reports that Pi authentication is still pending. */
  status() {
    return this.#pool ? { opened: true, ...this.#pool.status() } : { opened: false, note: 'Opened on first Codex request; sign in through Pi if it fails.' };
  }
  async acquire(operation: Operation, modelId = '', signal?: AbortSignal): Promise<AuthLease> {
    return (await this.ready()).acquire(operation, modelId, signal);
  }
  /** One facade per tool invocation: multiple auth reads inside it reuse the same immutable lease. */
  registryFor(operation: Operation, signal?: AbortSignal) {
    let pending: Promise<AuthLease> | undefined;
    const lease = (modelId = '') => pending ??= this.acquire(operation, modelId, signal);
    const codex = (provider: string) => { if (provider !== 'openai-codex') throw new PoolError('UNSUPPORTED_PROVIDER', 'Codex helper authentication is restricted to openai-codex.'); };
    return {
      find: (provider: string, id: string) => this.catalog.getModel(provider, id),
      getAll: () => [...this.catalog.getModels('openai-codex')],
      getAvailable: () => [...this.catalog.getModels('openai-codex')],
      getProvider: (provider: string) => this.catalog.getProvider(provider),
      getProviderAuthStatus: (provider: string) => ({ configured: provider === 'openai-codex' }),
      hasConfiguredAuth: (model: Model<Api>) => model.provider === 'openai-codex',
      isUsingOAuth: (model: Model<Api>) => model.provider === 'openai-codex',
      getApiKeyAndHeaders: async (model: Model<Api>) => { codex(model.provider); const a = await lease(model.id); return { ok: true as const, apiKey: a.apiKey, headers: a.headers, baseUrl: model.baseUrl }; },
      getApiKeyForProvider: async (provider: string) => { codex(provider); return (await lease()).apiKey; },
      getProviderAuth: async (provider: string) => { codex(provider); const a = await lease(); return { auth: { apiKey: a.apiKey, headers: a.headers }, source: 'OAuth' }; },
    };
  }
}

async function openPool(config: BrokerConfig, overrides: BrokerOverrides): Promise<CodexPool> {
  const text = await readFile(config.poolConfigPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new PoolError('NO_POOL_CONFIG', `Pi pool configuration ${config.poolConfigPath} is missing. Sign in to Codex through Pi first.`);
    throw error;
  });
  const parsed = JSON.parse(text) as PoolConfig;
  const pools = parsed.pools?.filter(p => p.enabled && p.baseProvider === 'openai-codex' && p.strategy === 'custom' && p.selectionTiming === 'auth-use') ?? [];
  const pool = config.poolName ? pools.find(p => p.name === config.poolName) : pools[0];
  if (!parsed.standardLogin || !pool) throw new PoolError('UNSUPPORTED_POOL_CONFIG', 'Expected Pi standardLogin with an enabled custom auth-use Codex pool.');
  const backend = overrides.backend ?? await openPiBackend(config.authPath);
  let selector: Selector = weeklyResetSelector;
  if (pool.selectorScript) {
    const filename = resolve(dirname(config.poolConfigPath), pool.selectorScript);
    // This is the existing trusted user-level Pi selector; never load a project-supplied selector.
    const loaded = await import(pathToFileURL(filename).href);
    if (typeof loaded.default !== 'function') throw new PoolError('INVALID_SELECTOR', 'Pi selector must export a default function.');
    selector = loaded.default;
  }
  const collections = new Map<string, { models: MutableModels; store: PiAccountStore }>();
  for (const member of pool.members) {
    const store = new PiAccountStore(backend, member, pool.members);
    collections.set(member, { models: builtinModels({ credentials: store, authContext: { env: async () => undefined, fileExists: async () => false } }), store });
  }
  const resolveAuth = async (provider: string, signal?: AbortSignal): Promise<AuthLease> => {
    const entry = collections.get(provider);
    if (!entry) throw new PoolError('INVALID_MEMBER', 'Unknown Codex pool member.');
    try {
      const resolved = await entry.models.getAuth('openai-codex', { signal });
      signal?.throwIfAborted();
      const credential = await entry.store.read('openai-codex', { signal });
      const id = accountId(credential);
      const apiKey = resolved?.auth.apiKey;
      if (!id || !apiKey) throw new PoolError('MISSING_AUTH', 'Named Codex account needs authentication through Pi.');
      const headers: Record<string, string> = { 'chatgpt-account-id': id };
      for (const [key, value] of Object.entries(resolved.auth.headers ?? {})) if (typeof value === 'string') headers[key] = value;
      return { provider, apiKey, accountId: id, headers };
    } catch (error) {
      if (signal?.aborted || error instanceof PoolError) throw error;
      // Do not expose provider error payloads or credentials in DSH logs.
      throw new PoolError('AUTH_FAILED', `Pi Codex credential resolution failed for ${provider}. Reauthenticate in Pi.`);
    }
  };
  const initialAccount = await backend.withLockAsync(async raw => {
    if (!raw) return { result: undefined };
    const data = JSON.parse(raw);
    const id = accountId(data['openai-codex']);
    return { result: id ? pool.members.find(m => accountId(data[m]) === id) : undefined };
  });
  const request = overrides.fetch ?? fetch;
  const usage = new URL((config.usageBaseURL ?? 'https://chatgpt.com/backend-api').replace(/\/$/, '') + '/wham/usage');
  if (usage.protocol !== 'https:' || usage.hostname !== 'chatgpt.com') throw new PoolError('UNTRUSTED_USAGE_ENDPOINT', 'Shared ChatGPT credentials may only be sent to https://chatgpt.com.');
  return new CodexPool({ members: pool.members, selector, initialAccount, cacheMs: config.cacheMs ?? 30_000, resolveAuth,
    getQuota: async (provider, signal) => {
      const lease = await resolveAuth(provider, signal);
      const timeout = AbortSignal.timeout(10_000);
      const response = await request(usage, { headers: { Authorization: `Bearer ${lease.apiKey}`, ...lease.headers }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); return { provider, kind: response.status === 401 ? 'missing-auth' : 'error' }; }
      return quotaFromUsage(provider, await response.json());
    },
  });
}
