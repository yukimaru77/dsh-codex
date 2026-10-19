import { extractCodexAccountId, type CodexAuth } from './vendor/image/auth/codex-auth.ts';

export interface CarrierModel { id: string; provider: string; api?: string; baseUrl?: string }
export interface ResolvedAuth { ok: boolean; apiKey?: string; headers?: Record<string, string>; baseUrl?: string; error?: string }
/** The HOST owns pooling, locked refresh and request-local selection. Never creates a token store. */
export interface AuthFacade {
  getApiKeyAndHeaders(model: CarrierModel): Promise<ResolvedAuth>;
  find?(provider: string, modelId: string): CarrierModel | undefined;
  getAvailable?(): CarrierModel[];
  getAll?(): CarrierModel[];
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
  getProvider?(provider: string): unknown;
}

/** One resolution per tool invocation; never falls back to process env or another auth store. */
export async function resolveToolAuth(auth: AuthFacade): Promise<CodexAuth> {
  const model = ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-5.5'].map(id => auth.find?.('openai-codex', id))
    .find(m => m?.provider === 'openai-codex')
    ?? auth.getAvailable?.().find(m => m.provider === 'openai-codex')
    ?? auth.getAll?.().find(m => m.provider === 'openai-codex')
    ?? { id: 'gpt-6-luna', provider: 'openai-codex', api: 'openai-codex-responses' };
  let resolved: ResolvedAuth;
  try { resolved = await auth.getApiKeyAndHeaders(model); }
  catch { throw new Error('Codex pooled authentication unavailable. Check host authentication.'); }
  if (!resolved.ok) throw new Error('Codex pooled authentication unavailable. Check host authentication.');
  const headers = new Headers(resolved.headers);
  const token = resolved.apiKey ?? headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new Error('Codex pooled authentication returned no bearer credential.');
  const accountId = headers.get('chatgpt-account-id') ?? extractCodexAccountId(token);
  headers.set('authorization', `Bearer ${token}`);
  headers.set('chatgpt-account-id', accountId);
  headers.set('content-type', 'application/json');
  headers.set('accept', 'application/json');
  headers.set('originator', 'codex_cli_rs');
  return { token, accountId, headers: Object.fromEntries(headers) };
}
