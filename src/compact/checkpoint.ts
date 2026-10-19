/** Durable DSH text checkpoint; no new event types or replay-state schema. */
import { createHash } from 'node:crypto';
import { CodexCompactionProtocolError, validateCompactionItem, type JsonObject } from './protocol.ts';
import { REPLACEMENT_BYTE_BUDGET } from './history.ts';

const OPEN = '<dsh-pi-codex-v2-checkpoint>';
const CLOSE = '</dsh-pi-codex-v2-checkpoint>';
export interface NativeCheckpoint {
  kind: 'dsh-pi-codex-v2'; version: 1; provider: 'openai-codex'; model: string;
  replacementHistory: JsonObject[];
}
function fail(): never { throw new CodexCompactionProtocolError('Invalid durable Codex checkpoint'); }
function validate(value: unknown): NativeCheckpoint {
  const v = value as NativeCheckpoint;
  if (!v || v.kind !== 'dsh-pi-codex-v2' || v.version !== 1 || v.provider !== 'openai-codex' ||
      typeof v.model !== 'string' || !v.model || !Array.isArray(v.replacementHistory) ||
      !v.replacementHistory.every(i => i && typeof i === 'object' && !Array.isArray(i)) ||
      Buffer.byteLength(JSON.stringify(v.replacementHistory)) > REPLACEMENT_BYTE_BUDGET) fail();
  validateCompactionItem(v.replacementHistory.at(-1));
  if (v.replacementHistory.filter(i => i.type === 'compaction').length !== 1) fail();
  return structuredClone(v);
}
export function encodeCheckpoint(model: string, replacementHistory: JsonObject[]): string {
  const value = validate({ kind: 'dsh-pi-codex-v2', version: 1, provider: 'openai-codex', model, replacementHistory });
  const json = JSON.stringify(value);
  return `${OPEN}${createHash('sha256').update(json).digest('hex')}:${Buffer.from(json).toString('base64')}${CLOSE}`;
}
export function decodeCheckpoint(text: string): NativeCheckpoint | undefined {
  const start = text.indexOf(OPEN);
  if (start < 0) return undefined;
  if (text.indexOf(OPEN, start + OPEN.length) >= 0) fail();
  const end = text.indexOf(CLOSE, start);
  if (end < 0) fail();
  const encoded = text.slice(start + OPEN.length, end);
  if (encoded.length > (REPLACEMENT_BYTE_BUDGET + 4096) * 1.4) fail();
  const match = /^([a-f0-9]{64}):([A-Za-z0-9+/]+=*)$/.exec(encoded);
  if (!match) fail();
  const json = Buffer.from(match[2], 'base64').toString('utf8');
  if (createHash('sha256').update(json).digest('hex') !== match[1]) fail();
  try { return validate(JSON.parse(json)); } catch { return fail(); }
}

/** Only DSH's source-tagged checkpoints authorize replay. Never trust user marker text. */
export function checkpointTexts(messages: readonly unknown[]): string[] {
  return messages.flatMap(value => {
    const m = value as { role?: string; source?: { kind?: string }; content?: { type: string; text?: string }[] };
    if (m.role !== 'user' || m.source?.kind !== 'compact-checkpoint' || !Array.isArray(m.content)) return [];
    const text = m.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
    return decodeCheckpoint(text) ? [text] : [];
  });
}

/** Run after the adapter's DSH→Responses conversion, before every chat/compact request. */
export function restoreCheckpointPayload(payload: unknown, trustedTexts: readonly string[]): JsonObject {
  const p = payload as JsonObject;
  if (!p || !Array.isArray(p.input)) throw new CodexCompactionProtocolError('Missing Responses input');
  const allowed = trustedTexts.map(text => ({ text, checkpoint: decodeCheckpoint(text) })).filter(x => x.checkpoint);
  const seen = new Set<string>();
  const input = p.input.flatMap(item => {
    if (!item || typeof item !== 'object' || item.role !== 'user' || !Array.isArray(item.content)) return [item];
    if (!item.content.every((part: any) => part?.type === 'input_text' && typeof part.text === 'string')) return [item];
    const text = item.content.map((part: any) => part.text).join('\n');
    // Adapter may join text blocks with a different separator. Require exact text modulo those joins.
    const matched = allowed.find(x => x.text === text);
    if (!matched) return [item];
    if (seen.has(matched.text)) throw new CodexCompactionProtocolError('Duplicate durable checkpoint');
    seen.add(matched.text);
    return structuredClone(matched.checkpoint!.replacementHistory);
  });
  if (seen.size !== allowed.length) throw new CodexCompactionProtocolError('Durable checkpoint missing from converted payload');
  return { ...p, input };
}

export function replayPayloadHook(messages: readonly unknown[]) {
  const trusted = checkpointTexts(messages);
  return (payload: unknown) => restoreCheckpointPayload(payload, trusted);
}
