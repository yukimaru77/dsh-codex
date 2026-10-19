import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import type { Context } from '@deepseek-ai/cordis';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SummarizationInput, SummaryResult } from './vendor/dsh-compaction-basic/summarizer-types.ts';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { requestNativeCompaction, type CompactionAuth } from './compact/transport.ts';
import { checkpointTexts, decodeCheckpoint } from './compact/checkpoint.ts';
import { portableSummary } from './compact/portable.ts';
import { abortable } from './compact/portable-core.ts';
import type {} from './service.ts';

/** Preset-scoped replacement for compaction-basic; inherits all normal DSH policies. */
export default class PiCompatCompaction extends BasicCompactionEngine {
  static inject = [...BasicCompactionEngine.inject, 'piCompat'];
  private readonly converting = new AsyncLocalStorage<string>();
  constructor(ctx: Context, config?: ConstructorParameters<typeof BasicCompactionEngine>[1]) {
    super(ctx, config);
    // Commit a normal DSH compaction transaction BEFORE request admission. Never
    // mutate frozen request messages or the durable log during agent/request.
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next();
      if (decision.kind === 'reject') return decision;
      signal.throwIfAborted();
      for (const seq of [...agent.session.surface.nodes]) {
        const event = agent.session.eventAt(seq);
        if (!event) continue;
        const message = agent.session.deriveEventMessage(event);
        const texts = checkpointTexts([message]);
        if (!texts.length) continue;
        await this.converting.run(texts[0], () => this.compactRegion(seq, seq, agent, signal));
      }
      return decision;
    }, { prepend: true });
  }
  override async compactIfNeeded(...args: Parameters<BasicCompactionEngine['compactIfNeeded']>) {
    const cap = await this.ctx.piCompat.settings.capacityFor(String(args[0].session.id));
    return this.ctx.piCompat.adapter.withContextCapacity(cap, () => super.compactIfNeeded(...args));
  }
  protected override async summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(900_000)]);
    signal.throwIfAborted();
    const compat = this.ctx.piCompat;
    let lease: Promise<CompactionAuth> | undefined;
    const getAuth = () => lease ??= abortable(compat.broker.acquire('compact', '', signal), signal!).then(auth => ({
      accessToken: auth.apiKey, accountId: auth.accountId, headers: { ...auth.headers },
    }));
    const converting = this.converting.getStore();
    if (converting) {
      const trusted = checkpointTexts(input.messages);
      if (trusted.length !== 1 || trusted[0] !== converting) throw new Error('Portable checkpoint lineage mismatch');
      return portableSummary(decodeCheckpoint(converting)!.replacementHistory, compat.broker, await getAuth(), signal);
    }
    if (!compat.nativeCompaction) {
      if (checkpointTexts(input.messages).length) throw new Error('Cannot use ordinary text summarization on an opaque checkpoint.');
      return super.summarize(input, agent, signal);
    }
    const prepared = await compat.adapter.nativeRequest(input, agent, signal);
    if (!prepared) throw new Error('Codex/Luna compaction preparation failed; history was not replaced.');
    const result = await requestNativeCompaction({ ...prepared, signal }, { getAuth });
    return portableSummary(result.replacementHistory, compat.broker, await getAuth(), signal, undefined, result.usage);
  }
}
