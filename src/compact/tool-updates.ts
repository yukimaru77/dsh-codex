import type { SummarizationInput } from '../vendor/dsh-compaction-basic/summarizer-types.ts';

/**
 * Drop tool-addition/removal blocks for tools the summarization request does
 * not declare. A compacted region can record a tool that was added and later
 * removed (e.g. `subagent`); the request carries only the current tools, and
 * the pi-ai conversion rejects an addition of an undeclared tool, which made
 * every compaction fail. A summary needs none of these declarations.
 */
export function withDeclaredToolUpdates(input: SummarizationInput): SummarizationInput {
  const declared = new Set((input.tools ?? []).map(tool => tool.name));
  let changed = false;
  const messages = [];
  for (const message of input.messages) {
    if (message.role !== 'developer') { messages.push(message); continue; }
    const content = message.content.filter(block =>
      (block.type !== 'tool-addition' && block.type !== 'tool-removal') || declared.has(block.toolName));
    if (content.length === message.content.length) { messages.push(message); continue; }
    changed = true;
    if (content.length > 0) messages.push({ ...message, content } as typeof message);
  }
  return changed ? { ...input, messages } : input;
}

/** Share of the Codex model's window a region may fill before it is summarized by the session's own model. */
export const NATIVE_FILL = 0.8;

/** Rough token count: UTF-8 bytes / 3 (closer to one token per character for Japanese than chars / 4). */
export function estimateTokens(input: SummarizationInput): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(input.messages)) / 3);
}

/**
 * Whether a session on another provider has outgrown the Codex model native
 * compaction would use (e.g. a 1M-token DeepSeek region against gpt-6-luna).
 */
export function outgrowsNativeModel(input: SummarizationInput, target: { portable: boolean; contextWindow: number } | undefined): boolean {
  return target?.portable === true && estimateTokens(input) > target.contextWindow * NATIVE_FILL;
}
