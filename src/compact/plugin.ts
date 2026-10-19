/** Optional DSH service plugin. Install INSTEAD OF compaction-basic, not beside it. */
import { BasicCompactionEngine, type BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic';
import type { SummarizationInput, SummaryResult } from '../vendor/dsh-compaction-basic/summarizer-types.ts';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createNativeSummarizer } from './index.ts';
import type { NativeCompactionOptions, NativeCompactionRequest } from './transport.ts';

export interface NativeCompactionPluginOptions extends NativeCompactionOptions {
  prepare: (input: SummarizationInput, agent: Agent, signal?: AbortSignal) => Promise<NativeCompactionRequest | undefined>;
  enabled?: () => boolean;
}
/** Inherits DSH's service inject/Config metadata and every normal transaction path. */
export function createCompactionPlugin(options: NativeCompactionPluginOptions): typeof BasicCompactionEngine {
  const summarize = createNativeSummarizer(options);
  return class NativeCodexCompaction extends BasicCompactionEngine {
    protected override async summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
      return summarize(input, agent, signal, () => super.summarize(input, agent, signal));
    }
  };
}
export type { BasicCompactionConfig };
