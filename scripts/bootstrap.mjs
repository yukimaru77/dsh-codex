import { access, lstat, mkdir, readFile, readdir, realpath, symlink, unlink } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Development setup only: link the DSH packages of an installed DeepSeek Harness
// release into this checkout for build, typecheck and tests. Never downloads
// packages and never changes the DSH installation.
// Build tools come from this package's own devDependencies (`pnpm install`).
const expectedVersion = '0.2.1-rc.2';
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length > 3) {
  console.error('Usage: node scripts/bootstrap.mjs [/path/to/dsh-installation/node_modules]');
  console.error('Or set DSH_INSTALL. Default: the `dsh` command on PATH.');
  process.exit(1);
}
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22.19 or newer is required');
const manifest = async directory => JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));

/** The node_modules directory holding the `@deepseek-ai/dsh` package that the `dsh` command runs. */
async function defaultInstallation() {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const command = await realpath(join(directory, 'dsh')).catch(() => undefined);
    if (!command) continue;
    for (let current = dirname(command); dirname(current) !== current; current = dirname(current)) {
      const pkg = await manifest(current).catch(() => undefined);
      if (pkg?.name === '@deepseek-ai/dsh') return resolve(current, '../..');
    }
  }
  throw new Error('Could not find an installed `dsh`; pass its node_modules directory or set DSH_INSTALL');
}

const installation = await realpath(resolve(process.argv[2] ?? process.env.DSH_INSTALL ?? await defaultInstallation()));
const dsh = await manifest(join(installation, '@deepseek-ai/dsh'));
if (dsh.version !== expectedVersion) throw new Error(`Expected DeepSeek Harness ${expectedVersion}; ${installation} has ${dsh.version}`);

const links = new Map();
for (const scope of ['@deepseek-ai', '@earendil-works']) {
  for (const name of await readdir(join(installation, scope))) {
    links.set(`${scope}/${name}`, join(installation, scope, name));
  }
}
// A rerun may refresh symlinks, but must not replace a real installed folder.
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
console.log(`Linked ${links.size} packages from ${installation}. Next: pnpm run build && pnpm run typecheck && pnpm test`);
