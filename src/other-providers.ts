import type { Context } from '@deepseek-ai/cordis';
import { apply as applyPiAi, Config } from '@deepseek-ai/dsh-llm-pi-ai';
export { Config };
export const name = 'pi-compat-other-providers';
export const inject = ['llm'];
/** Preserve ordinary DSH provider support, reserving exactly one route for the Pi pool.
 * The original profile row/config remains on disk; deployment disables that row.
 */
export function apply(ctx: Context, config: Config) {
  const providers = { get: () => Object.fromEntries(Object.entries(config.providers.get()).filter(([id]) => id !== 'openai-codex')) };
  applyPiAi(ctx, { ...config, providers } as Config);
}
