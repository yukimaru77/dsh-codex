import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context as CordisContext } from '@deepseek-ai/cordis';
import type { Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { streamSimple as codexStream } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { LlmAdapter, LlmError, attributionHeaders, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import type { LlmCallConfig, GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { resolveProfiles } from './vendor/dsh-llm-pi-ai/config.ts';
import { toPiContext } from './vendor/dsh-llm-pi-ai/context.ts';
import { toStreamChunks } from './vendor/dsh-llm-pi-ai/stream.ts';
import { idleWatchdog } from '@deepseek-ai/dsh-timeout';
import { AuthBroker } from './auth/broker.ts';
import { replayPayloadHook, checkpointTexts, decodeCheckpoint } from './compact/checkpoint.ts';
import { ServiceTierSettingsHelper, effectiveContextCapacity } from './tier/index.ts';
import type { NativeCompactionRequest } from './compact/transport.ts';
import type { SummarizationInput } from './vendor/dsh-compaction-basic/summarizer-types.ts';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { PayloadTransform, PayloadTransformRegistry, PayloadTransformRequest } from './payload.ts';

export interface ProviderOptions {
  contextWindow?: number;
  reasoning?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  streamIdleTimeoutMs?: number;
  capacityFor?: (sessionId: string) => Promise<number | undefined>;
  beforeRequest?: (sessionId: string) => Promise<void>;
  routeFor?: (agent: Agent) => Partial<LlmCallConfig>;
}
/** Reuses DSH's actual serialization, metadata and stream adapters, not a parallel agent loop. */
export class PooledCodexAdapter extends LlmAdapter implements PayloadTransformRegistry {
  private readonly delegate: PiAiAdapter;
  private readonly profiles;
  private readonly capacities = new AsyncLocalStorage<number | undefined>();
  private readonly payloadTransforms = new Map<string, PayloadTransform>();
  registerPayloadTransform(id: string, transform: PayloadTransform): () => void {
    if (this.payloadTransforms.has(id)) throw new Error(`Payload transform already registered: ${id}`);
    this.payloadTransforms.set(id, transform);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.payloadTransforms.delete(id);
    };
  }
  private async transformPayload(payload: Record<string, unknown>, request: PayloadTransformRequest): Promise<Record<string, unknown>> {
    // A request uses the registration order present when its transform pass starts.
    const transforms = [...this.payloadTransforms.values()];
    request.signal?.throwIfAborted();
    for (const transform of transforms) {
      payload = await transform(payload, request);
      request.signal?.throwIfAborted();
    }
    return payload;
  }
  withContextCapacity<T>(cap: number | undefined, run: () => T): T { return this.capacities.run(cap, run); }
  private capacity(real: number): number { return effectiveContextCapacity(effectiveContextCapacity(real, this.options.contextWindow), this.capacities.getStore()); }
  constructor(private readonly ctx: CordisContext, readonly broker: AuthBroker, readonly tier: ServiceTierSettingsHelper, private readonly options: ProviderOptions = {}) {
    super();
    this.profiles = resolveProfiles({ 'openai-codex': { reasoning: options.reasoning ?? 'medium', retryPolicy: { mode: 'normal', maxRetries: 3 } } });
    this.delegate = new PiAiAdapter({ profiles: () => this.profiles, resolveApiKey: async () => undefined,
      auth: { credentials: { read: async () => undefined, list: async () => [], modify: async () => { throw new Error('Authentication is owned by the Codex account pool'); }, delete: async () => { throw new Error('Manage authentication in Pi'); } }, authContext: { env: async () => undefined, fileExists: async () => false } } });
  }
  override providerInfo(provider: string) { return { id: provider, name: 'OpenAI Codex · account pool' }; }
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> { return this.delegate.listModels(provider); }
  override providerRetryPolicy() { return this.delegate.providerRetryPolicy('openai-codex'); }
  override async resolveModel(provider: string, id: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    signal?.throwIfAborted();
    const meta = await this.delegate.resolveModel(provider, id, signal);
    return meta.context ? { ...meta, context: { ...meta.context, contextWindow: this.capacity(meta.context.contextWindow) } } : meta;
  }
  override imageRequestTarget(...args: Parameters<PiAiAdapter['imageRequestTarget']>) { return this.delegate.imageRequestTarget(...args); }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return { model: await this.resolveModel(provider, model, signal), stream: options => this.stream(options) };
  }
  model(id: string): Model<'openai-codex-responses'> {
    const model = this.broker.catalog.getModel('openai-codex', id);
    if (!model || model.api !== 'openai-codex-responses') throw new LlmError('Unknown Codex model', 'UNKNOWN_MODEL');
    return { ...model, contextWindow: this.capacity(model.contextWindow) } as Model<'openai-codex-responses'>;
  }
  async context(options: GenerateOptions) {
    const attachments = this.ctx.get('attachments');
    const profile = this.profiles.get('openai-codex')!;
    if (!attachments) return toPiContext(options);
    return toPiContext(options, {
      attachments,
      resolveImageAccess: ref => resolveImageAttachmentAccess(attachments, hostPath => this.ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
      maxRequestImageBytes: profile.maxRequestImageBytes,
      requestImagePolicy: { maxPixels: profile.requestImagePixelBudget, maxBytes: profile.requestImageMaxBytes },
    });
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== 'openai-codex') throw new LlmError('Adapter owns only openai-codex', 'NO_ADAPTER');
    if (options.stop !== undefined) throw new LlmError('Codex does not support stop sequences', 'UNSUPPORTED_OPTION');
    options.signal?.throwIfAborted();
    const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId);
    if (sessionId) await this.options.beforeRequest?.(sessionId);
    const cap = sessionId ? await this.options.capacityFor?.(sessionId) : undefined;
    const model = this.withContextCapacity(cap, () => this.model(options.model));
    if (checkpointTexts(options.messages).length) {
      throw new LlmError('Checkpoint must be converted to plaintext before any model request', 'INVALID_REQUEST');
    }
    const metadata = await this.delegate.resolveModel(options.provider, options.model, options.signal);
    const reasoning = options.reasoningEffort ?? this.options.reasoning ?? 'medium';
    if (metadata.reasoning && !metadata.reasoning.efforts.some(e => e.id === reasoning)) throw new LlmError('Unsupported Codex reasoning effort', 'UNSUPPORTED_OPTION');
    const lease = await this.broker.acquire(options.purpose === 'compaction' ? 'compact' : 'chat', options.model, options.signal);
    const consumer = new AbortController();
    const signal = options.signal ? AbortSignal.any([consumer.signal, options.signal]) : consumer.signal;
    // Disposed explicitly instead of with `using`, so the bundle also loads on Node 22 hosts.
    const watchdog = idleWatchdog(signal, this.options.streamIdleTimeoutMs ?? 120_000, 'LLM_STREAM_IDLE_TIMEOUT');
    try {
      const replay = replayPayloadHook(options.messages);
      const tier = this.tier.requestHook(options.sessionId === undefined ? undefined : String(options.sessionId), replay);
      try {
        const context = await this.context({ ...options, signal: watchdog.signal });
        const streamOptions: SimpleStreamOptions = {
          apiKey: lease.apiKey, headers: { ...lease.headers, ...attributionHeaders() },
          signal: watchdog.signal, transport: 'sse', maxRetries: 0,
          sessionId: options.sessionId === undefined ? undefined : String(options.sessionId),
          reasoning: (reasoning === 'off' ? undefined : reasoning) as SimpleStreamOptions['reasoning'],
          temperature: options.temperature, maxTokens: options.maxTokens,
          onPayload: async (payload, resolved) => this.transformPayload(await tier(payload, resolved) as Record<string, unknown>, {
            messages: options.messages, purpose: options.purpose, sessionId, signal: watchdog.signal,
          }),
          onResponse: response => {
            if (response.status === 429) this.broker.pool.markLimited(lease.provider);
          },
        };
        const events = codexStream(model, normalizeContext(context), streamOptions);
        const iterator = toStreamChunks(events, model.contextWindow, options.signal, model.id)[Symbol.asyncIterator]();
        let ended = false;
        try {
          while (true) { const result = await watchdog.next(iterator); if (result.done) { ended = true; return; } yield result.value; }
        } finally { if (!ended) { consumer.abort(); void iterator.return(undefined).catch(() => {}); } }
      } finally { consumer.abort(); }
    } finally { watchdog[Symbol.dispose](); }
  }
  /** Capture pi-ai's exact request serializer without acquiring auth or sending any request. */
  /** The Codex model native compaction would use for this session, and whether the session itself runs elsewhere. */
  nativeTarget(agent: Agent): { portable: boolean; contextWindow: number } | undefined {
    const routed: Partial<LlmCallConfig> = this.options.routeFor?.(agent) ?? agent.session.requestHeader()?.config ?? agent.options;
    const portable = routed.provider !== 'openai-codex';
    if (!portable && !routed.model) return undefined;
    try { return { portable, contextWindow: this.model(portable ? 'gpt-6-luna' : routed.model!).contextWindow }; } catch { return undefined; }
  }
  async nativeRequest(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<NativeCompactionRequest | undefined> {
    const routed: Partial<LlmCallConfig> = this.options.routeFor?.(agent) ?? agent.session.requestHeader()?.config ?? agent.options;
    const portable = routed.provider !== 'openai-codex';
    if (!portable && !routed.model) return undefined;
    await this.options.beforeRequest?.(String(agent.session.id));
    const model = this.model(portable ? 'gpt-6-luna' : routed.model!);
    const checkpoints = checkpointTexts(input.messages);
    if (checkpoints.some(text => decodeCheckpoint(text)!.model !== model.id)) {
      throw new Error('Checkpoint model changed; convert the checkpoint at the next pre-step before compacting.');
    }
    const options: GenerateOptions = { provider: 'openai-codex', model: model.id, messages: [...input.messages], tools: input.tools ? [...input.tools] : undefined, toolHistory: agent.session.toolHistory(), sessionId: agent.session.id, signal, purpose: 'compaction' };
    const context = await this.context(options);
    let payload: Record<string, unknown> | undefined;
    const fake = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'serialization-only' } })).toString('base64url')}.x`;
    const stopped = new Error('DSH_PI_SERIALIZATION_ONLY');
    const reasoning = portable ? 'high' : routed.reasoningEffort ?? this.options.reasoning ?? 'medium';
    const events = codexStream(model, normalizeContext(context), { apiKey: fake, signal, transport: 'sse', maxRetries: 0,
      sessionId: String(agent.session.id), reasoning: (reasoning === 'off' ? undefined : reasoning) as SimpleStreamOptions['reasoning'],
      temperature: portable ? undefined : routed.temperature, maxTokens: portable ? undefined : routed.maxTokens,
      fetch: async () => { throw new Error('Network is forbidden during request serialization'); },
      onPayload: (body) => { payload = structuredClone(body) as Record<string, unknown>; throw stopped; },
    });
    for await (const _ of events) { signal?.throwIfAborted(); }
    signal?.throwIfAborted();
    if (!payload) throw new Error('Codex serializer failed before producing a compaction request');
    const withTier = await this.tier.requestHook(String(agent.session.id))(payload, model);
    const transformed = await this.transformPayload(withTier as Record<string, unknown>, {
      messages: options.messages, purpose: options.purpose, sessionId: String(agent.session.id), signal,
    });
    return { model: model.id, portable, payload: transformed, checkpointTexts: checkpoints, sessionId: String(agent.session.id), signal };
  }
}
