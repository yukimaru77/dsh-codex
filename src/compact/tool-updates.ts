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
