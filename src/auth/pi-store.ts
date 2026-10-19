import { dirname, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import { PoolError } from './pool.ts';

export interface LockedBackend {
  withLockAsync<T>(fn: (current: string | undefined) => Promise<{ result: T; next?: string }>, options?: AuthOperationOptions): Promise<T>;
}
export function accountId(value: Credential | undefined): string | undefined {
  if (value?.type !== 'oauth') return undefined;
  if (typeof value.accountId === 'string' && value.accountId.length) return value.accountId;
  try {
    const claims = JSON.parse(Buffer.from(value.access.split('.')[1], 'base64url').toString('utf8'));
    const id: unknown = claims?.['https://api.openai.com/auth']?.chatgpt_account_id;
    return typeof id === 'string' && id.length ? id : undefined;
  } catch { return undefined; }
}
function parse(current: string | undefined): Record<string, Credential> {
  if (!current) throw new PoolError('NO_AUTH_STORE', 'Pi authentication store is missing. Sign in through Pi first.');
  try {
    const body = JSON.parse(current);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new PoolError('INVALID_AUTH_STORE', 'Pi authentication store is not a JSON object.'); }
}
function freshFor(data: Record<string, Credential>, member: string, members: readonly string[]): Credential | undefined {
  const named = data[member];
  const id = accountId(named);
  if (!id) return undefined;
  let freshest = named;
  for (const key of ['openai-codex', ...members]) {
    const candidate = data[key];
    if (candidate?.type === 'oauth' && freshest?.type === 'oauth' && accountId(candidate) === id && candidate.expires > freshest.expires) freshest = candidate;
  }
  return freshest;
}

/**
 * Maps the built-in provider to one named Pi credential. Uses Pi's own whole-file
 * lock, and updates all SAME-account mirrors atomically on refresh. It never
 * changes which account Pi's standard alias selects or creates copied stores.
 */
export class PiAccountStore implements CredentialStore {
  constructor(private readonly backend: LockedBackend, private readonly member: string, private readonly members: readonly string[]) {
    if (!members.includes(member) || !members.every(m => /^openai-codex-\d+$/.test(m))) throw new PoolError('INVALID_MEMBER', 'Unknown named Codex credential.');
  }
  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    if (providerId !== 'openai-codex') return undefined;
    return this.backend.withLockAsync(async current => ({ result: freshFor(parse(current), this.member, this.members) }), options);
  }
  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const credential = await this.read('openai-codex', options);
    return credential ? [{ providerId: 'openai-codex', type: credential.type }] : [];
  }
  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    if (providerId !== 'openai-codex') throw new PoolError('UNSUPPORTED_AUTH', 'Only the selected Codex account may be refreshed.');
    return this.backend.withLockAsync(async current => {
      const data = parse(current);
      const before = freshFor(data, this.member, this.members);
      const id = accountId(before);
      if (!id) throw new PoolError('MISSING_AUTH', 'Named Pi Codex account has no valid OAuth credential.');
      const after = await fn(before);
      if (!after) return { result: before };
      if (accountId(after) !== id) throw new PoolError('ACCOUNT_CHANGED', 'Credential refresh cannot switch accounts; manage logins in Pi.');
      if (after.type !== 'oauth' || !after.access || !after.refresh || !Number.isFinite(after.expires)) throw new PoolError('INVALID_REFRESH', 'Incomplete OAuth refresh result.');
      options?.signal?.throwIfAborted();
      for (const key of ['openai-codex', ...this.members]) {
        if (accountId(data[key]) === id) data[key] = after;
      }
      const next = JSON.stringify(data, null, 2) + '\n';
      return { result: after, ...(next === current ? {} : { next }) };
    }, options);
  }
  async delete(): Promise<void> { throw new PoolError('MANAGE_IN_PI', 'Manage shared account login/logout in Pi; DSH cannot delete Pi credentials.'); }
}

/** Version-pinned bridge to the exact lock implementation used by this Pi installation. */
export async function openPiBackend(authPath: string): Promise<LockedBackend> {
  const mode = await stat(authPath).catch(() => undefined);
  if (!mode?.isFile()) throw new PoolError('NO_AUTH_STORE', 'Pi authentication file is missing.');
  if (process.platform !== 'win32' && (mode.mode & 0o077) !== 0) throw new PoolError('AUTH_PERMISSIONS', 'Pi auth file must be readable/writable only by its owner.');
  const piEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const backendPath = resolve(dirname(piEntry), 'core/auth-storage.js');
  const module = await import(pathToFileURL(backendPath).href) as { FileAuthStorageBackend: new (path: string) => LockedBackend };
  if (typeof module.FileAuthStorageBackend !== 'function') throw new PoolError('PI_API_CHANGED', 'Pi credential locking API changed; refusing unsafe access.');
  return new module.FileAuthStorageBackend(authPath);
}
