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
export class AuthBroker {
  readonly catalog = builtinModels();
  private constructor(readonly pool: CodexPool) {}
  static async create(config: BrokerConfig, overrides: { backend?: LockedBackend; fetch?: typeof fetch } = {}): Promise<AuthBroker> {
    const parsed = JSON.parse(await readFile(config.poolConfigPath, 'utf8')) as PoolConfig;
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
    return new AuthBroker(new CodexPool({ members: pool.members, selector, initialAccount, cacheMs: config.cacheMs ?? 30_000, resolveAuth,
      getQuota: async (provider, signal) => {
        const lease = await resolveAuth(provider, signal);
        const timeout = AbortSignal.timeout(10_000);
        const response = await request(usage, { headers: { Authorization: `Bearer ${lease.apiKey}`, ...lease.headers }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
        if (!response.ok) { await response.body?.cancel(); return { provider, kind: response.status === 401 ? 'missing-auth' : 'error' }; }
        return quotaFromUsage(provider, await response.json());
      },
    }));
  }
  acquire(operation: Operation, modelId = '', signal?: AbortSignal) { return this.pool.acquire(operation, modelId, signal); }
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
