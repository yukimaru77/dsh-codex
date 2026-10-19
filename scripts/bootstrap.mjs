import { access, glob, lstat, mkdir, readFile, realpath, symlink, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Development setup only: use an explicitly supplied, already installed and built
// DSH checkout. Never download packages or change that checkout or Pi installation.
const expectedCommit = '687f282e8625c6b8d11ff58211a90524be2e4317';
const root = fileURLToPath(new URL('../', import.meta.url));
const dshPath = process.argv[2] ?? process.env.DSH_SOURCE;
const piPath = process.argv[3] ?? process.env.PI_PACKAGE_DIR;
if (!dshPath || !piPath || process.argv.length > 4) {
  console.error('Usage: node scripts/bootstrap.mjs /path/to/deepseek-harness /path/to/@earendil-works/pi-coding-agent');
  console.error('Or set DSH_SOURCE and PI_PACKAGE_DIR. Requires a built DSH checkout and Pi 1.1.0.');
  process.exit(1);
}
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required');
const dsh = await realpath(resolve(dshPath));
const pi = await realpath(resolve(piPath));
const manifest = async directory => JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
const dshManifest = await manifest(dsh);
if (dshManifest.name !== '@deepseek-ai/dsh-root' || dshManifest.version !== '0.2.1-rc.2') {
  throw new Error('Expected DeepSeek Harness source version 0.2.1-rc.2');
}
const commit = execFileSync('git', ['-C', dsh, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (commit !== expectedCommit) throw new Error(`Expected DSH commit ${expectedCommit}; received ${commit}`);
const piManifest = await manifest(pi);
if (piManifest.name !== '@earendil-works/pi-coding-agent' || piManifest.version !== '1.1.0') {
  throw new Error('PI_PACKAGE_DIR must point to the installed @earendil-works/pi-coding-agent 1.1.0 package');
}
await access(join(dsh, 'apps/cli/lib/bin.js'));
await access(join(dsh, 'packages/llm/llm-pi-ai/lib/index.js'));

const links = new Map();
for await (const file of glob(['packages/*/*/package.json', 'vendor/*/package.json', 'apps/*/package.json', 'native/system/package.json', 'native/system/packages/*/package.json'], { cwd: dsh })) {
  const directory = join(dsh, dirname(file));
  const pkg = await manifest(directory);
  if (pkg.name?.startsWith('@deepseek-ai/')) links.set(pkg.name, directory);
}
// Use DSH's patched pi-ai build; an arbitrary standalone pi-ai install is not
// interchangeable with the source-level API used by this compatibility layer.
const piAi = join(dsh, 'packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai');
if ((await manifest(piAi)).version !== '1.1.0') throw new Error('DSH must have its patched pi-ai 1.1.0 installed');
links.set('@earendil-works/pi-ai', piAi);
links.set(piManifest.name, pi);
for (const name of ['tsx', 'tsdown', 'typescript', 'js-yaml', '@types/js-yaml', '@types/node']) {
  const directory = join(dsh, 'node_modules', name);
  await manifest(directory);
  links.set(name, directory);
}

// A rerun may refresh symlinks, but must not replace a real npm-installed folder.
for (const [name, directory] of links) {
  const destination = join(root, 'node_modules', name);
  const existing = await lstat(destination).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (existing && !existing.isSymbolicLink()) throw new Error(`Refusing to replace non-symlink ${destination}`);
  await access(directory);
}
for (const [name, directory] of links) {
  const destination = join(root, 'node_modules', name);
  await mkdir(dirname(destination), { recursive: true });
  await unlink(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await symlink(directory, destination, 'junction');
}
console.log(`Linked ${links.size} local packages. Next: npm run build && npm run typecheck && npm test`);
