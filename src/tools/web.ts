import type { AuthFacade } from './auth.ts';
import { resolveToolAuth } from './auth.ts';
import { buildWebSearchRequest, normalizeSearchResponse } from './vendor/web/request.ts';

export interface WebRunArgs extends Record<string, unknown> {
  search_query?: { q: string; recency?: number; domains?: string[]; [key: string]: unknown }[];
  image_query?: { q: string; recency?: number; domains?: string[]; [key: string]: unknown }[];
  open?: { ref_id: string; lineno?: number; [key: string]: unknown }[];
  click?: { ref_id: string; id: number; [key: string]: unknown }[];
  find?: { ref_id: string; pattern: string; [key: string]: unknown }[];
  response_length?: 'short' | 'medium' | 'long';
  settings?: { search_context_size?: 'low' | 'medium' | 'high'; [key: string]: unknown };
}
export interface WebOptions { sessionId: string; model?: string; signal?: AbortSignal; fetch?: typeof fetch }
const ENDPOINT = 'https://chatgpt.com/backend-api/codex/alpha/search';
const MAX_RESPONSE = 8 * 1024 * 1024;

export function validateWebArgs(value: unknown): asserts value is WebRunArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('web_run arguments must be an object.');
  const args = value as WebRunArgs;
  let commands = 0;
  for (const key of ['search_query', 'image_query', 'open', 'click', 'find'] as const) {
    const items = args[key];
    if (items === undefined) continue;
    if (!Array.isArray(items)) throw new Error(`${key} must be an array.`);
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Invalid ${key} command.`);
      const required = key === 'search_query' || key === 'image_query' ? 'q' : 'ref_id';
      if (typeof item[required] !== 'string' || !(item[required] as string).trim()) throw new Error(`${key}.${required} is required.`);
      if (key === 'click' && (typeof item.id !== 'number' || !Number.isFinite(item.id))) throw new Error('click.id must be a number.');
      if (key === 'find' && typeof item.pattern !== 'string') throw new Error('find.pattern must be a string.');
      for (const n of ['recency', 'lineno']) if (item[n] !== undefined && (typeof item[n] !== 'number' || !Number.isFinite(item[n]))) throw new Error(`Invalid ${n}.`);
      if (item.domains !== undefined && (!Array.isArray(item.domains) || item.domains.some(d => typeof d !== 'string'))) throw new Error('domains must be strings.');
      commands++;
    }
  }
  if (!commands) throw new Error('web_run requires a search/open/click/find command.');
  if (args.response_length !== undefined && !['short', 'medium', 'long'].includes(args.response_length)) throw new Error('Invalid response_length.');
  if (args.settings !== undefined && (!args.settings || typeof args.settings !== 'object' || Array.isArray(args.settings))) throw new Error('Invalid settings.');
  if (args.settings?.search_context_size !== undefined && !['low', 'medium', 'high'].includes(args.settings.search_context_size)) throw new Error('Invalid search_context_size.');
}

/** Uses upstream full web_run command encoder and response normalizer, not web_search. */
export async function executeWebRun(auth: AuthFacade, args: WebRunArgs, options: WebOptions) {
  validateWebArgs(args);
  options.signal?.throwIfAborted();
  if (!options.sessionId) throw new Error('web_run requires a stable sessionId for citation references.');
  const credential = await resolveToolAuth(auth);
  options.signal?.throwIfAborted();
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(ENDPOINT, {
      method: 'POST', headers: { ...credential.headers, version: '0.0.0', 'user-agent': 'codex_cli_rs/0.0.0' },
      body: JSON.stringify(buildWebSearchRequest(args, { id: options.sessionId, model: options.model ?? 'gpt-6-luna' })),
      redirect: 'error', signal: options.signal,
    });
  } catch { options.signal?.throwIfAborted(); throw new Error('web_run transport failed.'); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`web_run failed: HTTP ${response.status}`);
  }
  const body = await readBounded(response, MAX_RESPONSE, options.signal);
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { throw new Error('web_run returned invalid JSON.'); }
  const details = normalizeSearchResponse(payload);
  return { text: details.output_text?.trim() ? details.output_text : JSON.stringify(details, null, 2), details };
}

async function readBounded(response: Response, cap: number, signal?: AbortSignal): Promise<string> {
  if (Number(response.headers.get('content-length')) > cap) { await response.body?.cancel(); throw new Error('web_run response too large.'); }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > cap) { await reader.cancel(); throw new Error('web_run response too large.'); }
      chunks.push(value);
    }
    signal?.throwIfAborted();
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}
