import { appendCompactionTrigger, collectCompactionSse, CodexCompactionProtocolError, type JsonObject } from './protocol.ts';
import { restoreCheckpointPayload } from './checkpoint.ts';
import { buildReplacementHistory } from './history.ts';
import { attributionHeaders } from '@deepseek-ai/dsh-llm';
import { getPiUserAgent } from '@earendil-works/pi-ai/utils/pi-user-agent';

export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
export type CompactionFailureKind = 'auth' | 'transient' | 'request';
/** Safe error metadata, never server response bodies or authorization values. */
export class CompactionRequestError extends Error {
  constructor(readonly kind: CompactionFailureKind, readonly status?: number) {
    super(`Codex compaction ${kind} failure${status === undefined ? '' : ` (${status})`}`);
    this.name = 'CompactionRequestError';
  }
}
export interface CompactionAuth { accessToken: string; accountId: string; headers?: Record<string, string> }
export interface NativeCompactionRequest {
  model: string;
  /** Receiving route cannot replay native checkpoints. Commit a Luna handoff instead. */
  portable?: boolean;
  /** Already converted Responses payload (with system/tools), WITHOUT summary instruction. */
  payload: JsonObject;
  checkpointTexts?: readonly string[];
  sessionId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface NativeCompactionOptions {
  /** Mandatory per-call facade. It alone owns selection, refresh, locking and quota policy. */
  getAuth: (request: { purpose: 'compaction'; sessionId?: string; signal: AbortSignal }) => Promise<CompactionAuth>;
  fetch?: typeof globalThis.fetch;
}
export interface NativeCompactionResult { replacementHistory: JsonObject[]; usage?: JsonObject }
export async function requestNativeCompaction(request: NativeCompactionRequest, options: NativeCompactionOptions): Promise<NativeCompactionResult> {
  request.signal?.throwIfAborted();
  const timeoutMs = request.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new CodexCompactionProtocolError('Invalid compaction timeout');
  if (!request.model || typeof request.model !== 'string') throw new CodexCompactionProtocolError('Missing compaction model');
  const operation = new AbortController();
  const timer = setTimeout(() => operation.abort(new DOMException('Compaction timed out', 'TimeoutError')), timeoutMs);
  const onAbort = () => operation.abort(request.signal!.reason);
  request.signal?.addEventListener('abort', onAbort, { once: true });
  const signal = operation.signal;
  let abortListener: (() => void) | undefined;
  const work = async (): Promise<NativeCompactionResult> => {
    // Validate structural state before acquiring credentials or issuing a request.
    const restored = restoreCheckpointPayload(request.payload, request.checkpointTexts ?? []);
    if (!(restored.input as unknown[]).every(item => item !== null && typeof item === 'object' && !Array.isArray(item))) {
      throw new CodexCompactionProtocolError('Invalid Responses input item');
    }
    const prepared = appendCompactionTrigger(restored);
    const body = { ...prepared, model: request.model, store: false, stream: true };
    let auth: CompactionAuth;
    try { auth = await options.getAuth({ purpose: 'compaction', sessionId: request.sessionId, signal }); }
    catch { signal.throwIfAborted(); throw new CompactionRequestError('auth'); }
    signal.throwIfAborted();
    if (!auth?.accessToken || !auth.accountId) throw new CompactionRequestError('auth');
    const headers = new Headers({ originator: 'pi', 'user-agent': getPiUserAgent(), ...auth.headers });
    for (const [key, value] of Object.entries(attributionHeaders())) headers.set(key, value);
    headers.set('authorization', `Bearer ${auth.accessToken}`);
    headers.set('chatgpt-account-id', auth.accountId);
    headers.set('accept', 'text/event-stream');
    headers.set('content-type', 'application/json');
    headers.set('openai-beta', 'responses=experimental');
    if (request.sessionId) { headers.set('session-id', request.sessionId); headers.set('x-client-request-id', request.sessionId); }
    let response: Response;
    try { response = await (options.fetch ?? globalThis.fetch)(CODEX_RESPONSES_URL, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' }); }
    catch { signal.throwIfAborted(); throw new CompactionRequestError('transient'); }
    if (signal.aborted) {
      void response.body?.cancel().catch(() => {});
      signal.throwIfAborted();
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const kind = response.status === 401 || response.status === 403 ? 'auth'
        : response.status === 429 || response.status >= 500 ? 'transient' : 'request';
      throw new CompactionRequestError(kind, response.status);
    }
    if (!response.body) throw new CodexCompactionProtocolError('Compaction response has no SSE body');
    const collected = await collectCompactionSse(response.body, { signal });
    signal.throwIfAborted();
    return { replacementHistory: buildReplacementHistory(restored.input as unknown[], collected.item),
      ...(collected.completedResponse?.usage && typeof collected.completedResponse.usage === 'object'
        ? { usage: collected.completedResponse.usage as JsonObject } : {}) };
  };
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      abortListener = () => reject(signal.reason);
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) reject(signal.reason);
    })]);
  } catch (error) {
    request.signal?.throwIfAborted();
    if (signal.aborted) throw new CompactionRequestError('transient');
    throw error;
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onAbort);
    if (abortListener) signal.removeEventListener('abort', abortListener);
    operation.abort();
  }
}

/** Only explicit availability failures may invoke the ordinary summarizer. */
export async function withSummaryFallback<T>(native: () => Promise<T>, summarize: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  try { const result = await native(); signal?.throwIfAborted(); return result; }
  catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof CompactionRequestError) || error.kind !== 'transient') throw error;
    const result = await summarize();
    signal?.throwIfAborted();
    return result;
  }
}
