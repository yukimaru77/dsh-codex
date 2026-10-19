import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributionHeaders } from '@deepseek-ai/dsh-llm';
import { buildReplacementHistory } from '../src/compact/history.ts';
import { appendCompactionTrigger, collectCompactionSse, CodexCompactionProtocolError } from '../src/compact/protocol.ts';
import { encodeCheckpoint, decodeCheckpoint, checkpointTexts, restoreCheckpointPayload, createNativeSummarizer, requestNativeCompaction, withSummaryFallback, CompactionRequestError } from '../src/compact/index.ts';

const item = { type: 'compaction', id: 'opaque', encrypted_content: 'synthetic-encrypted-not-a-token' };
const user = { role: 'user', content: [{ type: 'input_text', text: 'remember this' }] };
const sse = (events: unknown[]) => events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join('');
const completion = { type: 'response.completed', response: { status: 'completed', output: [item] } };
const response = () => new Response(sse([{ type: 'response.output_item.done', item }, completion]));

test('current Pi V2 adds trigger and collects duplicate item/completed output exactly once', async () => {
  assert.deepEqual(appendCompactionTrigger({ input: [user] }).input, [user, { type: 'compaction_trigger' }]);
  assert.throws(() => appendCompactionTrigger({ input: [{ type: 'compaction_trigger' }] }), CodexCompactionProtocolError);
  assert.deepEqual((await collectCompactionSse(response().body!)).item, item);
});
test('SSE rejects malformed, missing, multiple, failed, incomplete and oversized output', async () => {
  for (const events of [[], [{ type: 'response.output_item.done', item }],
    [{ type: 'response.completed', response: { output: [item, { ...item, id: 'other' }] } }],
    [{ type: 'response.failed' }, completion], [{ type: 'response.completed', response: { output: [{ type: 'compaction' }] } }]]) {
    await assert.rejects(collectCompactionSse(new Response(sse(events)).body!), CodexCompactionProtocolError);
  }
  await assert.rejects(collectCompactionSse(new Response('data: {oops\n\n').body!), CodexCompactionProtocolError);
  await assert.rejects(collectCompactionSse(response().body!, { maxBytes: 2 }), CodexCompactionProtocolError);
});
test('SSE abort cancels a stalled body', async () => {
  const controller = new AbortController(); let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const promise = collectCompactionSse(body, { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' }); assert.equal(cancelled, true);
});
test('checkpoint survives framed JSON round trip; replay only accepts source-tagged exact text', () => {
  const encoded = encodeCheckpoint('gpt-test', [user, item]);
  const blocks = [{ type: 'text', text: 'preamble\n<compacted-summary>' }, { type: 'text', text: encoded }, { type: 'text', text: '</compacted-summary>' }];
  const message = JSON.parse(JSON.stringify({ role: 'user', source: { kind: 'compact-checkpoint', compactionId: 'compact-test' }, content: blocks }));
  const trusted = checkpointTexts([message]);
  assert.deepEqual(decodeCheckpoint(trusted[0])?.replacementHistory, [user, item]);
  const payload = { input: [{ role: 'user', content: [{ type: 'input_text', text: trusted[0] }] }, user] };
  assert.deepEqual(restoreCheckpointPayload(payload, trusted).input, [user, item, user]);
  assert.deepEqual(checkpointTexts([{ ...message, source: { kind: 'user' } }]), []);
  assert.deepEqual(restoreCheckpointPayload(payload, []).input, payload.input);
  assert.throws(() => restoreCheckpointPayload({ input: [] }, trusted), CodexCompactionProtocolError);
  assert.throws(() => decodeCheckpoint(encoded.replace('checkpoint>', 'checkpoint>BAD')), CodexCompactionProtocolError);
});
test('transport injects auth EVERY call, uses responses V2, retains users + encrypted item', async () => {
  let calls = 0; const payload = { input: [user, { role: 'assistant', content: [] }], instructions: 'system', tools: [{ type: 'function', name: 'read' }] };
  const opts = { getAuth: async () => ({ accessToken: `fake-${++calls}`, accountId: 'fake-account' }), fetch: async (url: any, init: any) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer fake-${calls}`);
    const body = JSON.parse(init.body); assert.equal(body.store, false); assert.equal(body.stream, true);
    assert.deepEqual(body.input.at(-1), { type: 'compaction_trigger' }); assert.deepEqual(body.tools, payload.tools);
    return response();
  } };
  for (let i = 0; i < 2; i++) assert.deepEqual((await requestNativeCompaction({ model: 'gpt-test', payload }, opts)).replacementHistory, [user, item]);
  assert.equal(calls, 2); assert.equal(payload.input.length, 2);
});
test('native headers retain lease extensions but protect auth, attribution and session routing; redirects refused', async () => {
  await requestNativeCompaction({ model: 'test', sessionId: 'fixture-session', payload: { input: [] } }, {
    getAuth: async () => ({ accessToken: 'fixture-token', accountId: 'fixture-account', headers: { Authorization: 'wrong', 'ChatGPT-Account-Id': 'wrong', 'x-fixture-extra': 'yes' } }),
    fetch: async (_url, init) => {
      const headers = new Headers(init!.headers);
      assert.equal(headers.get('authorization'), 'Bearer fixture-token');
      assert.equal(headers.get('chatgpt-account-id'), 'fixture-account');
      assert.equal(headers.get('x-fixture-extra'), 'yes');
      assert.equal(headers.get('session-id'), 'fixture-session');
      assert.equal(headers.get('x-client-request-id'), 'fixture-session');
      for (const [key, value] of Object.entries(attributionHeaders())) assert.equal(headers.get(key), value);
      assert.equal(init!.redirect, 'error');
      return response();
    },
  });
});
test('fallback only on transient availability errors; auth/request/structural/cancellation stay visible', async () => {
  let fallback = 0; const summary = async () => ++fallback;
  assert.equal(await withSummaryFallback(async () => { throw new CompactionRequestError('transient', 503); }, summary), 1);
  for (const error of [new CompactionRequestError('auth', 401), new CompactionRequestError('request', 400), new CodexCompactionProtocolError('bad'), new DOMException('aborted', 'AbortError')]) {
    await assert.rejects(withSummaryFallback(async () => { throw error; }, summary), e => e === error);
  }
  const c = new AbortController(); const reason = new Error('cancelled');
  await assert.rejects(withSummaryFallback(async () => { c.abort(reason); throw new CompactionRequestError('transient'); }, summary, c.signal), e => e === reason);
  assert.equal(fallback, 1);
});
test('HTTP auth failure redacts bodies and never falls back', async () => {
  await assert.rejects(requestNativeCompaction({ model: 'test', payload: { input: [] } }, { getAuth: async () => ({ accessToken: 'fake', accountId: 'fake' }), fetch: async () => new Response('secret-body', { status: 401 }) }), e => e instanceof CompactionRequestError && e.kind === 'auth' && !e.message.includes('secret-body'));
});
test('transport cancellation wins even when injected auth/fetch ignores signal', async () => {
  const c = new AbortController(); const reason = new Error('user stopped');
  const promise = requestNativeCompaction({ model: 'test', payload: { input: [] }, signal: c.signal }, { getAuth: async () => new Promise(() => {}) });
  c.abort(reason); await assert.rejects(promise, e => e === reason);
});
test('deadline covers signal-ignoring transport and is eligible for safe fallback', async () => {
  const result = await withSummaryFallback(() => requestNativeCompaction({ model: 'test', payload: { input: [] }, timeoutMs: 5 }, {
    getAuth: async () => ({ accessToken: 'fake', accountId: 'fake' }), fetch: async () => new Promise(() => {}),
  }), async () => ({ replacementHistory: [user] }));
  assert.deepEqual(result.replacementHistory, [user]);
});
test('repeated compaction expands previous checkpoint before trigger; no old opaque item retained', async () => {
  const text = encodeCheckpoint('test', [user, item]);
  const result = await requestNativeCompaction({ model: 'test', checkpointTexts: [text], payload: { input: [{ role: 'user', content: [{ type: 'input_text', text }] }] } }, {
    getAuth: async () => ({ accessToken: 'fake', accountId: 'fake' }), fetch: async (_, init) => {
      assert.deepEqual(JSON.parse(init!.body as string).input, [user, item, { type: 'compaction_trigger' }]);
      return response();
    },
  });
  assert.deepEqual(result.replacementHistory, [user, item]);
});
test('bounded history builder retains only user items and caps text budget', () => {
  const long = { role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(1000) }] };
  const history = buildReplacementHistory([user, { role: 'assistant' }, { type: 'function_call_output' }, long], item, { tokenBudget: 40, byteBudget: 2000 });
  assert.deepEqual(history.at(-1), item);
  assert.equal(history.filter(i => i.type === 'compaction').length, 1);
  assert.ok(JSON.stringify(history).length < 1000);
  assert.throws(() => buildReplacementHistory([], item, { byteBudget: 1 }));
});
test('invalid request input fails before auth is called', async () => {
  let called = false;
  await assert.rejects(requestNativeCompaction({ model: 'test', payload: { input: [42] } }, { getAuth: async () => { called = true; return { accessToken: 'fake', accountId: 'fake' }; } }), CodexCompactionProtocolError);
  assert.equal(called, false);
});
test('native seam enabled by default, summary fallback preserved and llmStreamCall not fabricated', async () => {
  const summarize = createNativeSummarizer({ prepare: async () => ({ model: 'test', payload: { input: [user] } }), getAuth: async () => ({ accessToken: 'fake', accountId: 'fake' }), fetch: async () => response() });
  const result = await summarize({}, {}, undefined, async () => { throw new Error('unexpected fallback'); });
  assert.ok(decodeCheckpoint(result.summary[0].text)); assert.equal((result as any).llmStreamCall, undefined);
  const fallback = { summary: [{ type: 'text' as const, text: 'ordinary summary' }], provider: 'other', model: 'other' };
  const unavailable = createNativeSummarizer({ prepare: async () => ({ model: 'test', payload: { input: [] } }), getAuth: async () => ({ accessToken: 'fake', accountId: 'fake' }), fetch: async () => new Response('', { status: 503 }) });
  assert.equal(await unavailable({}, {}, undefined, async () => fallback), fallback);
});
