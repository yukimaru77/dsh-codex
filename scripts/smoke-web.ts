import { mkdtemp, mkdir, readFile, writeFile, cp, copyFile, rm, open, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { webCompatibilityPatch } from './web-profile.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'dsh-pi-web-smoke-'));
const home = join(scratch, 'home');
const profile = join(home, 'profiles/web');
const source = process.env.DSH_WEB_PROFILE_SOURCE ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles/web');
const cli = process.env.DSH_CLI ?? fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/lib/bin.js'));
const keep = process.env.DSH_WEB_SMOKE_KEEP === '1';
let kept = false;
try {
  await mkdir(profile, { recursive: true });
  await copyFile(join(source, 'package.json'), join(profile, 'package.json'));
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  manifest.dependencies ??= {};
  manifest.dependencies['dsh-codex'] = `link:${root}`;
  if (!manifest.dsh.profile.bundles.includes('dsh-codex')) manifest.dsh.profile.bundles.push('dsh-codex');
  await writeFile(join(profile, 'package.json'), JSON.stringify(manifest, null, 2));
  // Model and provider preservation are exercised with an offline fixture, never
  // by copying a user's endpoints, credentials, or selected default model.
  const fixtureProfile = '- id: agent-default-model\n  config: {provider: compat-fixture, model: fixture-model}\n- id: llm-pi-ai\n  config:\n    providers:\n      compat-fixture:\n        api: anthropic-messages\n        apiKeyEnv: DSH_SMOKE_FIXTURE_KEY\n        baseURL: https://example.invalid\n        models: [{id: fixture-model}]\n';
  await writeFile(join(profile, 'cordis.patch.yml'), fixtureProfile + webCompatibilityPatch(fixtureProfile));
  await cp(join(source, 'node_modules'), join(profile, 'node_modules'), { recursive: true, dereference: false, verbatimSymlinks: true }).catch(e => { if (e.code !== 'ENOENT') throw e; });
  await mkdir(join(profile, 'node_modules'), { recursive: true });
  await rm(join(profile, 'node_modules/dsh-codex'), { recursive: true, force: true });
  await symlink(root, join(profile, 'node_modules/dsh-codex'), 'junction');
  const env = { ...process.env, HOME: scratch, DSH_HOME: home, DSH_TELEMETRY: '0', DSH_SMOKE_FIXTURE_KEY: 'synthetic-fixture-not-a-real-key' };
  const credential = { type: 'oauth', access: 'x.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-only' } })).toString('base64url') + '.x', refresh: 'fixture-not-real', expires: Date.now() + 3600000, accountId: 'fixture-only' };
  await writeFile(join(scratch, 'auth.json'), JSON.stringify({ 'openai-codex': credential, 'openai-codex-2': credential }), { mode: 0o600 });
  await writeFile(join(scratch, 'pool.json'), JSON.stringify({ standardLogin: true, pools: [{ name: 'fixture', enabled: true, baseProvider: 'openai-codex', members: ['openai-codex-2'], strategy: 'custom', selectionTiming: 'auth-use' }] }));
  await writeFile(join(scratch, 'no-network.mjs'), "globalThis.fetch = async () => { throw new Error('External requests forbidden during Web smoke'); };\n");
  await writeFile(join(scratch, 'smoke.patch.yml'), `- id: hmr\n  disabled: true\n- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n- id: web-runtime\n  config:\n    openBrowser: false\n    printUrl: false\n    surfaceContext: false\n- id: codex-pool\n  config:\n    accounts: [smoke]\n    tierConfigPath: ${JSON.stringify(join(scratch, 'no-tier.json'))}\n    settingsDirectory: ${JSON.stringify(join(scratch, 'settings'))}\n- insert:\n    - id: codex-web-probe\n      name: ${JSON.stringify(join(root, 'scripts/smoke-web-probe.mjs'))}\n`);
  const args = [cli, '--profile', 'web', '--patch', join(scratch, 'smoke.patch.yml'), '--no-open'];
  const bootEnv = { ...env, NODE_OPTIONS: `--import=${join(scratch, 'no-network.mjs')}`, DSH_WEB_SMOKE_CONTROL: join(scratch, 'control.json') };
  if (keep) {
    const log = await open(join(scratch, 'server.log'), 'w', 0o600);
    const child = spawn(process.execPath, args, { cwd: scratch, env: bootEnv, stdio: ['ignore', log.fd, log.fd], detached: true });
    child.unref(); await log.close();
    await writeFile(join(scratch, 'pid'), String(child.pid));
    const deadline = Date.now() + 20000;
    try {
      while (Date.now() < deadline) {
        try { JSON.parse(await readFile(join(scratch, 'control.json'), 'utf8')); kept = true; break; } catch {}
        await delay(150);
      }
      if (!kept) throw new Error('Web browser smoke startup failed: ' + await readFile(join(scratch, 'server.log'), 'utf8'));
      await writeFile('/tmp/dsh-pi-web-smoke-location.json', JSON.stringify({ scratch, pid: child.pid, control: join(scratch, 'control.json') }), { mode: 0o600 });
      console.log('WEB_BROWSER_FIXTURE_READY; control file: /tmp/dsh-pi-web-smoke-location.json');
    } catch (error) { if (child.pid) process.kill(child.pid, 'SIGTERM'); throw error; }
  } else {
    const result = spawnSync(process.execPath, args, { cwd: scratch, env: bootEnv, encoding: 'utf8', timeout: 25000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' });
    process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
    if (result.error) console.error(result.error.message);
    if (result.status !== 0 || !result.stdout.includes('CODEX_WEB_SMOKE_OK')) process.exitCode = 1;
  }
} finally { if (!kept) await rm(scratch, { recursive: true, force: true }); }
