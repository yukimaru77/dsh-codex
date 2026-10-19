import assert from 'node:assert/strict';
export const inject = ['appReady', 'piCompat', 'agents', 'agentPresets', 'tools', 'commands', 'llm'];
export function apply(ctx) {
  ctx.appReady.onReady(() => { void run(ctx).then(() => process.exit(0), error => { console.error('PI_COMPAT_SMOKE_FAILED', error); process.exit(1); }); });
}
export async function run(ctx) {
  const models = await ctx.llm.listModels('openai-codex');
  assert(models.some(m => m.id === 'gpt-6.1-sol'));
  const preset = await ctx.agentPresets.resolve('pi-compatible');
  assert.equal(preset.id, 'pi-compatible');
  const handle = await ctx.agents.create({ sessionId: 'pi-compat-smoke', meta: { cwd: process.cwd(), agentPreset: 'pi-compatible' }, agentOptions: { provider: 'openai-codex', model: 'gpt-6.1-sol' },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'pi-compatible'); },
  });
  try {
    const names = ctx.tools.schemas(handle.agent).map(tool => tool.name);
    assert(names.includes('web_run')); assert(names.includes('codex_generate_image'));
    assert(!names.includes('web_search'));
    if (process.env.DSH_SSH_PRODUCT_SOURCE || process.env.DSH_SSH_PRODUCT_CHECK) {
      for (const name of ['ssh_hosts', 'ssh_status', 'ssh_run', 'ssh_read', 'ssh_write', 'ssh_edit', 'ssh_glob', 'ssh_grep', 'ssh_push', 'ssh_pull', 'ssh_target']) assert(names.includes(name), name);
      const result = await ctx.tools.execute({ agent: handle.agent, name: 'ssh_hosts', arguments: {}, callId: 'ssh-product-no-hosts', signal: new AbortController().signal });
      assert.equal(result.isError, false);
    }
    const commands = ctx.commands.list(handle.agent).map(command => command.name);
    for (const name of ['fast', 'service-tier', 'context-window', 'compact']) assert(commands.includes(name), name);
    const compaction = ctx.agentPresets.serviceFor(handle.agent, 'compaction');
    assert.equal(compaction.constructor.name, 'PiCompatCompaction');
    const setFast = await ctx.commands.find(handle.agent, 'fast').handler({ agent: handle.agent, rawInput: 'on', signal: new AbortController().signal });
    assert.equal(setFast.kind, 'success');
    const payload = await ctx.piCompat.adapter.nativeRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'serializer fixture' }] }] }, handle.agent);
    assert.equal(payload.payload.service_tier, 'priority');
    assert(payload.payload.input.some(item => item.role === 'user'));
    console.log('PI_COMPAT_SMOKE_OK', JSON.stringify({ models: models.length, tools: names, commands, nativeCompaction: compaction.constructor.name }));
  } finally { await handle.dispose(); }
}
