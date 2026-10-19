import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'js-yaml';
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import { webCompatibilityPatch } from '../scripts/web-profile.ts';

test('Web activation preserves existing provider metadata and does not replace selected model or credentials', () => {
  const source = `- id: agent-default-model\n  config: {provider: h200, model: fixture, reasoningEffort: max}\n- id: llm-pi-ai\n  config:\n    providers:\n      h200: {api: anthropic-messages, apiKeyEnv: FIXTURE_KEY, baseURL: https://example.invalid}\n`;
  const rows = load(webCompatibilityPatch(source), { schema: entryListSchema }) as any[];
  assert.deepEqual(rows[0], {id: 'pi-compatible-other-providers',config:{providers:{h200:{api:'anthropic-messages',apiKeyEnv:'FIXTURE_KEY',baseURL:'https://example.invalid'}}}});
  assert.deepEqual(rows[1].config, {default:'pi-compatible', selectedDefault:'pi-compatible'});
  assert(!rows.some(row => row.id === 'agent-default-model' || row.id.includes('credentials')));
});
test('Web rerun respects newer provider overrides and existing registry options', () => {
  const rows = load(webCompatibilityPatch(`- id: llm-pi-ai\n  config: {providers: {old: {}}}\n- id: pi-compatible-other-providers\n  config: {providers: {current: {}}}\n- id: agent-preset-registry\n  config: {default: standard, selectedDefault: ptc}\n`)) as any[];
  assert.deepEqual(rows[0].config, {providers:{current:{}}});
  assert.equal(rows[1].config.selectedDefault,'pi-compatible');
  assert.throws(()=>webCompatibilityPatch('bad: shape'), /patch list/);
});
