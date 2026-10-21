import type { RequestMessage } from '@deepseek-ai/dsh-llm';

/** The original DSH inputs for a serialized Codex request. */
export interface PayloadTransformRequest {
  messages: readonly RequestMessage[];
  purpose?: string;
  sessionId?: string;
  signal?: AbortSignal;
}

/** Runs after serialization and service-tier processing, before sending. */
export type PayloadTransform = (
  payload: Record<string, unknown>,
  request: PayloadTransformRequest,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

/** Structural plugin API exposed by ctx.codexPool.adapter. */
export interface PayloadTransformRegistry {
  registerPayloadTransform(id: string, transform: PayloadTransform): () => void;
}
