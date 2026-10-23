import test from 'node:test';
import assert from 'node:assert/strict';
import { outgrowsNativeModel, withDeclaredToolUpdates } from '../src/compact/tool-updates.ts';

const dev = (content: unknown[]) => ({ role: 'developer', content, source: { kind: 'tool-registry' } }) as never;
const tool = (name: string) => ({ name, description: name, parameters: { type: 'object', properties: {} } }) as never;

test('tool updates for tools the summary request does not declare are dropped', () => {
  const user = { role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } as never;
  const input = {
    tools: [tool('bash')],
    messages: [
      user,
      dev([{ type: 'tool-addition', toolName: 'subagent' }, { type: 'tool-addition', toolName: 'bash' }]),
      dev([{ type: 'tool-removal', toolName: 'subagent' }]),
      dev([{ type: 'text', text: 'note' }, { type: 'tool-removal', toolName: 'gone' }]),
    ],
  };
  const out = withDeclaredToolUpdates(input);
  assert.equal(out.messages.length, 3, 'a developer message left empty is removed');
  assert.deepEqual((out.messages[1] as unknown as { content: readonly unknown[] }).content, [{ type: 'tool-addition', toolName: 'bash' }]);
  assert.deepEqual((out.messages[2] as unknown as { content: readonly unknown[] }).content, [{ type: 'text', text: 'note' }]);
  assert.equal(withDeclaredToolUpdates({ tools: [tool('bash')], messages: [user] }).messages.length, 1);
});

test('input without stale tool updates is passed through unchanged', () => {
  const input = { tools: [tool('bash')], messages: [dev([{ type: 'tool-addition', toolName: 'bash' }])] };
  assert.equal(withDeclaredToolUpdates(input), input);
});

test('a region too large for the Codex model is left to the session model, only for other providers', () => {
  const big = { messages: [{ role: 'user', content: [{ type: 'text', text: 'あ'.repeat(300_000) }], source: { kind: 'user' } }] as never };
  const small = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }] as never };
  assert.equal(outgrowsNativeModel(big, { portable: true, contextWindow: 272_000 }), true);
  assert.equal(outgrowsNativeModel(small, { portable: true, contextWindow: 272_000 }), false);
  assert.equal(outgrowsNativeModel(big, { portable: false, contextWindow: 272_000 }), false, 'a Codex session keeps native compaction');
  assert.equal(outgrowsNativeModel(big, undefined), false);
});
