import { mkdtemp, mkdir, readFile, writeFile, cp, copyFile, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'dsh-codex-smoke-'));
try {
  const home = join(scratch, 'home');
  const profile = join(home, 'profiles/dsh-tui');
  const source = process.env.DSH_TUI_PROFILE_SOURCE ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles/dsh-tui');
  await mkdir(profile, { recursive: true });
  await copyFile(join(source, 'package.json'), join(profile, 'package.json'));
  await cp(join(source, 'node_modules'), join(profile, 'node_modules'), { recursive: true, dereference: false, verbatimSymlinks: true });
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
  // Exercise this checkout as the profile's dsh-codex bundle, as an installed profile loads it.
  await rm(join(profile, 'node_modules/dsh-codex'), { recursive: true, force: true });
  await symlink(root, join(profile, 'node_modules/dsh-codex'), 'junction');
  const bundled = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  if (!bundled.dsh.profile.bundles.includes('dsh-codex')) bundled.dsh.profile.bundles.push('dsh-codex');
  await writeFile(join(profile, 'package.json'), JSON.stringify(bundled, null, 2));
  if (process.env.DSH_SSH_PRODUCT_SOURCE) {
    const product = process.env.DSH_SSH_PRODUCT_SOURCE;
    const productManifest = JSON.parse(await readFile(join(product, 'package.json'), 'utf8'));
    await cp(product, join(profile, 'node_modules', productManifest.name), { recursive: true });
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
    manifest.dependencies[productManifest.name] = productManifest.version;
    if (!manifest.dsh.profile.bundles.includes(productManifest.name)) manifest.dsh.profile.bundles.push(productManifest.name);
    await writeFile(join(profile, 'package.json'), JSON.stringify(manifest, null, 2));
  }
  const fixture = { type: 'oauth', access: 'x.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-only' } })).toString('base64url') + '.x', refresh: 'fixture-not-real', expires: Date.now() + 3600000, accountId: 'fixture-only' };
  await writeFile(join(scratch, 'auth.json'), JSON.stringify({ 'openai-codex': fixture, 'openai-codex-2': fixture }), { mode: 0o600 });
  await writeFile(join(scratch, 'pool.json'), JSON.stringify({ standardLogin: true, pools: [{ name: 'fixture', enabled: true, baseProvider: 'openai-codex', members: ['openai-codex-2'], strategy: 'custom', selectionTiming: 'auth-use' }] }));
  await writeFile(join(scratch, 'no-network.mjs'), "globalThis.fetch = async () => { throw new Error('Live network forbidden during smoke'); };\n");
  await writeFile(join(scratch, 'smoke.patch.yml'), `- id: dsh-tui\n  disabled: true\n- id: hmr\n  disabled: true\n- id: codex-pool\n  config:\n    accounts: [smoke]\n    tierConfigPath: ${JSON.stringify(join(scratch, 'no-tier.json'))}\n    settingsDirectory: ${JSON.stringify(join(scratch, 'settings'))}\n- insert:\n    - id: codex-smoke-probe\n      name: ${JSON.stringify(join(root, 'scripts/smoke-probe.mjs'))}\n`);
  const cli = process.env.DSH_CLI ?? fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/lib/bin.js'));
  const result = spawnSync(process.execPath, [cli, '--profile', 'dsh-tui', '--patch', join(root, 'cordis.tui.patch.yml'), '--patch', join(scratch, 'smoke.patch.yml')], {
    cwd: scratch, env: { ...process.env, HOME: scratch, DSH_HOME: home, DSH_TELEMETRY: '0', NODE_OPTIONS: `--import=${join(scratch, 'no-network.mjs')}` }, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL',
  });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  if (result.error) console.error(result.error.message);
  if (result.status !== 0 || !result.stdout.includes('CODEX_SMOKE_OK')) process.exitCode = 1;
} finally { await rm(scratch, { recursive: true, force: true }); }
