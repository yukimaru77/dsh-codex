import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-attachment';
import type {} from '@deepseek-ai/dsh-working-directory';
import type {} from '@deepseek-ai/dsh-user-approval';
import { executeWebRun, type WebRunArgs } from './web.ts';
import { captureImageOutput } from './output.ts';
import { executeImage, type GenerateImageRequest, type ImageHost, type PreparedImageOutput } from './image.ts';
import type { AuthFacade } from './auth.ts';
import type { HttpTransport } from './vendor/image/types.ts';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';

export { executeWebRun, validateWebArgs } from './web.ts';
export { executeImage, validateImageArgs, decodePngBase64 } from './image.ts';
export type { AuthFacade, CarrierModel, ResolvedAuth } from './auth.ts';
export type { WebRunArgs, WebOptions } from './web.ts';
export type { ImageHost, GenerateImageRequest, PreparedImageOutput } from './image.ts';
export type { HttpTransport } from './vendor/image/types.ts';

export interface ToolAdapterOptions {
  /** Same host facade used by chat/compaction; callback may bind the host's request-local selection. */
  auth: AuthFacade | ((exec: ToolRunContext) => AuthFacade | Promise<AuthFacade>);
  webModel?: string;
  webFetch?: typeof fetch;
  imageTransport?: HttpTransport;
  /** Override the default same-world confined POSIX writer with a trusted host capability. */
  prepareImageOutput?: (ctx: Context, exec: ToolRunContext, request: GenerateImageRequest) => Promise<PreparedImageOutput>;
}
const string = { type: 'string', required: true } as const;
const query = { type: 'array', items: { type: 'object', additionalProperties: true, properties: {
  q: string, recency: { type: 'number' }, domains: { type: 'array', items: { type: 'string' } },
} } } as const;
const webParameters = {
  search_query: query, image_query: query,
  open: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { ref_id: string, lineno: { type: 'number' } } } },
  click: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { ref_id: string, id: { type: 'number', required: true } } } },
  find: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { ref_id: string, pattern: string } } },
  response_length: { type: 'string', enum: ['short', 'medium', 'long'] },
  settings: { type: 'object', additionalProperties: true, properties: { search_context_size: { type: 'string', enum: ['low', 'medium', 'high'] } } },
} as const;
const imageParameters = {
  prompt: string,
  referencedImagePaths: { type: 'array', items: { type: 'string' } },
  outputPath: { type: 'string', description: 'PNG path in DSH execution world; requires host binary writer. Never a Pi global path.' },
  save: { type: 'string', enum: ['auto', 'none', 'project', 'global'], description: 'auto saves a workspace PNG when secure DSH export is available, otherwise attachment only; none is attachment only; global is unavailable.' },
  size: { type: 'string', enum: ['auto', '1024x1024', '1536x1024', '1024x1536'] },
  quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'] },
} as const;

/** Register on agent.ctx for per-agent shadowing/lifecycle. No provider is registered. */
export function registerTools(ctx: Context, options: ToolAdapterOptions): () => void {
  const authFor = (exec: ToolRunContext) => typeof options.auth === 'function' ? options.auth(exec) : options.auth;
  const disposeWeb = ctx.tools.register(defineTool({
    name: 'web_run', description: 'Search/open web. Supports search_query, image_query, open, click and find. Use returned turn refs in subsequent calls; cite Markdown result URLs in final answers.',
    parameters: webParameters,
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: string, details: { type: 'json', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('web_run requires an owning DSH agent/session.');
      const result = await executeWebRun(await authFor(exec), args as WebRunArgs, {
        sessionId: exec.agent.session.id, signal: exec.signal,
        ...(options.webModel ? { model: options.webModel } : {}),
        ...(options.webFetch ? { fetch: options.webFetch } : {}),
      });
      return { text: result.text, details: result.details as JsonValue };
    },
  }));
  let disposeImage: () => void;
  try {
    disposeImage = ctx.tools.register(defineTool({
      name: 'codex_generate_image', description: 'Generate or edit one PNG with gpt-image-2 using Codex. Only call for an explicit user image request. Reference uploads require user approval. Returns a durable DSH image attachment; file output requires a host permission-aware binary writer.',
      parameters: imageParameters,
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          model: string, attachment: { type: 'object', required: true, additionalProperties: false, properties: {
            attachmentId: string, mediaType: { type: 'string', required: true, enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
            bytes: { type: 'integer', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
            name: { type: 'string' }, originalDimensions: { type: 'object', additionalProperties: false, properties: { width: { type: 'integer', required: true }, height: { type: 'integer', required: true } } },
          } }, savedPath: { type: 'string' },
          created: { type: 'number' }, quality: { type: 'string' }, size: { type: 'string' },
        } },
        render: (_args, value) => [
          { type: 'text', text: value.savedPath ? `Generated PNG: ${value.savedPath}` : 'Generated image saved as a durable DSH attachment (no workspace file written).' },
          { type: 'image', attachment: value.attachment as Awaited<ReturnType<typeof executeImage>>['attachment'] },
        ],
      },
      async execute(args, exec) {
        const host = await createDshImageHost(ctx, exec, options);
        return executeImage(await authFor(exec), args as GenerateImageRequest, host);
      },
    }));
  } catch (error) { disposeWeb(); throw error; }
  return () => { disposeImage(); disposeWeb(); };
}

/** Capture DSH capabilities/cwd once. Never interpret a backend path with node:fs. */
export async function createDshImageHost(ctx: Context, exec: ToolRunContext, options: Pick<ToolAdapterOptions, 'prepareImageOutput' | 'imageTransport'> = {}): Promise<ImageHost> {
  const attachments = ctx.get('attachments');
  if (!attachments) throw new Error('Image generation requires the DSH attachment service. No image request was sent.');
  if (!exec.agent) throw new Error('Image generation requires an owning DSH agent.');
  const fs = ctx.get('fs');
  // Cwd is needed only for references; capture it lazily once, before the approval dialog.
  const request = exec.arguments as GenerateImageRequest;
  const cwd = request.referencedImagePaths?.length
    ? await ctx.workingDirectory.ensure(exec.agent, exec.signal) : undefined;
  const approver = ctx.get('approval');
  const prepareOutput = options.prepareImageOutput
    ? (r: GenerateImageRequest) => options.prepareImageOutput!(ctx, exec, r)
    : request.save === 'none' || request.save === 'global' ? undefined : await captureImageOutput(ctx, exec);
  return {
    signal: exec.signal,
    approveUpload: async paths => {
      if (!approver || !exec.agent || !fs || cwd === undefined) return false;
      return await approver.request({ agent: exec.agent, callId: exec.callId, toolName: 'codex_generate_image', signal: exec.signal,
        reason: `Upload these reference images from DSH workspace ${cwd} to OpenAI Codex: ${paths.join(', ')}` }) === 'allowed-once';
    },
    async readReference(path, maximumBytes) {
      if (!fs || cwd === undefined) throw new Error('No DSH filesystem/cwd for reference images.');
      const target = await fs.resolve(path, { cwd, signal: exec.signal });
      const info = await fs.stat(target, exec.signal);
      if (!info || info.type !== 'file') throw new Error('Reference image must be a regular file.');
      return fs.readBytes(target, exec.signal, maximumBytes);
    },
    saveAttachment: (data, mediaType) => attachments.saveImage({ data, mediaType }),
    readAttachment: async ref => (await attachments.readImage(ref, exec.signal)).data,
    ...(options.imageTransport ? { transport: options.imageTransport } : {}),
    ...(prepareOutput ? { prepareOutput } : {}),
  };
}
