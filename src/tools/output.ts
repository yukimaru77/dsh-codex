/** Binary exports use ONLY the mounted, same-world DSH capabilities. No node:fs. */
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess';
import type {} from '@deepseek-ai/dsh-sandbox-policy';
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox';
import type {} from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-working-directory';
import type {} from '@deepseek-ai/dsh-user-approval';
import type { GenerateImageRequest, PreparedImageOutput } from './image.ts';

// Python's dir_fd primitives are the portable POSIX seam needed for no-follow
// traversal + atomic no-replace publication. Probe actual support before billing.
// Never execute a model-supplied script, executable name, or shell command.
export const OUTPUT_HELPER = String.raw`
import os, sys, json, base64, secrets
if not (os.name == 'posix' and hasattr(os, 'O_NOFOLLOW') and hasattr(os, 'O_DIRECTORY')
        and all(f in os.supports_dir_fd for f in (os.open, os.stat, os.unlink, os.link))
        and os.link in os.supports_follow_symlinks):
    sys.exit(78)
path, mode = sys.argv[1:3]
parts = path.split('/')
assert path.startswith('/') and all(p not in ('.', '..') for p in parts)
fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
tmp = None
try:
    for part in parts[1:-1]:
        assert part
        child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        os.close(fd)
        fd = child
    name = parts[-1]
    assert name and name.lower().endswith('.png')
    st = os.fstat(fd)
    # Do not stage in a directory writable by other users/groups.
    assert st.st_uid == os.geteuid() and not (st.st_mode & 0o022)
    identity = [str(st.st_dev), str(st.st_ino)]
    try:
        os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        raise ValueError('output already exists')
    if mode == 'probe':
        # Check real create/link permission and filesystem support BEFORE billing.
        # Private temporary files only, removed even on failure.
        tmp = '.dsh-image-' + secrets.token_hex(16)
        out = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        os.close(out)
        other = tmp + '-probe'
        try:
            os.link(tmp, other, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
        finally:
            try: os.unlink(other, dir_fd=fd)
            except FileNotFoundError: pass
        print(json.dumps(identity))
    else:
        assert mode == 'save' and identity == json.loads(sys.argv[3])
        data = base64.b64decode(sys.stdin.buffer.read(36 * 1024 * 1024 + 1), validate=True)
        assert len(data) <= 25 * 1024 * 1024 and data.startswith(b'\x89PNG\r\n\x1a\n')
        tmp = '.dsh-image-' + secrets.token_hex(16)
        out = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        with os.fdopen(out, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        # link is atomic and fails if ANY final entry exists, including symlinks.
        os.link(tmp, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
        print('saved')
finally:
    if tmp is not None:
        try: os.unlink(tmp, dir_fd=fd)
        except FileNotFoundError: pass
    os.close(fd)
`;

class OutputUnavailable extends Error {}

