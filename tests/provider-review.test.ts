import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createUserMessage, createSystemMessage, LlmRuntime } from '@deepseek-ai/dsh-llm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiCompatService } from '../src/service.ts';
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction';
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { AuthBroker } from '../src/auth/broker.ts';
import { CodexPool } from '../src/auth/pool.ts';
import { PooledCodexAdapter } from '../src/provider.ts';
import { ServiceTierSettingsHelper } from '../src/tier/index.ts';
import { encodeCheckpoint, restoreCheckpointPayload } from '../src/compact/checkpoint.ts';
import { PiAccountStore, type LockedBackend } from '../src/auth/pi-store.ts';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { createProvider } from '@earendil-works/pi-ai';

// All credentials are invented. Never call AuthBroker.create or openPiBackend here.
function fixture() {
  let auth = 0;
  const pool = new CodexPool({ members: ['openai-codex-1'],
    selector: async () => { auth++; throw new Error('No auth during metadata/serialization'); },
    getQuota: async () => { throw new Error('No quota network'); },
    resolveAuth: async () => { throw new Error('No credentials'); },
  });
  const Broker = AuthBroker as unknown as new (pool: CodexPool) => AuthBroker;
  const broker = new Broker(pool);
  const tiers = new ServiceTierSettingsHelper({ 'openai-codex': 'priority' });
  const adapter = new PooledCodexAdapter(new Context(), broker, tiers, { contextWindow: 64_000, reasoning: 'high' });
  const model = broker.catalog.getModels('openai-codex').find(m => m.id === 'gpt-5.4')
    ?? broker.catalog.getModels('openai-codex')[0];
  assert.ok(model, 'installed catalog contains Codex models');
  const agent = { options: { provider: 'other', model: 'not-used' }, session: {
    id: 'synthetic-provider-review',
    requestHeader: () => ({ config: { provider: 'openai-codex', model: model.id, reasoningEffort: 'high' } }),
    toolHistory: () => [],
  } } as unknown as Agent;
  return { broker, adapter, tiers, model, agent, authCount: () => auth };
}
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const input = () => ({ messages: [
  createSystemMessage('Synthetic system prefix.'),
  user('Synthetic question.'),
], tools: [{ name: 'fixture_tool', description: 'Synthetic tool', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] });

test('provider review: discovery and resolved metadata are real catalog data without auth/network', async t => {
  const f = fixture();
  let network = 0;
  t.mock.method(globalThis, 'fetch', async () => { network++; throw new Error('Forbidden network'); });
  const listed = await f.adapter.listModels('openai-codex');
  assert.deepEqual(listed.map(m => m.id).sort(), f.broker.catalog.getModels('openai-codex').map(m => m.id).sort());
  const meta = await f.adapter.resolveModel('openai-codex', f.model.id);
  assert.equal(meta.id, f.model.id);
  assert.equal(meta.name, f.model.name);
  assert.deepEqual(meta.inputModalities, f.model.input);
  assert.equal(meta.context?.contextWindow, Math.min(f.model.contextWindow, 64_000));
  if (f.model.reasoning) assert.ok(meta.reasoning?.efforts.some(e => e.id === 'high'));
  assert.equal((await f.adapter.prepareCall('openai-codex', f.model.id)).model.id, f.model.id);
  await assert.rejects(f.adapter.resolveModel('openai-codex', 'synthetic-unknown-model'), { code: 'UNKNOWN_MODEL' });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.adapter.resolveModel('openai-codex', f.model.id, abort.signal), { name: 'AbortError' });
  assert.equal(f.authCount(), 0); assert.equal(network, 0);
});

test('provider review: nativeRequest uses actual pi-ai serializer for system/tools and never auth/network', async t => {
  const f = fixture(); let network = 0;
  t.mock.method(globalThis, 'fetch', async () => { network++; throw new Error('Forbidden network'); });
  const request = await f.adapter.nativeRequest(input(), f.agent);
  assert.ok(request);
  assert.equal(request.model, f.model.id);
  assert.equal(request.payload.instructions, 'Synthetic system prefix.');
  assert.equal(request.payload.store, false);
  assert.equal(request.payload.stream, true);
  assert.deepEqual(request.payload.include, ['reasoning.encrypted_content']);
  assert.equal(request.payload.service_tier, 'priority');
  assert.ok((request.payload.input as any[]).some((m: any) => m.role === 'user' && m.content.some((b: any) => b.text === 'Synthetic question.')));
  assert.equal((request.payload.tools as any[])[0].name, 'fixture_tool');
  assert.deepEqual((request.payload.tools as any[])[0].parameters.required, ['value']);
  assert.equal(request.sessionId, 'synthetic-provider-review');
  assert.equal(f.authCount(), 0); assert.equal(network, 0);
});

