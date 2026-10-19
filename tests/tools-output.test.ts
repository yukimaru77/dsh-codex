import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess';
import { captureImageOutput, OUTPUT_HELPER } from '../src/tools/output.ts';
import { executeImage, createDshImageHost, type AuthFacade } from '../src/tools/index.ts';

const savedFetch = globalThis.fetch;
before(() => { globalThis.fetch = async () => { throw new Error('LIVE NETWORK FORBIDDEN'); }; });
after(() => { globalThis.fetch = savedFetch; });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=', 'base64');
function fixture() {
  const events: string[] = [], specs: any[] = [], policies: any[] = [];
  const policy = { mode: 'workspace-write', workspaceRoot: '/remote/work' };
  let allowed = true, exists = false, platform = 'posix', enforcement = 'full', missingPython = false, exitCode = 0, quiescent = true;
  const services: Record<string, any> = {
    fs: {
      resolve: async (path: string) => ({ path }), processPath: (t: any) => t.path,
      contains: (r: any, t: any) => t.path.startsWith(r.path + '/'),
      lstat: async () => exists ? { type: 'symlink' } : undefined,
    },
    workingDirectory: { ensure: async () => '/remote/work' },
    sandboxPolicy: { resolve: () => policy },
    approval: { request: async (request: any) => { events.push('approve'); assert.match(request.reason, /remote\/work/); return allowed ? 'allowed-once' : 'denied'; } },
    sandbox: { confine: async (argv: string[], p: any) => { events.push('confine'); policies.push(p); return { argv, enforcement }; } },
    subprocess: {
      terminalEnvironment: async () => ({ platform }),
      resolveExecutable: async () => { if (missingPython) throw new SubprocessExecutableNotFoundError('missing'); return '/remote/bin/python3'; },
      spawn: (spec: any) => { specs.push(spec); events.push(spec.argv[6]); return {
        done: Promise.resolve({ exitCode, signal: null }), waitForExit: async () => quiescent, terminate: () => {},
        collected: { stdout: { readFrom: () => ({ text: spec.argv[6] === 'probe' ? '["1","2"]' : 'saved', lossy: false }) } },
      }; },
    },
    attachments: {
      saveImage: async () => ({ attachmentId: 'fixture', mediaType: 'image/png', bytes: png.length, width: 1, height: 1 }),
      readImage: async () => ({ data: png }),
    },
  };
  const ctx = { get: (name: string) => services[name], workingDirectory: services.workingDirectory } as unknown as Context;
  const exec = { signal: new AbortController().signal, agent: { session: { id: 'fixture' } }, arguments: { prompt: 'fixture' }, callId: 'fixture' } as unknown as ToolRunContext;
  let authCalls = 0, sends = 0;
  const auth: AuthFacade = { getApiKeyAndHeaders: async () => { authCalls++; return { ok: true, apiKey: 'fixture', headers: { 'ChatGPT-Account-ID': 'fixture-account' } }; } };
  const transport = { send: async () => { sends++; return { status: 200, headers: {}, body: JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }) }; } };
  return { ctx, exec, services, policy, events, specs, policies, auth, transport,
    set: (v: { allowed?: boolean; exists?: boolean; platform?: string; enforcement?: string; missingPython?: boolean; exitCode?: number; quiescent?: boolean }) => {
      exitCode = v.exitCode ?? exitCode; quiescent = v.quiescent ?? quiescent;
      allowed = v.allowed ?? allowed; exists = v.exists ?? exists; platform = v.platform ?? platform; enforcement = v.enforcement ?? enforcement; missingPython = v.missingPython ?? missingPython;
    }, counts: () => [authCalls, sends] };
}

test('default bridge exports auto/project through captured remote capabilities, never host paths', async () => {
  for (const request of [{ prompt: 'fixture' }, { prompt: 'fixture', save: 'project' as const }, { prompt: 'fixture', outputPath: 'out.png' }]) {
    const f = fixture();
    const host = await createDshImageHost(f.ctx, { ...f.exec, arguments: request }, { imageTransport: f.transport });
    // Changes during approval/call cannot redirect the already captured capability.
    for (const name of ['fs', 'subprocess', 'sandbox', 'sandboxPolicy', 'workingDirectory']) f.services[name] = new Proxy({}, { get: () => { throw new Error('wrong world'); } });
    f.policy.workspaceRoot = '/wrong';
    const result = await executeImage(f.auth, request, host);
    assert.match(result.savedPath!, /^\/remote\/work\/.*\.png$/);
    assert.deepEqual(f.events, ['approve', 'confine', 'probe', 'confine', 'save']);
    assert.equal(f.policies[0].workspaceRoot, '/remote/work');
    assert.equal(f.specs[1].stdio.stdin.data, png.toString('base64'));
    assert.equal(f.specs[0].cwd, '/remote/work');
    assert.deepEqual(f.counts(), [1, 1]);
  }
});

