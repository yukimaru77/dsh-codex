import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, SessionId, SessionLogOffset, SessionSeq, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction';
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format';
import { releasedV4SessionFormatCodec as codec, restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4';
import { encodeCheckpoint, checkpointTexts, decodeCheckpoint, restoreCheckpointPayload } from '../src/compact/index.ts';
import { createCompactionPlugin } from '../src/compact/plugin.ts';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';

test('optional plugin is a DSH BasicCompactionEngine, not a Pi runtime/provider', () => {
  const Plugin = createCompactionPlugin({ prepare: async () => undefined, getAuth: async () => { throw new Error('unused'); } });
  assert.ok(Plugin.prototype instanceof BasicCompactionEngine);
});

test('native encrypted item survives actual DSH V4 physical codec, validation and Session restore', () => {
  const id = SessionId('synthetic-native-compaction');
  const session = Session.create(id, [], { version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0 });
  const original = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'old history' }] }), { surfaceOp: 'append' });
  const compactionId = CompactionId('synthetic-compaction');
  const lifecycle = { compactionId, turn: null };
  const start = session.append('compaction/start', lifecycle);
  const opaque = { type: 'compaction', encrypted_content: 'synthetic-only-encrypted-history' };
  const summary = [{ type: 'text' as const, text: encodeCheckpoint('gpt-test', [opaque]) }];
  const record = session.append('compaction/summary', { compactionId, summary, rawOutput: summary,
    shadowedRange: { start: original.seq, end: original.seq }, shadowedSeqs: [original.seq], shadowedTokenCount: 1, provider: 'openai-codex', model: 'gpt-test' });
  session.append('user/message', createUserMessage({ source: compactCheckpointSource(compactionId), content: summary }), {
    surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [start.seq, record.seq, original.seq],
  });
  session.append('compaction/end', lifecycle);
  const header = JSON.parse(JSON.stringify(codec.encodeHeader(JSON.parse(JSON.stringify(session.header)), session.inheritedEventCount)));
  const decoder = codec.createDecoder(header, 'strict');
  const collected = new SessionFormatEventCollector();
  for (let seq = 0; seq < session.seq; seq++) {
    // Async-independent synthetic fixture; real adapter integration uses derived messages, not log reads.
    const event = session.eventAt(SessionSeq(seq))!;
    decoder.decodeRow(JSON.parse(JSON.stringify(codec.encodeEvent(JSON.parse(JSON.stringify(event))))), collected);
  }
  decoder.finish(collected);
  const artifact = restoreReleasedV4Artifact({ header: decoder.header, events: collected.values, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES);
  const restored = Session.create(session.id, artifact.events as any, artifact.header as any, SessionLogOffset(0));
  const trusted = checkpointTexts(restored.deriveMessages());
  assert.equal(trusted.length, 1);
  assert.deepEqual(decodeCheckpoint(trusted[0])?.replacementHistory, [opaque]);
  assert.deepEqual(restoreCheckpointPayload({ input: [{ role: 'user', content: [{ type: 'input_text', text: trusted[0] }] }] }, trusted).input, [opaque]);
});
