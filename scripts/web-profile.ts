import { load, dump } from 'js-yaml';
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

interface Patch { id?: string; name?: string; config?: Record<string, unknown>; [key: string]: unknown }
/** Capture existing Web provider settings without changing its default model or original patch.
 * The new bundle mounts this layer before the existing user layer. Later UI edits go to
 * codex-other-providers, preserving the ordinary DSH configuration editor contract.
 */
export function webCompatibilityPatch(existingProfile: string): string {
  const rows = load(existingProfile, { schema: entryListSchema }) as Patch[];
  if (!Array.isArray(rows)) throw new Error('Expected a Web profile patch list');
  const latest = rows.findLast(row => row.id === 'codex-other-providers')
    ?? rows.findLast(row => row.id === 'llm-pi-ai');
  const config = latest?.config ?? { providers: {} };
  if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new Error('Unsupported existing provider config');
  const originalPreset = rows.findLast(row => row.id === 'agent-preset-registry')?.config ?? {};
  return '# Web profile integration: preserved non-Codex providers, Codex new-session preset.\n'
    + dump([
      { id: 'codex-other-providers', config },
      { id: 'agent-preset-registry', config: { ...originalPreset, default: 'codex', selectedDefault: 'codex' } },
    ], { schema: entryListSchema, noRefs: true, lineWidth: 120 });
}

// stdout can contain private provider settings: redirect it to a local overlay,
// never to this repository. The input profile is read without modification.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) {
    console.error('Usage: node --import tsx scripts/web-profile.ts /path/to/existing/cordis.patch.yml > /path/to/private-overlay.yml');
    process.exitCode = 1;
  } else {
    process.stdout.write(webCompatibilityPatch(await readFile(process.argv[2], 'utf8')));
  }
}
