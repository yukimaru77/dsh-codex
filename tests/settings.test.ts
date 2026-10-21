import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands';
import { registerSettings, readTierDefaults, type SettingsContext } from '../src/settings.ts';
import { ServiceTierSettingsHelper, effectiveContextCapacity } from '../src/tier/index.ts';

const model = { provider: 'openai-codex', api: 'openai-codex-responses', id: 'mock' };
const agent = (id: string, parentSession?: string) => ({ session: { id, header: { parentSession } } }) as unknown as Agent;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-settings-test-'));
  const directory = join(root, 'sessions');
  const tierConfigPath = join(root, 'service-tier.json');
  await writeFile(tierConfigPath, JSON.stringify({ 'openai-codex': 'priority' }));
  const commands = new Map<string, CommandDefinition>();
  let created: ((payload: { agent: Agent }) => Promise<unknown>) | undefined;
  const ctx = {
    commands: { register: (definition: CommandDefinition) => { commands.set(definition.name, definition); return () => { commands.delete(definition.name); }; } },
    agents: { list: () => [] },
    on: (_name: string, handler: typeof created) => { created = handler; return () => { created = undefined; }; },
  } as unknown as SettingsContext;
  const tiers = new ServiceTierSettingsHelper();
  const options = { directory, tierConfigPath, modelFor: () => model };
  const cleanup = await registerSettings(ctx, tiers, options);
  async function run(name: string, rawInput = '', receivingAgent = agent('one')) {
    return commands.get(name)!.handler({ agent: receivingAgent, rawInput, signal: new AbortController().signal, attachments: [] } as unknown as CommandInvocation);
  }
  return { root, options, cleanup, tiers, run, commands, created: (value: Agent) => created!({ agent: value }), dispose: async () => { await cleanup(); await rm(root, { recursive: true, force: true }); } };
}

test('real command definition shape, defaults, fast toggle and explicit off survive resume', async () => {
  const f = await fixture();
  try {
    assert.deepEqual([...f.commands.keys()], ['fast', 'service-tier', 'context-window']);
    assert.ok([...f.commands.values()].every(c => c.input?.hint));
    assert.equal(f.tiers.effective()['openai-codex'], 'priority');
    assert.equal((await f.run('fast')).kind, 'success');
    assert.equal(f.tiers.effective('one')['openai-codex'], '');
    const resumedTiers = new ServiceTierSettingsHelper(await readTierDefaults(f.options.tierConfigPath));
    const { SettingsConfiguration } = await import('../src/settings.ts');
    const resumed = new SettingsConfiguration(resumedTiers, f.options);
    assert.deepEqual(await resumed.requestHook('one')({}, model), {});
    assert.equal(resumedTiers.effective('one')['openai-codex'], '');
    await f.run('fast', 'inherit');
    assert.equal(f.tiers.effective('one')['openai-codex'], 'priority');
    assert.equal(await readFile(f.options.tierConfigPath, 'utf8'), '{"openai-codex":"priority"}');
  } finally { await f.dispose(); }
});

test('context cap persists, never enlarges capacity; validation does not change settings', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.cleanup.configuration.capacityFor('one'), undefined);
    assert.equal((await f.run('context-window', '1000000')).kind, 'success');
    const cap = await f.cleanup.configuration.capacityFor('one');
    assert.equal(cap, 1000000);
    assert.equal(effectiveContextCapacity(272000, cap), 272000);
    for (const invalid of ['0', '-1', '1.5', 'NaN', '2k', '9007199254740992', '4 extra']) assert.equal((await f.run('context-window', invalid)).kind, 'error');
    assert.equal(await f.cleanup.configuration.capacityFor('one'), 1000000);
    await f.run('context-window', 'default');
    assert.equal(await f.cleanup.configuration.capacityFor('one'), undefined);
  } finally { await f.dispose(); }
});

test('agent/created restores; child copies parent at first initialization, then diverges', async () => {
  const f = await fixture();
  try {
    await f.run('service-tier', 'flex');
    await f.run('context-window', '1000');
    await f.created(agent('child', 'one'));
    assert.equal(f.tiers.effective('child')['openai-codex'], 'flex');
    assert.equal(await f.cleanup.configuration.capacityFor('child'), 1000);
    await f.run('service-tier', 'off');
    await f.run('context-window', '2000');
    await f.created(agent('child', 'one'));
    assert.equal(f.tiers.effective('child')['openai-codex'], 'flex');
    assert.equal(await f.cleanup.configuration.capacityFor('child'), 1000);
    await f.run('service-tier', 'anthropic standard', agent('child', 'one'));
    assert.equal(f.tiers.effective('child').anthropic, 'standard');
    assert.equal(f.tiers.effective('one').anthropic, undefined);
  } finally { await f.dispose(); }
});

