// Adapted from @signalridge/pi-codex-compact (MIT, copyright 2026 Narumi).
// See LICENSE.pi-codex-compact.
import { validateCompactionItem, type JsonObject } from "./protocol.ts";
export const REPLACEMENT_TOKEN_BUDGET = 64_000;
export const REPLACEMENT_BYTE_BUDGET = 8 * 1024 * 1024;
const MAX_MEDIA_ITEM_BYTES = 2 * 1024 * 1024;
function isObject(v: unknown): v is JsonObject { return typeof v === "object" && v !== null && !Array.isArray(v); }
function serializedBytes(v: unknown): number { return Buffer.byteLength(JSON.stringify(v), "utf8"); }
function rawText(item: JsonObject): string {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .flatMap((part) =>
      isObject(part) && typeof part.text === "string" && part.type === "input_text" ? [part.text] : [],
    )
    .join("\n");
}

function hasMedia(item: JsonObject): boolean {
  return Array.isArray(item.content) && item.content.some((part) => isObject(part) && part.type === "input_image");
}

function truncateTextItem(item: JsonObject, maxChars: number): JsonObject | undefined {
  if (!Array.isArray(item.content) || maxChars <= 32) return undefined;
  let remaining = maxChars - 16;
  const content = [...item.content].reverse().flatMap((part) => {
    if (!isObject(part) || part.type !== "input_text" || typeof part.text !== "string" || remaining <= 0) {
      return [];
    }
    const text = part.text.slice(-remaining);
    remaining -= text.length;
    return [{ ...part, text: `[truncated]\n${text}` }];
  });
  if (content.length === 0) return undefined;
  return { ...item, content: content.reverse() };
}

export function buildReplacementHistory(
  input: readonly unknown[],
  compactionItem: JsonObject,
  options: { tokenBudget?: number; byteBudget?: number } = {},
): JsonObject[] {
  const tokenBudget = options.tokenBudget ?? REPLACEMENT_TOKEN_BUDGET;
  const byteBudget = options.byteBudget ?? REPLACEMENT_BYTE_BUDGET;
  const opaque = validateCompactionItem(compactionItem);
  let remainingBytes = byteBudget - serializedBytes(opaque);
  let remainingChars = tokenBudget * 4;
  if (remainingBytes <= 0) throw new Error("Opaque compaction item exceeds replacement history budget");
  const retainedNewestFirst: JsonObject[] = [];
  const candidates = input.filter(
    (item): item is JsonObject => isObject(item) && item.role === "user" && item.type !== "compaction_trigger",
  );
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index];
    const bytes = serializedBytes(candidate);
    if (hasMedia(candidate) && bytes > MAX_MEDIA_ITEM_BYTES) continue;
    const text = rawText(candidate);
    let retained = candidate;
    if (text.length > remainingChars) {
      if (hasMedia(candidate)) continue;
      const truncated = truncateTextItem(candidate, remainingChars);
      if (!truncated) continue;
      retained = truncated;
    }
    if (serializedBytes(retained) > remainingBytes) {
      if (hasMedia(retained)) continue;
      const maxCharsByBytes = Math.max(0, remainingBytes - 128);
      const truncated = truncateTextItem(retained, Math.min(remainingChars, maxCharsByBytes));
      if (!truncated || serializedBytes(truncated) > remainingBytes) continue;
      retained = truncated;
    }
    retainedNewestFirst.push(structuredClone(retained));
    remainingBytes -= serializedBytes(retained);
    remainingChars -= Math.min(remainingChars, rawText(retained).length);
    if (remainingBytes <= 128 || remainingChars <= 32) break;
  }
  return [...retainedNewestFirst.reverse(), opaque];
}
