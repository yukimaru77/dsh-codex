import type { Context } from '@deepseek-ai/cordis';
import type {} from './service.ts';
import { registerTools } from './tools/index.ts';
export const name = 'pi-compatible-tools';
export const inject = ['piCompat', 'tools', 'attachments', 'fs', 'workingDirectory'];
/** Mounted inside the preset scope: tools never leak into minimal/foreign presets. */
export function apply(ctx: Context) {
  ctx.effect(() => registerTools(ctx, {
    auth: exec => ctx.piCompat.broker.registryFor(exec.name === 'web_run' ? 'web' : 'image', exec.signal),
  }));
}
