// Type-only copy of the public shapes in DeepSeek Harness 0.2.1-rc.2
// (`packages/*/compaction-basic/src/summarizer.ts`, tag dsh-v0.2.1-rc.2).
// The released package ships these only as declarations below `lib/types`,
// which its exports map does not expose, so they are restated here.
// MIT licensed; see licenses/DeepSeek-Harness.txt.
import type { ContentBlock, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm';

export interface SummarizationInput {
  readonly tools?: readonly ToolSchema[];
  readonly messages: readonly Message[];
}

export type SummaryResult = {
  summary: ContentBlock[];
  provider: string;
  model: string;
  maxTokens?: number;
  usage?: TokenUsage;
} & ({
  rawOutput: ContentBlock[];
  llmStreamCall: true;
} | {
  rawOutput?: ContentBlock[];
  llmStreamCall?: never;
});
