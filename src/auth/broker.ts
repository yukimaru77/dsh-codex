import { pathToFileURL } from 'node:url';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { Api, Model, MutableModels } from '@earendil-works/pi-ai';
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials';
import { CodexPool, PoolError, quotaFromUsage, weeklyResetSelector, type AuthLease, type Operation, type Selector } from './pool.ts';
import { accountId, DshAccountStore } from './store.ts';

export interface BrokerConfig {
  /** Pool members: each is a `codex-pool/<account>` login in the DSH credential store. */
  accounts: readonly string[];
  credentials: () => CredentialProvider | undefined;
  /** Optional trusted user-level selector module (absolute path); defaults to the weekly-reset policy. */
  selectorScript?: string;
  usageBaseURL?: string;
  cacheMs?: number;
}
type BrokerOverrides = { fetch?: typeof fetch };
export class AuthBroker {
  readonly catalog = builtinModels();
  #pool?: CodexPool;
  #pending?: Promise<CodexPool>;
  private constructor(pool: CodexPool | undefined, private readonly load?: () => Promise<CodexPool>) { this.#pool = pool; }
  /** Open the pool now; an invalid pool configuration rejects. */
  static async create(config: BrokerConfig, overrides: BrokerOverrides = {}): Promise<AuthBroker> {
    return new AuthBroker(await openPool(config, overrides));
  }
  /**
   * Open the pool on first authenticated use. A failure fails that request (and is
   * retried by the next one) instead of the plugin; signing an account in later
   * needs no DSH restart, because each request reads the stored logins again.
   */
  static deferred(config: BrokerConfig, overrides: BrokerOverrides = {}): AuthBroker {
    return new AuthBroker(undefined, () => openPool(config, overrides));
  }
  /** The opened pool; only valid after an `acquire` succeeded. */
  get pool(): CodexPool {
    if (!this.#pool) throw new PoolError('POOL_NOT_OPEN', 'Codex pool has not been opened yet.');
    return this.#pool;
  }
  private ready(): Promise<CodexPool> {
    if (this.#pool) return Promise.resolve(this.#pool);
    this.#pending ??= this.load!().then(pool => (this.#pool = pool), error => { this.#pending = undefined; throw error; });
    return this.#pending;
  }
  /** Metadata-only status; never returns account IDs or OAuth values. */
  status() {
    return this.#pool ? { opened: true, ...this.#pool.status() } : { opened: false, note: 'Opened on first Codex request.' };
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
  let selector: Selector = weeklyResetSelector;
  if (config.selectorScript) {
    // A trusted user-level profile setting; never load a project-supplied selector.
    const loaded = await import(pathToFileURL(config.selectorScript).href);
    if (typeof loaded.default !== 'function') throw new PoolError('INVALID_SELECTOR', 'Codex selector must export a default function.');
    selector = loaded.default;
  }
  const collections = new Map<string, { models: MutableModels; store: DshAccountStore }>();
  for (const account of config.accounts) {
    const store = new DshAccountStore(config.credentials, account);
    collections.set(account, { models: builtinModels({ credentials: store, authContext: { env: async () => undefined, fileExists: async () => false } }), store });
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
      if (!id || !apiKey) throw new PoolError('MISSING_AUTH', `Codex account "${provider}" is not signed in. Sign it in from DSH settings or /auth.`);
      const headers: Record<string, string> = { 'chatgpt-account-id': id };
      for (const [key, value] of Object.entries(resolved.auth.headers ?? {})) if (typeof value === 'string') headers[key] = value;
      return { provider, apiKey, accountId: id, headers };
    } catch (error) {
      if (signal?.aborted || error instanceof PoolError) throw error;
      // Do not expose provider error payloads or credentials in DSH logs.
      throw new PoolError('AUTH_FAILED', `Codex credential resolution failed for "${provider}". Sign it in again.`);
    }
  };
  const request = overrides.fetch ?? fetch;
  const usage = new URL((config.usageBaseURL ?? 'https://chatgpt.com/backend-api').replace(/\/$/, '') + '/wham/usage');
  if (usage.protocol !== 'https:' || usage.hostname !== 'chatgpt.com') throw new PoolError('UNTRUSTED_USAGE_ENDPOINT', 'ChatGPT credentials may only be sent to https://chatgpt.com.');
  return new CodexPool({ members: config.accounts, selector, cacheMs: config.cacheMs ?? 30_000, resolveAuth,
    getQuota: async (provider, signal) => {
      const lease = await resolveAuth(provider, signal);
      const timeout = AbortSignal.timeout(10_000);
      const response = await request(usage, { headers: { Authorization: `Bearer ${lease.apiKey}`, ...lease.headers }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); return { provider, kind: response.status === 401 ? 'missing-auth' : 'error' }; }
      return quotaFromUsage(provider, await response.json());
    },
  });
}
