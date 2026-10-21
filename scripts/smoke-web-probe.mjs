import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { run as runCompatibilitySmoke } from './smoke-probe.mjs';
export const inject = ['appReady', 'codexPool', 'agents', 'agentPresets', 'tools', 'commands', 'llm', 'agentDefaultModel', 'webServer', 'connection'];
export function apply(ctx) {
  ctx.appReady.onReady(() => { void run(ctx).catch(error => { console.error('CODEX_WEB_SMOKE_FAILED', error); process.exit(1); }); });
}
async function run(ctx) {
  assert.equal((await ctx.agentPresets.resolve()).id, 'codex');
  const selected = ctx.agentDefaultModel.currentSelection();
  assert.equal(selected.provider, 'compat-fixture');
  assert.equal(selected.model, 'fixture-model');
  const existingModels = await ctx.llm.listModels(selected.provider);
  assert(existingModels.some(model => model.id === selected.model), JSON.stringify({ models: existingModels, diagnostics: ctx.llm.listConfigurableProviders().filter(item => item.provider === selected.provider).map(item => ({provider:item.provider,error:item.error})) }));
  await runCompatibilitySmoke(ctx);
  console.log('CODEX_WEB_SMOKE_OK', JSON.stringify({ defaultPreset: 'codex', retainedDefaultProvider: selected.provider, port: ctx.webServer.port }));
  if (process.env.DSH_WEB_SMOKE_KEEP === '1') {
    await writeFile(process.env.DSH_WEB_SMOKE_CONTROL, JSON.stringify({ status: 'ready', url: ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}/`) }), { mode: 0o600 });
  } else process.exit(0);
}
