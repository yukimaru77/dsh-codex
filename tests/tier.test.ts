import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyServiceTierToPayload, ServiceTierSettingsHelper, effectiveContextCapacity, parseTierSettings } from '../src/tier/index.ts';
const codex = { provider: 'openai-codex', api: 'openai-codex-responses', id: 'gpt-test' };
test('Pi tier semantics: exact provider/API and wire values', () => {
  assert.deepEqual(applyServiceTierToPayload({ input: [] }, { 'openai-codex': 'priority' }, codex), { input: [], service_tier: 'priority' });
  assert.equal(applyServiceTierToPayload({}, { 'openai-codex': 'priority' }, { ...codex, api: 'other' }), undefined);
  assert.deepEqual(applyServiceTierToPayload({}, { anthropic: 'priority' }, { provider: 'anthropic', api: 'anthropic-messages' }), { service_tier: 'auto' });
  assert.deepEqual(applyServiceTierToPayload({}, { anthropic: 'standard' }, { provider: 'anthropic', api: 'anthropic-messages' }), { service_tier: 'standard_only' });
  assert.deepEqual(applyServiceTierToPayload({ config: { temperature: 1 } }, { google: 'flex' }, { provider: 'google', api: 'google-generative-ai' }), { config: { temperature: 1, serviceTier: 'flex' } });
});
test('session overrides off/inherit, fast toggle and durable snapshot restoration', async () => {
  const helper = new ServiceTierSettingsHelper({ 'openai-codex': 'priority' });
  helper.toggleFast('one', codex);
  assert.equal(helper.effective('one')['openai-codex'], '');
  assert.equal(helper.effective('two')['openai-codex'], 'priority');
  const state = JSON.parse(JSON.stringify(helper.snapshot('one')));
  const restored = new ServiceTierSettingsHelper({ 'openai-codex': 'flex' }); restored.restore('one', state);
  assert.equal(restored.effective('one')['openai-codex'], '');
  restored.setOverride('one', 'openai-codex', undefined);
  assert.equal(restored.effective('one')['openai-codex'], 'flex');
  restored.toggleFast('one', codex); assert.equal(restored.effective('one')['openai-codex'], 'priority');
  assert.deepEqual(await restored.requestHook('one', p => ({ ...(p as object), previous: true }))({ input: [] }, codex), { input: [], previous: true, service_tier: 'priority' });
  const original = { service_tier: 'flex' }; assert.equal(await helper.requestHook('one')(original, codex), original);
  restored.clear('one'); assert.equal(restored.effective('one')['openai-codex'], 'flex');
});
test('strict config validation; context setting is a cap and never imaginary capacity', () => {
  for (const invalid of [null, [], { nope: 'priority' }, { 'openai-codex': 'standard' }, { anthropic: 'flex' }, { openai: '' }]) assert.throws(() => parseTierSettings(invalid));
  assert.equal(effectiveContextCapacity(272_000, 1_000_000), 272_000);
  assert.equal(effectiveContextCapacity(272_000, 128_000), 128_000);
  assert.equal(effectiveContextCapacity(272_000), 272_000);
  assert.throws(() => effectiveContextCapacity(272_000, -1));
});
