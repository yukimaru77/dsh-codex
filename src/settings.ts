/** DSH commands + external session policy storage. Never appends private events. */
import { open, readFile, mkdir, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands';
import {
  ServiceTierSettingsHelper, parseTierSettings, isRecord,
  getServiceTierProviderForModel, isServiceTierProvider, SERVICE_TIER_PROVIDER_DEFINITIONS,
  type ServiceTierModel, type TierSessionState,
} from './tier/index.ts';

export const defaultTierPath = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'codex-pool', 'service-tier.json');
/** Read only the dedicated service-tier defaults file. Invalid data fails closed, never writes. */
export async function readTierDefaults(path = defaultTierPath()) {
  try { return parseTierSettings(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if (isMissing(error)) return {}; throw new Error(`Invalid service-tier configuration: ${path}`, { cause: error }); }
}
function isMissing(error: unknown): boolean { return isRecord(error) && error.code === 'ENOENT'; }
interface StoredSettings { version: 1; sessionId: string; tier: TierSessionState; contextWindow: number | null }
export interface SessionLineage { parentSession?: string }
export interface SettingsOptions {
  /** Dedicated plugin directory, NOT a DSH config or session log. */
  directory: string;
  tierConfigPath?: string;
  /** Deployment-supported request hooks; omit for the standalone all-provider helper. */
  activeProviders?: readonly string[];
  /** Required for /fast and implicit-provider /service-tier; resolve the actual API too. */
  modelFor(agent: Agent): ServiceTierModel | Promise<ServiceTierModel>;
  /** Resolve durable lineage for cold sessions when request loading precedes agent/created. */
  lineageFor?(sessionId: string): SessionLineage | undefined | Promise<SessionLineage | undefined>;
}
const queues = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
function parseStored(value: unknown, sessionId: string): StoredSettings {
  if (!isRecord(value) || value.version !== 1 || value.sessionId !== sessionId || !isRecord(value.tier) || value.tier.version !== 1) throw new Error('Invalid session settings');
  const cap = value.contextWindow;
  if (cap !== null && (typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap <= 0)) throw new Error('Invalid context window cap');
  return { version: 1, sessionId, tier: { version: 1, overrides: parseTierSettings(value.tier.overrides, true) }, contextWindow: cap };
}

export class SettingsConfiguration {
  private readonly lineage = new Map<string, SessionLineage>();
  constructor(readonly tiers: ServiceTierSettingsHelper, readonly options: SettingsOptions) {}
  noteAgent(agent: Agent): void {
    const parentSession = agent.session.header.parentSession;
    this.lineage.set(String(agent.session.id), parentSession === undefined ? {} : { parentSession: String(parentSession) });
  }
  private path(id: string): string {
    if (!id) throw new Error('Session id is required');
    return join(resolve(this.options.directory), `${createHash('sha256').update(id).digest('hex')}.json`);
  }
  private async read(id: string): Promise<StoredSettings | undefined> {
    try { return parseStored(JSON.parse(await readFile(this.path(id), 'utf8')), id); }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
  }
  private async write(state: StoredSettings): Promise<void> {
    const path = this.path(state.sessionId);
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify(state)}\n`); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, path);
      const directory = await open(resolve(this.options.directory), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temp).catch(error => { if (!isMissing(error)) throw error; }); }
  }
  private async transaction<T>(id: string, operation: (state: StoredSettings) => Promise<T>, seen = new Set<string>()): Promise<T> {
    if (seen.has(id)) throw new Error('Cyclic settings lineage');
    const nextSeen = new Set(seen).add(id);
    // Initialize an ancestor before taking the child lock: never nest child -> parent locks.
    let inherited: StoredSettings | undefined;
    if (!await this.read(id)) {
      const lineage = this.lineage.get(id) ?? await this.options.lineageFor?.(id);
      if (lineage?.parentSession) inherited = await this.transaction(lineage.parentSession, async state => structuredClone(state), nextSeen);
    }
    const path = this.path(id);
    return serialized(path, async () => {
      await mkdir(resolve(this.options.directory), { recursive: true, mode: 0o700 });
      // Cross-process exclusion; no unsafe stale-lock stealing. An orphan lock needs manual removal.
      const lockPath = `${path}.lock`;
      const deadline = Date.now() + 5000;
      let lock;
      for (;;) {
        try { lock = await open(lockPath, 'wx', 0o600); break; }
        catch (error) {
          if (!isRecord(error) || error.code !== 'EEXIST' || Date.now() >= deadline) throw error;
          await delay(20);
        }
      }
      try {
        let state = await this.read(id);
        if (!state) {
          state = { version: 1, sessionId: id, tier: inherited?.tier ?? { version: 1, overrides: {} }, contextWindow: inherited?.contextWindow ?? null };
          await this.write(state);
        }
        return await operation(state);
      } finally { await lock.close(); await unlink(lockPath); }
    });
  }
  /** Load before every request (including resumed/cold sessions); also called by agent/created. */
  async ensureLoaded(sessionId: string): Promise<void> {
    await this.transaction(sessionId, async state => { this.tiers.restore(sessionId, state.tier); });
  }
  /** Policy cap only. Caller MUST use min(real model capacity, cap ?? real capacity). */
  async capacityFor(sessionId: string): Promise<number | undefined> {
    return this.transaction(sessionId, async state => { this.tiers.restore(sessionId, state.tier); return state.contextWindow ?? undefined; });
  }
  /** Safe payload hook: settings restore happens before the tier helper is consulted. */
  requestHook(sessionId: string, previous?: (payload: unknown, model: ServiceTierModel) => unknown | Promise<unknown>) {
    return async (payload: unknown, model: ServiceTierModel): Promise<unknown> => {
      // Keep the effective snapshot isolated from concurrent commands during previous's await.
      const effective = await this.transaction(sessionId, async state => {
        this.tiers.restore(sessionId, state.tier);
        return this.tiers.effective(sessionId);
      });
      const isolated = new ServiceTierSettingsHelper();
      isolated.restore(sessionId, { version: 1, overrides: effective });
      return isolated.requestHook(sessionId, previous)(payload, model);
    };
  }
  async command(name: string, invocation: CommandInvocation): Promise<CommandResult> {
    const id = String(invocation.agent.session.id);
    this.noteAgent(invocation.agent);
    const words = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
    const usage = name === 'fast' ? '/fast [on|off|inherit]' : name === 'service-tier' ? '/service-tier [provider] [off|inherit|flex|priority|standard]' : '/context-window [positive-token-count|default]';
    try {
      if (invocation.signal.aborted) return { kind: 'error', text: 'Settings command cancelled.' };
      // Resolve outside the storage lock; no asynchronous model lookup inside a commit.
      const model = name === 'context-window' || name === 'service-tier' && words.length === 2 ? undefined : await this.options.modelFor(invocation.agent);
      return await this.transaction(id, async state => {
        if (invocation.signal.aborted) return { kind: 'error', text: 'Settings command cancelled.' };
        const helper = new ServiceTierSettingsHelper();
        // Preserve global defaults including explicit-off session semantics.
        helper.setDefaults(this.tiers.effective());
        helper.restore(id, state.tier);
        if (name === 'context-window') {
          if (words.length > 1) throw new Error(usage);
          if (words.length) {
            if (words[0] === 'default') state.contextWindow = null;
            else if (/^[1-9]\d*$/.test(words[0]) && Number.isSafeInteger(Number(words[0]))) state.contextWindow = Number(words[0]);
            else throw new Error(usage);
          }
        } else if (name === 'fast') {
          if (words.length > 1 || words.length === 1 && !['on', 'off', 'inherit'].includes(words[0]!)) throw new Error(usage);
          const provider = getServiceTierProviderForModel(model);
          if (!provider) throw new Error('Current model does not support service tiers.');
          if (!words.length) helper.toggleFast(id, model!);
          else helper.setOverride(id, provider, words[0] === 'inherit' ? undefined : words[0] === 'off' ? '' : SERVICE_TIER_PROVIDER_DEFINITIONS[provider].fastTier!);
          state.tier = helper.snapshot(id);
        } else {
          if (words.length > 2) throw new Error(usage);
          const provider = words.length === 2 ? words[0] : getServiceTierProviderForModel(model);
          if (words.length) {
            if (!isServiceTierProvider(provider) || this.options.activeProviders && !this.options.activeProviders.includes(provider)) throw new Error('Select a provider supported by this deployment.');
            const selection = words.at(-1)!;
            if (selection === 'inherit') helper.setOverride(id, provider, undefined);
            else {
              const validated = parseTierSettings({ [provider]: selection === 'off' ? '' : selection }, true);
              helper.setOverride(id, provider, validated[provider]);
            }
            state.tier = helper.snapshot(id);
          }
        }
        // Save first: a failed write must not publish uncommitted in-memory overrides.
        if (name === 'fast' || words.length) await this.write(state);
        this.tiers.restore(id, state.tier);
        return { kind: 'success', text: name === 'context-window' ? `Context policy cap: ${state.contextWindow ?? 'model default'} tokens (never exceeds real model capacity).` : `Service tiers: ${JSON.stringify(helper.effective(id))}` };
      });
    } catch {
      // Do not expose arbitrary JSON contents, paths, model resolver errors, or secrets.
      return { kind: 'error', text: `Settings not changed or unavailable. Usage: ${usage}` };
    }
  }
}

export type SettingsContext = Pick<Context, 'on'> & { commands: Pick<Context['commands'], 'register'>; agents: Pick<Context['agents'], 'list'> };
export type SettingsCleanup = (() => Promise<void>) & { configuration: SettingsConfiguration };
/** Install before agents start; await completion. Cleanup unregisters and drains owned work. */
export async function registerSettings(ctx: SettingsContext, tiers: ServiceTierSettingsHelper, options: SettingsOptions): Promise<SettingsCleanup> {
  tiers.setDefaults(await readTierDefaults(options.tierConfigPath));
  const configuration = new SettingsConfiguration(tiers, options);
  const disposers: (() => void)[] = [];
  const active = new Set<Promise<unknown>>();
  let closed = false;
  const track = <T>(operation: Promise<T>): Promise<T> => {
    active.add(operation);
    void operation.then(() => active.delete(operation), () => active.delete(operation));
    return operation;
  };
  const cleanup = Object.assign(async () => {
    if (closed) return;
    closed = true;
    for (const dispose of disposers.reverse()) dispose();
    await Promise.allSettled([...active]);
  }, { configuration });
  try {
    disposers.push(ctx.on('agent/created', async ({ agent }) => {
      configuration.noteAgent(agent);
      await track(configuration.ensureLoaded(String(agent.session.id)));
      return undefined;
    }));
    for (const agent of ctx.agents.list()) {
      configuration.noteAgent(agent);
      await configuration.ensureLoaded(String(agent.session.id));
    }
    for (const name of ['fast', 'service-tier', 'context-window']) {
      const definition: CommandDefinition = {
        name, description: `Session ${name} settings`, input: { hint: name === 'context-window' ? '[tokens|default]' : '[selection]' },
        handler: invocation => closed ? { kind: 'error', text: 'Settings disposed.' } : track(configuration.command(name, invocation)),
      };
      disposers.push(ctx.commands.register(definition));
    }
    return cleanup;
  } catch (error) { await cleanup(); throw error; }
}