test('concurrent mutations are serialized, load-before-use and payload hook snapshot composition', async () => {
  const f = await fixture();
  try {
    await Promise.all([f.run('service-tier', 'flex'), f.run('context-window', '1234')]);
    assert.equal(f.tiers.effective('one')['openai-codex'], 'flex');
    assert.equal(await f.cleanup.configuration.capacityFor('one'), 1234);
    const hook = f.cleanup.configuration.requestHook('one', async payload => {
      await f.run('fast', 'on');
      return { ...(payload as object), composed: true };
    });
    assert.deepEqual(await hook({}, model), { composed: true, service_tier: 'flex' });
    assert.equal(f.tiers.effective('one')['openai-codex'], 'priority');
    const files = await readdir(f.options.directory);
    assert.ok(files.every(file => /^[a-f0-9]{64}\.json$/.test(file)));
    const parsed = JSON.parse(await readFile(join(f.options.directory, files[0]!), 'utf8')) as { contextWindow: number };
    assert.equal(parsed.contextWindow, 1234);
  } finally { await f.dispose(); }
});

test('bad Pi data fails closed, missing config means upstream empty defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-settings-test-'));
  try {
    const path = join(root, 'service-tier.json');
    assert.deepEqual(await readTierDefaults(path), {});
    await writeFile(path, '{"unknown":"priority"}');
    await assert.rejects(readTierDefaults(path), /Invalid service-tier configuration/);
    await writeFile(path, '{"openai-codex":""}');
    await assert.rejects(readTierDefaults(path));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cold request lineage inherits before agent creation; cycles refuse safely', async () => {
  const f = await fixture();
  try {
    await f.run('service-tier', 'flex');
    await f.run('context-window', '987');
    const { SettingsConfiguration } = await import('../src/settings.ts');
    const tiers = new ServiceTierSettingsHelper(await readTierDefaults(f.options.tierConfigPath));
    const cold = new SettingsConfiguration(tiers, {
      ...f.options,
      lineageFor: id => id === 'cold' ? { parentSession: 'one' } : undefined,
    });
    assert.deepEqual(await cold.requestHook('cold')({}, model), { service_tier: 'flex' });
    assert.equal(await cold.capacityFor('cold'), 987);
    const cyclic = new SettingsConfiguration(tiers, { ...f.options, lineageFor: () => ({ parentSession: 'cycle' }) });
    await assert.rejects(cyclic.ensureLoaded('cycle'), /Cyclic/);
  } finally { await f.dispose(); }
});

test('invalid tier and unsupported model do not commit; independent registrations share serialization', async () => {
  const f = await fixture();
  try {
    for (const invalid of ['standard', 'openai standard', 'bogus priority', 'priority extra extra']) assert.equal((await f.run('service-tier', invalid)).kind, 'error');
    assert.equal((await f.run('fast', 'invalid')).kind, 'error');
    const { SettingsConfiguration } = await import('../src/settings.ts');
    const other = new SettingsConfiguration(new ServiceTierSettingsHelper(), { ...f.options, modelFor: () => ({ provider: 'unsupported' }) });
    const invocation = { agent: agent('one'), rawInput: '', signal: new AbortController().signal } as unknown as CommandInvocation;
    assert.equal((await other.command('fast', invocation)).kind, 'error');
    await Promise.all([
      f.run('service-tier', 'flex'),
      other.command('context-window', { ...invocation, rawInput: '333' }),
    ]);
    await f.cleanup.configuration.ensureLoaded('one');
    assert.equal(f.tiers.effective('one')['openai-codex'], 'flex');
    assert.equal(await f.cleanup.configuration.capacityFor('one'), 333);
  } finally { await f.dispose(); }
});

test('malformed persisted data refuses requests; cleanup removes commands and listener', async () => {
  const f = await fixture();
  try {
    await f.run('context-window', '10');
    const files = await readdir(f.options.directory);
    await writeFile(join(f.options.directory, files[0]!), '{"version":2}');
    await assert.rejects(f.cleanup.configuration.capacityFor('one'));
    await assert.rejects(f.cleanup.configuration.requestHook('one')({}, model));
    assert.equal((await f.run('fast', 'on')).kind, 'error');
    await f.cleanup();
    assert.equal(f.commands.size, 0);
  } finally { await f.dispose(); }
});
