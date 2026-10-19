export * from './protocol.ts';
export * from './checkpoint.ts';
export * from './transport.ts';
export { buildReplacementHistory } from './history.ts';

import { encodeCheckpoint } from './checkpoint.ts';
import { requestNativeCompaction, withSummaryFallback, type NativeCompactionOptions, type NativeCompactionRequest } from './transport.ts';

export interface NativeSummary {
  summary: { type: 'text'; text: string }[];
  rawOutput?: { type: 'text'; text: string }[];
  provider: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number; cacheReadTokens?: number; reasoningTokens?: number };
}
export function summaryUsage(raw: Record<string, unknown> | undefined): NativeSummary['usage'] {
  if (!raw) return undefined;
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!valid(raw.input_tokens) || !valid(raw.output_tokens)) return undefined;
  const input = raw.input_tokens_details as Record<string, unknown> | undefined;
  const output = raw.output_tokens_details as Record<string, unknown> | undefined;
  return { inputTokens: raw.input_tokens, outputTokens: raw.output_tokens,
    ...(valid(raw.total_tokens) && raw.total_tokens === raw.input_tokens + raw.output_tokens ? { totalTokens: raw.total_tokens } : {}),
    ...(valid(input?.cached_tokens) ? { cacheReadTokens: input.cached_tokens } : {}),
    ...(valid(output?.reasoning_tokens) ? { reasoningTokens: output.reasoning_tokens } : {}) };
}
/**
 * DSH BasicCompactionEngine.summarize seam. No provider/service registration.
 * Supply prepare using the lead's actual adapter conversion, not a hand-written
 * lossy DSH→Pi converter. Input is ONLY the selected region (no summary directive).
 * The engine retains ownership of range checks, locks, pricing, events and flush.
 */
export function createNativeSummarizer<Input, Agent>(options: NativeCompactionOptions & {
  prepare: (input: Input, agent: Agent, signal?: AbortSignal) => Promise<NativeCompactionRequest | undefined>;
  enabled?: () => boolean;
}) {
  return async function summarize<Result>(
    input: Input, agent: Agent, signal: AbortSignal | undefined,
    standardSummarize: () => Promise<Result>,
  ): Promise<NativeSummary | Result> {
    signal?.throwIfAborted();
    if (options.enabled?.() === false) return standardSummarize();
    const prepared = await options.prepare(input, agent, signal);
    signal?.throwIfAborted();
    // undefined means the routed model is not an eligible Codex model.
    if (!prepared) return standardSummarize();
    return withSummaryFallback<NativeSummary | Result>(async () => {
      const result = await requestNativeCompaction({ ...prepared, signal }, options);
      const summary = [{ type: 'text' as const, text: encodeCheckpoint(prepared.model, result.replacementHistory) }];
      // No llmStreamCall marker: native transport did not call ctx.llm.stream().
      return { summary, rawOutput: summary, provider: 'openai-codex', model: prepared.model,
        ...(summaryUsage(result.usage) === undefined ? {} : { usage: summaryUsage(result.usage) }) };
    }, () => {
      if (prepared.checkpointTexts?.length) throw new Error('Native checkpoint compaction failed; original history preserved.');
      return standardSummarize();
    }, signal);
  };
}
