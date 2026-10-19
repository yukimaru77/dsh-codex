import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction';
import { createUserMessage, LlmAdapter, type StreamChunk, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
import PiCompatCompaction from '../src/compaction-entry.ts';
import { encodeCheckpoint, checkpointTexts } from '../src/compact/checkpoint.ts';
import { portableSummary } from '../src/compact/portable.ts';

const blob = { type: 'compaction', id: 'b', encrypted_content: 'synthetic'.repeat(1000), output_tokens: 100 };
const rawUser = { role: 'user', content: [{ type: 'input_text', text: 'preserved requirement' }] };
const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
function response(compact = false) {
  return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed',
    output: compact ? [blob] : [{ type: 'message', role: 'assistant', id: 'm', content: [{ type: 'output_text', text: 'decoded DSH handoff' }] }],
    usage: { input_tokens: 100, output_tokens: 100, total_tokens: 200, attribution: { items: { b: { input_tokens: 100 }, m: { output_tokens: 100 } } } },
  } }) + '\n\n');
}
function compatibility(native = false) {
  let authCalls = 0;
  return { nativeCompaction: true,
    routeFor: () => native ? ({ provider: 'openai-codex', model: 'gpt-6-luna' }) : ({ provider: 'foreign', model: 'foreign' }),
    settings: { capacityFor: async () => undefined },
    adapter: { withContextCapacity: (_cap: any, fn: any) => fn(), nativeRequest: async () => ({
      portable: !native, model: 'gpt-6-luna', payload: { instructions: 'DSH system', input: [rawUser], tools: [] },
    }) },
    broker: { catalog: { getModel: (_p: string, id: string) => id === 'gpt-6-luna' ? { api: 'openai-codex-responses' } : undefined },
      acquire: async () => { authCalls++; return { apiKey: 'synthetic-token', accountId: 'synthetic-account', headers: {} }; } },
    authCalls: () => authCalls };
}
class Adapter extends LlmAdapter {
  requests: any[] = [];
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, context: { contextWindow: 272000 } };
  }
  override async *stream(options: any): AsyncIterable<StreamChunk> {
    this.requests.push(structuredClone(options.messages));
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
for (const native of [false, true]) for (const mode of ['success', 'failed', 'too-large'] as const) test(`real DSH loop pre-step native=${native} ${mode}: durable transaction, no opaque transmission`, async t => {
  const ctx = new Context();
  await mountAgentLoopTestDependencies(ctx);
  const loop = await ctx.plugin(AgentLoop, { agents: [] });
  const meter = await ctx.plugin(TokenMeter);
  const compat = compatibility(native); ctx.provide('piCompat', compat as any);
  const plugin = await ctx.plugin(PiCompatCompaction, { auto: false });
  t.after(async () => { await plugin.dispose(); await meter.dispose(); await loop.dispose(); });
  const adapter = new Adapter(); ctx.llm.registerAdapter(['foreign', 'openai-codex'], adapter);
  const agent = await ctx.agentLoop.create(SessionId('portable-' + mode), compat.routeFor());
  const encoded = encodeCheckpoint('gpt-6-luna', [rawUser, blob]);
  agent.session.append('user/message', { ...user(encoded), source: compactCheckpointSource(CompactionId('fixture')) }, { surfaceOp: 'append' });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: any, init: any) => {
    assert.equal(String(url), 'https://chatgpt.com/backend-api/codex/responses'); calls++;
    const body = JSON.parse(init.body); assert.equal(body.instructions, 'Follow the user instructions.'); assert.deepEqual(body.tools, []);
    if (mode === 'failed') return new Response('private-error', { status: 401 });
    if (mode === 'too-large') {
      const r = await response().text(); return new Response(r.replace('decoded DSH handoff', 'handoff'.repeat(10000)));
    }
    return response();
  });
  agent.followup(user('continue'));
  await agent.whenIdle();
  assert.equal(compat.authCalls(), 1); assert.equal(calls, 2);
  if (mode === 'success') {
    assert.equal(adapter.requests.length, 1);
    assert.match(JSON.stringify(adapter.requests), /decoded DSH handoff/);
    assert.match(JSON.stringify(adapter.requests), /preserved requirement/);
    assert.ok(!JSON.stringify(adapter.requests).includes('encrypted_content'));
    assert.equal(checkpointTexts(agent.session.deriveMessages()).length, 0);
    // Restore the real durable session; replay uses committed text without another decode.
    const events = Array.from({ length: agent.session.seq }, (_, i) => agent.session.eventAt(SessionSeq(i))!);
    const restored = Session.create(agent.session.id, events, agent.session.header);
    assert.equal(checkpointTexts(restored.deriveMessages()).length, 0);
    assert.match(JSON.stringify(restored.deriveMessages()), /decoded DSH handoff/);
  } else {
    assert.equal(adapter.requests.length, 0);
    assert.equal(checkpointTexts(agent.session.deriveMessages()).length, 1);
  }
});
for (const native of [false, true]) test(`new compaction native=${native} freezes existing broker lease across V2 and two extraction calls`, async t => {
  const ctx = new Context(); const compat = compatibility(native); ctx.provide('piCompat', compat as any);
  const engine = new PiCompatCompaction(ctx, { auto: false });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
    calls++; const body = JSON.parse(init.body); const compact = body.input.at(-1)?.type === 'compaction_trigger';
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-token');
    assert.equal(body.instructions, compact ? 'DSH system' : 'Follow the user instructions.');
    return response(compact);
  });
  const result = await (engine as any).summarize({ messages: [] }, {}, new AbortController().signal);
  assert.equal(compat.authCalls(), 1); assert.equal(calls, 3);
  assert.match(result.summary[0].text, /preserved requirement/); assert.match(result.summary[0].text, /decoded DSH handoff/);
  assert.equal(result.usage.totalTokens, 600); assert.ok(!('llmStreamCall' in result));
});
test('DSH media extraction refuses lossy text-only replacement', async () => {
  await assert.rejects(portableSummary([{ role: 'user', content: [{ type: 'input_image', image_url: 'fixture' }] }, blob], compatibility().broker as any,
    { accessToken: 'fake', accountId: 'fake' }, undefined, async () => response()), /NON_TEXT_RETAINED_INPUT/);
});
test('successful native V2 followed by failed Luna never returns a partial summary', async t => {
  const ctx = new Context(); ctx.provide('piCompat', compatibility(true) as any);
  const engine = new PiCompatCompaction(ctx, { auto: false });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
    calls++;
    return JSON.parse(init.body).input.at(-1)?.type === 'compaction_trigger'
      ? response(true) : new Response('private-error', { status: 401 });
  });
  await assert.rejects((engine as any).summarize({ messages: [] }, {}, new AbortController().signal));
  assert.equal(calls, 3);
});