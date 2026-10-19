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
import { registerSettings, type SettingsConfiguration } from './settings.ts';

declare module '@deepseek-ai/cordis' { interface Context { piCompat: PiCompatService } }
export interface Config {
  authPath?: string;
  poolConfigPath?: string;
  poolName?: string;
  contextWindow?: number;
  reasoning?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  nativeCompaction?: boolean;
  settingsDirectory?: string;
  piTierConfigPath?: string;
}
/** One owner of the shared auth broker; no Pi agent loop or second credential store. */
export class PiCompatService extends Service<Config> {
  static inject = ['llm', 'commands', 'agents'];
  static Config: z<Config> = z.object({
    authPath: z.string().default(join(homedir(), '.pi/agent/auth.json')),
    poolConfigPath: z.string().default(join(homedir(), '.pi/agent/multi-pass.json')),
    poolName: z.string(),
    contextWindow: z.number().min(1),
    reasoning: z.union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
    nativeCompaction: z.boolean().default(true),
    settingsDirectory: z.string(),
    piTierConfigPath: z.string(),
  }) as z<Config>;
  broker!: AuthBroker;
  adapter!: PooledCodexAdapter;
  settings!: SettingsConfiguration;
  readonly tiers = new ServiceTierSettingsHelper({});
  private readonly assembledRoutes = new WeakMap<Agent, Partial<LlmCallConfig>>();
  routeFor(agent: Agent): Partial<LlmCallConfig> {
    return this.assembledRoutes.get(agent) ?? agent.session.requestHeader()?.config ?? agent.options;
  }
  constructor(ctx: Context, private readonly options: Config) { super(ctx, 'piCompat'); }
  async [Service.init]() {
    this.broker = AuthBroker.deferred({
      authPath: this.options.authPath ?? join(homedir(), '.pi/agent/auth.json'),
      poolConfigPath: this.options.poolConfigPath ?? join(homedir(), '.pi/agent/multi-pass.json'),
      poolName: this.options.poolName,
    });
    this.adapter = new PooledCodexAdapter(this.ctx, this.broker, this.tiers, { ...this.options,
      capacityFor: id => this.settings.capacityFor(id), beforeRequest: id => this.settings.ensureLoaded(id),
      routeFor: agent => this.routeFor(agent),
    });
    const cleanup = await registerSettings(this.ctx, this.tiers, {
      directory: this.options.settingsDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'pi-compat', 'session-settings'),
      piConfigPath: this.options.piTierConfigPath,
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
    this.ctx.effect(() => this.ctx.commands.register({ name: 'codex-pool', description: 'Shared Pi Codex pool status (cached; no network request)',
      handler: () => ({ kind: 'success', text: JSON.stringify({ ...this.broker.status(), nativeCompaction: this.nativeCompaction, authentication: 'Managed by Pi; no separate DSH login' }, null, 2) }),
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
export default PiCompatService;
