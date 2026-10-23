import test from 'node:test';
import assert from 'node:assert/strict';
import { withDeclaredToolUpdates } from '../src/compact/tool-updates.ts';

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
