import type { Context } from '@deepseek-ai/cordis';
import type {} from './service.ts';
import { registerTools } from './tools/index.ts';
export const name = 'codex-tools';
export const inject = ['codexPool', 'tools', 'attachments', 'fs', 'workingDirectory'];
/** Mounted inside the preset scope: tools never leak into minimal/foreign presets. */
export function apply(ctx: Context) {
  ctx.effect(() => registerTools(ctx, {
    auth: exec => ctx.codexPool.broker.registryFor(exec.name === 'web_run' ? 'web' : 'image', exec.signal),
  }));
}