test('provider review: actual native serializer preserves trusted encrypted replay and session tier override', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Forbidden network'); });
  const f = fixture();
  const opaque = { type: 'compaction', encrypted_content: 'synthetic-only-opaque-checkpoint+/=' };
  const history = [{ role: 'user', content: [{ type: 'input_text', text: 'retained prefix' }] }, opaque];
  const encoded = encodeCheckpoint(f.model.id, history);
  const checkpoint = { ...user(encoded), source: compactCheckpointSource(CompactionId('synthetic')) };
  f.tiers.setOverride(String(f.agent.session.id), 'openai-codex', 'flex');
  const request = await f.adapter.nativeRequest({ messages: [checkpoint, user('after checkpoint')] }, f.agent);
  assert.ok(request);
  assert.deepEqual(request.checkpointTexts, [encoded]);
  const replayed = restoreCheckpointPayload(request.payload, request.checkpointTexts!);
  assert.equal(replayed.service_tier, 'flex');
  assert.deepEqual((replayed.input as any[]).slice(0, 2), history);
  assert.ok(!JSON.stringify(replayed).includes('<dsh-pi-codex-v2-checkpoint>'));
  assert.equal(f.authCount(), 0);
  // User-supplied marker text is not authorized opaque state.
  const untrusted = await f.adapter.nativeRequest({ messages: [user(encoded)] }, f.agent);
  assert.deepEqual(untrusted?.checkpointTexts, []);
  assert.ok(JSON.stringify(restoreCheckpointPayload(untrusted!.payload, [])).includes('<dsh-pi-codex-v2-checkpoint>'));
});

test('provider review: native serialization retains session prefix-cache key', async () => {
  const f = fixture();
  const request = await f.adapter.nativeRequest(input(), f.agent);
  assert.equal(request?.payload.prompt_cache_key, String(f.agent.session.id));
});

test('provider review: native serialization retains configured reasoning', async () => {
  const f = fixture();
  const request = await f.adapter.nativeRequest(input(), f.agent);
  assert.equal((request?.payload.reasoning as { effort?: string } | undefined)?.effort, 'high');
});

test('portable serializer: foreign transcript preserves DSH system/tools but uses real Luna defaults', async t => {
  const f = fixture();
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No network during serialization'); });
  const agent = { ...f.agent, session: { ...f.agent.session, requestHeader: () => ({ config: { provider: 'deepseek', model: 'foreign', reasoningEffort: 'off', maxTokens: 999999 } }) } } as unknown as Agent;
  const request = await f.adapter.nativeRequest(input(), agent);
  assert.ok(request?.portable); assert.equal(request.model, 'gpt-6-luna');
  assert.equal(request.payload.instructions, 'Synthetic system prefix.');
  assert.equal((request.payload.reasoning as any).effort, 'high');
  assert.equal((request.payload.tools as any[])[0].name, 'fixture_tool');
  assert.equal(f.authCount(), 0);
});

test('provider review: context capacity is async-local, nested, capped, and does not mutate catalog', async () => {
  const f = fixture();
  const metadata = () => f.adapter.resolveModel('openai-codex', f.model.id);
  const values = await Promise.all([12_000, 24_000, 999_999].map(cap => f.adapter.withContextCapacity(cap, async () => {
    await new Promise(resolve => setTimeout(resolve, cap === 12_000 ? 5 : 0));
    const first = (await metadata()).context!.contextWindow;
    const nested = await f.adapter.withContextCapacity(4_000, async () => { await Promise.resolve(); return (await metadata()).context!.contextWindow; });
    assert.equal(nested, 4_000);
    assert.equal((await metadata()).context!.contextWindow, first);
    return first;
  })));
  assert.deepEqual(values, [12_000, 24_000, Math.min(f.model.contextWindow, 64_000)]);
  assert.equal((await metadata()).context!.contextWindow, Math.min(f.model.contextWindow, 64_000));
  assert.equal(f.broker.catalog.getModel('openai-codex', f.model.id)?.contextWindow, f.model.contextWindow);
});

