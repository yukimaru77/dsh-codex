import { build } from 'tsdown';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await build({ cwd: root, entry: ['src/index.ts', 'src/agent-entry.ts', 'src/compaction-entry.ts', 'src/other-providers.ts'],
  outDir: 'lib', format: 'esm', outExtensions: () => ({ js: '.js' }), platform: 'node', target: 'node24', sourcemap: true, clean: true, dts: false,
  external: id => !id.startsWith('.') && !id.startsWith('/') && !/^@deepseek-ai\/dsh-llm-pi-ai\/src\//.test(id),
  noExternal: [/^@deepseek-ai\/dsh-llm-pi-ai\/src\//],
});
const plugin = (entry: string) => JSON.stringify(resolve(root, 'lib', entry + '.js'));
const standardPath = resolve(root, 'node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml');
const original = await readFile(standardPath, 'utf8');
const preset = original.replace('id: preset-standard', 'id: preset-pi-compatible')
  .replace('id: standard', 'id: pi-compatible\n        name: Pi-compatible Codex\n        description: Shared Pi account pool, Codex tools, native compaction and session settings.')
  .replace('order: 1', 'order: 0')
  .replace("name: '@deepseek-ai/dsh-compaction-basic'", `name: ${plugin('compaction-entry')}`)
  .replace('fetch: true\n              searchTimeoutMs:', 'fetch: true\n              search: false\n              searchTimeoutMs:')
  + `\n          - id: pi-compatible-tools\n            name: ${plugin('agent-entry')}\n`;
await mkdir(resolve(root, 'presets'), { recursive: true });
await writeFile(resolve(root, 'presets/pi-compatible.patch.yml'), preset);
await writeFile(resolve(root, 'cordis.patch.yml'), `# Generated local overlay; original rows/settings are retained, not deleted.\n- id: llm-pi-ai\n  disabled: true\n- insert:\n    - id: pi-compatible\n      name: ${plugin('index')}\n    - id: pi-compatible-other-providers\n      name: ${plugin('other-providers')}\n      config:\n        providers: {}\n\n${preset}`);
await writeFile(resolve(root, 'cordis.tui.patch.yml'), `# Reserve Codex for the shared Pi broker; keep all other TUI OAuth routes.\n- id: dsh-tui-auth\n  config:\n    providers: [openai, anthropic, xai, meta]\n- id: dsh-tui\n  config:\n    provider: openai-codex\n    model: gpt-6.1-sol\n    effort: medium\n    fullscreen: true\n    terminalImages: true\n    preset: !!js process.env.DSH_TUI_PRESET ?? 'pi-compatible'\n    workspace: !!js process.env.DSH_TUI_WORKSPACE_TARGET ?? undefined\n    sessionId: !!js process.env.DSH_TUI_RESUME_SESSION ?? undefined\n    backend: !!js process.env.DSH_TUI_BACKEND || undefined\n`);
await writeFile(resolve(root, 'cordis.web.patch.yml'), '# Generated Web defaults; existing provider and model settings are kept in the user profile.\n- id: agent-preset-registry\n  config:\n    default: pi-compatible\n    selectedDefault: pi-compatible\n');
console.log('Built local DSH compatibility bundle and pi-compatible preset.');