test('denial, existing entry, traversal, outside root and partial confinement preflight before paid call', async () => {
  for (const kind of ['denied', 'exists', 'traversal', 'outside', 'partial']) {
    const f = fixture();
    f.set({ allowed: kind !== 'denied', exists: kind === 'exists', enforcement: kind === 'partial' ? 'partial' : 'full' });
    const request = { prompt: 'fixture', outputPath: kind === 'traversal' ? '../out.png' : kind === 'outside' ? '/outside/out.png' : 'out.png' };
    const host = await createDshImageHost(f.ctx, { ...f.exec, arguments: request }, { imageTransport: f.transport });
    await assert.rejects(executeImage(f.auth, request, host));
    assert.deepEqual(f.counts(), [0, 0]); assert.equal(f.specs.length, 0);
  }
});

test('unavailable export retains auto attachment fallback; explicit project/path never silently degrade', async () => {
  for (const kind of ['absent', 'readonly', 'windows', 'python', 'partial']) {
    const f = fixture();
    if (kind === 'absent') delete f.services.subprocess;
    if (kind === 'readonly') f.policy.mode = 'read-only';
    f.set({ platform: kind === 'windows' ? 'windows' : 'posix', missingPython: kind === 'python', enforcement: kind === 'partial' ? 'partial' : 'full' });
    const host = await createDshImageHost(f.ctx, f.exec, { imageTransport: f.transport });
    assert.equal((await executeImage(f.auth, { prompt: 'fixture' }, host)).savedPath, undefined);
    const before = f.counts();
    await assert.rejects(executeImage(f.auth, { prompt: 'fixture', save: 'project' }, host));
    assert.deepEqual(f.counts(), before);
  }
});

test('none bypasses output preflight; output capability is one-shot', async () => {
  const f = fixture(); const request = { prompt: 'fixture', save: 'none' as const };
  const host = await createDshImageHost(f.ctx, { ...f.exec, arguments: request }, { imageTransport: f.transport });
  await executeImage(f.auth, request, host);
  assert.deepEqual(f.events, []);
  const prepare = await captureImageOutput(f.ctx, f.exec);
  const output = await prepare!({ prompt: 'fixture', outputPath: 'out.png' });
  await output!.save(png, f.exec.signal);
  await assert.rejects(output!.save(png, f.exec.signal), /consumed/);
});

test('helper failures, unconfirmed teardown and cancellation fail before auth; absent primitives auto-fallback', async () => {
  for (const failure of [{ exitCode: 1 }, { quiescent: false }]) {
    const f = fixture(); f.set(failure);
    const host = await createDshImageHost(f.ctx, f.exec, { imageTransport: f.transport });
    await assert.rejects(executeImage(f.auth, { prompt: 'fixture', outputPath: 'out.png' }, host));
    assert.deepEqual(f.counts(), [0, 0]);
  }
  const f = fixture(); f.set({ exitCode: 78 });
  const host = await createDshImageHost(f.ctx, f.exec, { imageTransport: f.transport });
  assert.equal((await executeImage(f.auth, { prompt: 'fixture' }, host)).savedPath, undefined);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(executeImage(f.auth, { prompt: 'fixture' }, { ...host, signal: controller.signal }));
  assert.deepEqual(f.counts(), [1, 1]);
});

// Synthetic local fixture ONLY: exercise the exact helper's OS atomic primitives.
// This is not the production host-path transport (production uses DSH services).
test('POSIX helper fixtures: create-only publication, final/parent symlink races, parent identity drift', () => {
  const available = spawnSync('python3', ['-I', '-S', '-c', 'print(1)'], { timeout: 3000 });
  assert.equal(available.status, 0, 'fixture requires python3');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-tools-fixture-')));
  const run = (path: string, mode: string, identity?: string) => spawnSync('python3', ['-I', '-S', '-c', OUTPUT_HELPER, path, mode, ...(identity ? [identity] : [])], { input: mode === 'save' ? png.toString('base64') : undefined, timeout: 3000, encoding: 'utf8' });
  try {
    const path = join(root, 'image.png');
    const probe = run(path, 'probe'); assert.equal(probe.status, 0, probe.stderr);
    const save = run(path, 'save', probe.stdout.trim()); assert.equal(save.status, 0, save.stderr);
    assert.deepEqual(readFileSync(path), png);
    assert.notEqual(run(path, 'save', probe.stdout.trim()).status, 0);
    const race = join(root, 'race.png'); const raceProbe = run(race, 'probe');
    symlinkSync(path, race);
    assert.notEqual(run(race, 'save', raceProbe.stdout.trim()).status, 0);
    assert.deepEqual(readFileSync(path), png);
    mkdirSync(join(root, 'parent')); const nested = join(root, 'parent', 'image.png');
    const nestedProbe = run(nested, 'probe'); assert.equal(nestedProbe.status, 0);
    renameSync(join(root, 'parent'), join(root, 'old'));
    symlinkSync(join(root, 'old'), join(root, 'parent'));
    assert.notEqual(run(nested, 'save', nestedProbe.stdout.trim()).status, 0);
    rmSync(join(root, 'parent')); mkdirSync(join(root, 'parent'));
    assert.notEqual(run(nested, 'save', nestedProbe.stdout.trim()).status, 0);
    assert.equal(existsSync(nested), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