/** Snapshot at invocation, not after approval/cwd/backend switches. Undefined = unavailable. */
export async function captureImageOutput(ctx: Context, exec: ToolRunContext): Promise<((r: GenerateImageRequest) => Promise<PreparedImageOutput | undefined>) | undefined> {
  const fs = ctx.get('fs'), subprocess = ctx.get('subprocess'), sandbox = ctx.get('sandbox');
  const policies = ctx.get('sandboxPolicy'), approval = ctx.get('approval');
  const workingDirectory = ctx.get('workingDirectory');
  const agent = exec.agent;
  if (!fs || !subprocess || !sandbox || !policies || !approval || !workingDirectory || !agent) return undefined;
  const policy = Object.freeze({ ...policies.resolve({ session: agent.session }) });
  // No implicit escalation or unconfined danger-full-access bypass.
  if (policy.mode !== 'workspace-write') return undefined;
  const cwd = await workingDirectory.ensure(agent, exec.signal);
  const prepare = async (request: GenerateImageRequest): Promise<PreparedImageOutput> => {
    exec.signal.throwIfAborted();
    const deadline = AbortSignal.any([exec.signal, AbortSignal.timeout(15_000)]);
    if ((await subprocess.terminalEnvironment(deadline)).platform !== 'posix') throw new OutputUnavailable('Secure image export requires a POSIX execution world. No image request was sent.');
    const base = fs.processPath(await fs.resolve(cwd, { signal: deadline }));
    const raw = request.outputPath ?? `codex-image-${randomUUID()}.png`;
    if (raw.includes('\0') || raw.split('/').includes('..')) throw new Error('Unsafe image output path.');
    const path = posix.resolve(base, raw);
    const target = await fs.resolve(path, { cwd: base, signal: deadline });
    const root = await fs.resolve(policy.workspaceRoot, { signal: deadline });
    if (fs.processPath(target) !== path || !fs.contains(root, target)) throw new Error('Image output must be a non-symlink path inside the captured workspace.');
    if (await fs.lstat(path, {}, deadline)) throw new Error('Image output already exists; refusing overwrite.');
    if (await approval.request({ agent, callId: exec.callId, toolName: 'codex_generate_image', signal: deadline,
      reason: `Create PNG (never overwrite) at ${path} in DSH workspace ${base} under captured workspace-write policy.` }) !== 'allowed-once') throw new Error('Image file output requires user approval. No image request was sent.');
    const python = await subprocess.resolveExecutable('python3', undefined, deadline);
    const run = async (mode: 'probe' | 'save', signal: AbortSignal, identity?: string, bytes?: Uint8Array) => {
      const argv = [python, '-I', '-S', '-c', OUTPUT_HELPER, path, mode, ...(identity ? [identity] : [])];
      const confined = await sandbox.confine(argv, { ...policy, mode: 'workspace-write' }, signal);
      if (confined.enforcement !== 'full') throw new OutputUnavailable('Secure image export requires full sandbox enforcement.');
      signal.throwIfAborted();
      const handle = subprocess.spawn({ argv: confined.argv, cwd: base, signal, graceMs: 1000,
        stdio: { stdin: bytes ? { data: Buffer.from(bytes).toString('base64') } : 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } });
      let outcome;
      try { outcome = await handle.done; }
      finally {
        if (!await handle.waitForExit(AbortSignal.timeout(3000))) {
          handle.terminate();
          throw new Error('Image helper process quiescence could not be confirmed.');
        }
      }
      signal.throwIfAborted();
      if (outcome.exitCode === 78) throw new OutputUnavailable('Execution-world Python lacks secure dir_fd primitives.');
      const result = handle.collected.stdout?.readFrom(0);
      if (outcome.exitCode !== 0 || !result || result.lossy) throw new Error('Secure image output helper failed; no overwrite or unconfined retry attempted.');
      return result.text.trim();
    };
    const identity = await run('probe', deadline);
    const parsed: unknown = JSON.parse(identity);
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some(v => typeof v !== 'string' || !/^\d+$/.test(v))) throw new Error('Invalid output preflight response.');
    let used = false;
    return { async save(bytes, signal) {
      if (used) throw new Error('Image output capability already consumed.');
      used = true;
      if (bytes.byteLength > 25 * 1024 * 1024) throw new Error('Image output too large.');
      const commitSignal = AbortSignal.any([exec.signal, signal, AbortSignal.timeout(15_000)]);
      if (await run('save', commitSignal, identity, bytes) !== 'saved') throw new Error('Image output commit unconfirmed.');
      return path;
    } };
  };
  return async request => {
    try { return await prepare(request); }
    catch (error) {
      exec.signal.throwIfAborted();
      if (request.outputPath === undefined && request.save !== 'project'
          && (error instanceof OutputUnavailable || error instanceof SubprocessExecutableNotFoundError || error instanceof SandboxUnavailableError)) return undefined;
      throw error;
    }
  };
}
