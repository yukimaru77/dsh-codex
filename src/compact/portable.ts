import { attributionHeaders } from '@deepseek-ai/dsh-llm';
import { getPiUserAgent } from '@earendil-works/pi-ai/utils/pi-user-agent';
import { extractPortable, sendExtraction, portableHandoff, type Json } from './portable-core.ts';
import type { AuthBroker } from '../auth/broker.ts';
import type { CompactionAuth } from './transport.ts';
import { summaryUsage, type NativeSummary } from './index.ts';

export async function portableSummary(history: Json[], broker: AuthBroker, auth: CompactionAuth,
  signal?: AbortSignal, fetch?: typeof globalThis.fetch, compressionUsage?: Json): Promise<NativeSummary> {
  portableHandoff(history, 'preflight');
  const result = await extractPortable(history.at(-1)!, {
    signal,
    available: id => broker.catalog.getModel('openai-codex', id)?.api === 'openai-codex-responses',
    send: (blob, attempt, abort) => sendExtraction(blob, attempt, {
      auth: { apiKey: auth.accessToken, accountId: auth.accountId, headers: auth.headers },
      signal: abort, fetch, userAgent: getPiUserAgent(), attribution: attributionHeaders(),
    }),
  });
  const summary = [{ type: 'text' as const, text: portableHandoff(history, result.text) }];
  const usages = [compressionUsage, ...result.receipts.map(r => r.usage)].map(summaryUsage).filter(u => u !== undefined);
  const usage = usages.length ? usages.reduce((a, b) => ({
    inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: (a.totalTokens ?? a.inputTokens + a.outputTokens) + (b.totalTokens ?? b.inputTokens + b.outputTokens),
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
  })) : undefined;
  return { summary, rawOutput: summary, provider: 'openai-codex', model: result.selected.model, usage };
}