// Exercise pi-ai's real double-checked refresh API with a fully synthetic provider.
// This catches cancellation loss that direct store.modify-only tests cannot catch.
test('provider review: real pi-ai shared locked refresh persists rotated token after caller cancellation', async () => {
  const member = 'openai-codex-1';
  const cred = (access: string, expires: number) => ({ type: 'oauth' as const, access, refresh: `refresh-${access}`, expires, accountId: 'synthetic-account' });
  let state = JSON.stringify({ [member]: cred('old', 1), 'openai-codex': cred('old', 1) });
  let queue = Promise.resolve();
  const backend: LockedBackend = { async withLockAsync(fn, options) {
    const prior = queue; let release!: () => void; queue = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try { options?.signal?.throwIfAborted(); const value = await fn(state); options?.signal?.throwIfAborted(); if (value.next !== undefined) state = value.next; return value.result; }
    finally { release(); }
  } };
  const store = new PiAccountStore(backend, member, [member]);
  let started!: () => void, finish!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const finishPromise = new Promise<void>(resolve => { finish = resolve; });
  let refreshes = 0;
  const provider = createProvider({ id: 'openai-codex', name: 'Synthetic refresh provider', baseUrl: 'https://invalid.invalid', models: [], api: openAICodexResponsesApi(),
    auth: { oauth: { name: 'Synthetic OAuth', login: async () => { throw new Error('No login'); },
      refresh: async () => { refreshes++; started(); await finishPromise; return cred('rotated', Date.now() + 3_600_000); },
      toAuth: async credential => ({ apiKey: credential.access }),
    } },
  });
  const collections = [0, 1].map(() => { const models = builtinModels({ credentials: store, authContext: { env: async () => undefined, fileExists: async () => false } }); models.setProvider(provider); return models; });
  const abort = new AbortController();
  const first = collections[0].getAuth('openai-codex', { signal: abort.signal });
  await startedPromise;
  const second = collections[1].getAuth('openai-codex');
  abort.abort();
  await assert.rejects(first, { name: 'AbortError' });
  finish();
  assert.equal((await second)?.auth.apiKey, 'rotated');
  assert.equal(refreshes, 1);
  const result = JSON.parse(state);
  assert.equal(result[member].refresh, 'refresh-rotated');
  assert.equal(result['openai-codex'].refresh, 'refresh-rotated');
});

test('provider review: current Cordis service init registers actual DSH adapter and unload removes route/settings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-provider-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = fixture();
  let creates = 0;
  t.mock.method(AuthBroker, 'create', async () => { creates++; return f.broker; });
  const ctx = new Context();
  const commands = new Set<string>();
  ctx.provide('commands', { register: (definition: { name: string }) => {
    assert.ok(!commands.has(definition.name)); commands.add(definition.name);
    return () => { commands.delete(definition.name); };
  } });
  ctx.provide('agents', { list: () => [] });
  const llmFiber = await ctx.plugin(LlmRuntime);
  const serviceFiber = await ctx.plugin(PiCompatService, {
    authPath: join(directory, 'never-open-auth.json'), poolConfigPath: join(directory, 'never-open-pool.json'),
    settingsDirectory: join(directory, 'settings'), piTierConfigPath: join(directory, 'missing-tier.json'),
  });
  t.after(async () => { await serviceFiber.dispose(); await llmFiber.dispose(); });
  assert.equal(creates, 1);
  assert.ok(ctx.piCompat.adapter instanceof PooledCodexAdapter);
  assert.ok(ctx.piCompat.settings);
  assert.equal((await ctx.llm.resolveModelInfo('openai-codex', f.model.id)).id, f.model.id);
  assert.deepEqual([...commands].sort(), ['codex-pool', 'context-window', 'fast', 'service-tier']);
  const selection = { current: { provider: 'foreign', model: 'new-model' }, assembled: undefined };
  const disposeSelection = installModelSelection(ctx, selection);
  const agent = { ...f.agent, session: { ...f.agent.session, deriveMessages: () => [] } } as unknown as Agent;
  const assembly = { sections: [], contexts: [], tools: [], variables: { provider: 'openai-codex', model: f.model.id } };
  await ctx.waterfall('system-prompt/assemble', assembly, { agent }, () => Promise.resolve(assembly));
  assert.deepEqual(ctx.piCompat.routeFor(agent), { provider: 'foreign', model: 'new-model' }, 'pre-step observes final UI selection, not stale request header');
  disposeSelection();
  await serviceFiber.dispose();
  assert.deepEqual([...commands], []);
  await assert.rejects(ctx.llm.resolveModelInfo('openai-codex', f.model.id), { code: 'NO_ADAPTER' });
  assert.equal(f.authCount(), 0);
});
