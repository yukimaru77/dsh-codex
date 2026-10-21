import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import { credentialKey, type CredentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials';
import { PoolError } from './pool.ts';

/** Record scope of every pool account: `codex-pool/<account>` in the DSH credential store. */
export const CREDENTIAL_SCOPE = 'codex-pool';
export const recordKeyFor = (account: string): CredentialKey => credentialKey(CREDENTIAL_SCOPE, account);

export function accountId(value: Credential | undefined): string | undefined {
  if (value?.type !== 'oauth') return undefined;
  if (typeof value.accountId === 'string' && value.accountId.length) return value.accountId;
  try {
    const claims = JSON.parse(Buffer.from(value.access.split('.')[1], 'base64url').toString('utf8'));
    const id: unknown = claims?.['https://api.openai.com/auth']?.chatgpt_account_id;
    return typeof id === 'string' && id.length ? id : undefined;
  } catch { return undefined; }
}
function toCredential(record: CredentialRecord | undefined): Credential | undefined {
  return record?.kind === 'grant' ? record.payload as Credential : undefined;
}
function complete(credential: Credential): Credential {
  if (credential.type !== 'oauth' || !credential.access || !credential.refresh || !Number.isFinite(credential.expires) || !accountId(credential)) {
    throw new PoolError('INVALID_REFRESH', 'Incomplete Codex OAuth credential.');
  }
  return credential;
}

/**
 * One pool account's ChatGPT login, kept as a grant record in DSH's own credential
 * store. Refresh runs inside `modifyRecord`, whose cross-process lock is what keeps
 * two DSH processes from rotating the same refresh token at once.
 */
export class DshAccountStore implements CredentialStore {
  readonly key: CredentialKey;
  constructor(private readonly credentials: () => CredentialProvider | undefined, readonly account: string) {
    this.key = recordKeyFor(account);
  }
  private writable(): CredentialProvider {
    const credentials = this.credentials();
    if (!credentials) throw new PoolError('NO_CREDENTIAL_STORE', 'This DSH composition mounts no credentials service to hold Codex logins.');
    return credentials;
  }
  async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
    if (providerId !== 'openai-codex') return undefined;
    return toCredential(await this.credentials()?.readRecord(this.key));
  }
  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const credential = await this.read('openai-codex', options);
    return credential ? [{ providerId: 'openai-codex', type: credential.type }] : [];
  }
  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    if (providerId !== 'openai-codex') throw new PoolError('UNSUPPORTED_AUTH', 'Only the Codex account credential may be written.');
    options?.signal?.throwIfAborted();
    // No abort check after `fn`: a refresh has already rotated the token, so the
    // new credential must be stored even when the caller has gone away.
    return toCredential(await this.writable().modifyRecord(this.key, async current => {
      const after = await fn(toCredential(current));
      return after === undefined ? undefined : { kind: 'grant', payload: complete(after) };
    }));
  }
  async delete(providerId: string): Promise<void> {
    if (providerId !== 'openai-codex') return;
    await this.writable().deleteRecord(this.key);
  }
}
