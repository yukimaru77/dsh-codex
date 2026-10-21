import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AuthBroker } from './auth/broker.ts';
import { PooledCodexAdapter } from './provider.ts';
import { ServiceTierSettingsHelper } from './tier/index.ts';
import { checkpointTexts } from './compact/checkpoint.ts';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-authorization';
import { registerLoginFlows, startDeviceLogin } from './auth/login.ts';
import { DshAccountStore } from './auth/store.ts';
import { registerSettings, type SettingsConfiguration } from './settings.ts';

declare module '@deepseek-ai/cordis' { interface Context { codexPool: CodexPoolService } }
export interface Config {
  accounts?: string[];
  selectorScript?: string;
  contextWindow?: number;
  reasoning?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  nativeCompaction?: boolean;
  settingsDirectory?: string;
  tierConfigPath?: string;
}
/** One owner of the Codex account pool; logins live in the DSH credential store. */
export class CodexPoolService extends Service<Config> {
  static inject = ['llm', 'commands', 'agents', 'authorization'];
  static Config: z<Config> = z.object({
    accounts: z.array(z.string()).default(['codex-1', 'codex-2', 'codex-3']),
    selectorScript: z.string(),
    contextWindow: z.number().min(1),
    reasoning: z.union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
    nativeCompaction: z.boolean().default(true),
    settingsDirectory: z.string(),
    tierConfigPath: z.string(),
  }) as z<Config>;
  broker!: AuthBroker;
  adapter!: PooledCodexAdapter;
  settings!: SettingsConfiguration;
  readonly tiers = new ServiceTierSettingsHelper({});
  private readonly assembledRoutes = new WeakMap<Agent, Partial<LlmCallConfig>>();
  routeFor(agent: Agent): Partial<LlmCallConfig> {
    return this.assembledRoutes.get(agent) ?? agent.session.requestHeader()?.config ?? agent.options;
  }
  constructor(ctx: Context, private readonly options: Config) { super(ctx, 'codexPool'); }
  async [Service.init]() {
    const accounts = this.options.accounts ?? ['codex-1', 'codex-2', 'codex-3'];
    this.broker = AuthBroker.deferred({ accounts, credentials: () => this.ctx.get('credentials'), selectorScript: this.options.selectorScript });
    const disposeLogins = registerLoginFlows(this.ctx, accounts);
    this.ctx.effect(() => disposeLogins);
    this.adapter = new PooledCodexAdapter(this.ctx, this.broker, this.tiers, { ...this.options,
      capacityFor: id => this.settings.capacityFor(id), beforeRequest: id => this.settings.ensureLoaded(id),
      routeFor: agent => this.routeFor(agent),
    });
    const cleanup = await registerSettings(this.ctx, this.tiers, {
      directory: this.options.settingsDirectory ?? join(dshHome(), 'codex-pool', 'session-settings'),
      tierConfigPath: this.options.tierConfigPath ?? join(dshHome(), 'codex-pool', 'service-tier.json'),
      activeProviders: ['openai-codex'],
      modelFor: agent => {
        const route = agent.session.requestHeader()?.config ?? agent.options;
        if (route.provider === 'openai-codex' && route.model) return this.adapter.model(route.model);
        throw new Error('Service-tier injection in this bundle is currently available for openai-codex.');
      },
    });
    this.settings = cleanup.configuration;
    this.ctx.effect(() => cleanup);
    // A conflicting existing route fails explicitly; never steal a live registration.
    this.ctx.llm.registerAdapter(['openai-codex'], this.adapter);
    this.ctx.effect(() => this.ctx.commands.register({ name: 'codex-pool', description: 'Codex account pool status (cached quota; no network request)',
      handler: async () => {
        const signedIn = await Promise.all(accounts.map(async account => [account, (await new DshAccountStore(() => this.ctx.get('credentials'), account).read('openai-codex')) !== undefined] as const));
        return { kind: 'success', text: JSON.stringify({ ...this.broker.status(), signedIn: Object.fromEntries(signedIn), nativeCompaction: this.nativeCompaction, signIn: '/codex-login <account>' }, null, 2) };
      },
    }));
    this.ctx.effect(() => this.ctx.commands.register({ name: 'codex-login', description: 'Sign a Codex pool account in with a ChatGPT device code',
      input: { hint: `<${accounts.join('|')}>` },
      handler: invocation => startDeviceLogin(this.ctx, accounts, invocation.rawInput.trim(), message => this.ctx.logger.info(message)),
    }));
    this.ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
      const assembled = await next();
      if (agent && assembled.variables.provider && assembled.variables.model) {
        const previous = agent.session.requestHeader()?.config ?? agent.options;
        const same = previous.provider === assembled.variables.provider && previous.model === assembled.variables.model;
        this.assembledRoutes.set(agent, { ...(same ? previous : {}), provider: assembled.variables.provider, model: assembled.variables.model });
      }
      return assembled;
    }, { prepend: true });
    // Final immutable-input guard also covers direct LLM calls / later routing
    // middleware. Validation only: never rewrite DSH's frozen model-visible log.
    this.ctx.on('llm/stream', (options, next) => {
      if (checkpointTexts(options.messages).length) {
        throw new Error('Opaque checkpoint cannot be sent to this model; portable conversion is required.');
      }
      return next();
    });
    this.ctx.on('agent/request', async ({ agent }, next) => {
      const config = await next();
      if (checkpointTexts(agent.session.deriveMessages()).length) {
        throw new Error('Checkpoint conversion has not completed for this model. Request stopped; original history preserved.');
      }
      return config;
    }, { prepend: true });
  }
  get nativeCompaction() { return this.options.nativeCompaction !== false; }
}
export default CodexPoolService;
function dshHome(): string { return process.env.DSH_HOME || join(homedir(), '.dsh'); }
