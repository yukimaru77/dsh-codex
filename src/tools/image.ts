import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment';
import type { AuthFacade } from './auth.ts';
import { resolveToolAuth } from './auth.ts';
import { CodexImagesClient, FetchHttpTransport } from './vendor/image/client/codex-images.ts';
import type { GenerateImageRequest, HttpTransport } from './vendor/image/types.ts';

export type { GenerateImageRequest } from './vendor/image/types.ts';
export interface PreparedImageOutput {
  /** MUST atomically create (never overwrite), using DSH execution-world fs/sandbox permissions. */
  save(bytes: Uint8Array, signal: AbortSignal): Promise<string>;
}
/** Host capabilities: deliberately no local filesystem fallback or Pi global agent directory. */
export interface ImageHost {
  signal: AbortSignal;
  /** Must use a real user approval channel; model args cannot supply consent. Missing = deny. */
  approveUpload?(paths: readonly string[]): Promise<boolean>;
  /** Reads only through DSH fs; bound must be enforced by backend, not after unbounded reads. */
  readReference(path: string, maximumBytes: number): Promise<Uint8Array>;
  /** DSH attachment service fully decodes, validates dimensions and durably stores the image. */
  saveAttachment(bytes: Uint8Array, mediaType: ImageMediaType): Promise<ImageAttachmentRef>;
  readAttachment(ref: ImageAttachmentRef): Promise<Uint8Array>;
  /** Optional permission-aware binary writer. Must validate/approve BEFORE generation. */
  prepareOutput?(request: GenerateImageRequest): Promise<PreparedImageOutput | undefined>;
  transport?: HttpTransport;
}

export function validateImageArgs(value: unknown): asserts value is GenerateImageRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Image arguments must be an object.');
  const r = value as GenerateImageRequest;
  if (typeof r.prompt !== 'string' || !r.prompt.trim() || r.prompt.trim().length > 32_000) throw new Error('prompt must contain 1–32000 characters.');
  if (r.size !== undefined && !['auto', '1024x1024', '1536x1024', '1024x1536'].includes(r.size)) throw new Error('Invalid image size.');
  if (r.quality !== undefined && !['auto', 'low', 'medium', 'high'].includes(r.quality)) throw new Error('Invalid image quality.');
  if (r.save !== undefined && !['auto', 'none', 'project', 'global'].includes(r.save)) throw new Error('Invalid image save mode.');
  if (r.outputPath !== undefined && (typeof r.outputPath !== 'string' || !r.outputPath.trim() || r.outputPath.includes('\0') || !r.outputPath.toLowerCase().endsWith('.png'))) throw new Error('outputPath must be a nonempty PNG path.');
  if (r.save === 'none' && r.outputPath !== undefined) throw new Error('save:none conflicts with outputPath.');
  if (r.referencedImagePaths !== undefined && (!Array.isArray(r.referencedImagePaths) || r.referencedImagePaths.length > 5 || r.referencedImagePaths.some(p => typeof p !== 'string' || !p.trim()))) throw new Error('Expected at most five nonempty reference image paths.');
}

/** Reuses the installed Pi image client's endpoints, retry policy, parser and sanitized errors. */
export async function executeImage(auth: AuthFacade, request: GenerateImageRequest, host: ImageHost) {
  validateImageArgs(request);
  host.signal.throwIfAborted();
  // Freeze copies before approvals: neither a mutable caller nor a later cwd switch may change consent.
  const args = { ...request, prompt: request.prompt.trim(), referencedImagePaths: [...request.referencedImagePaths ?? []] };
  if (args.save === 'global') throw new Error('Global Pi image output is not available in DSH. Use attachments or a workspace path.');
  const needsFile = args.outputPath !== undefined || args.save === 'project';
  if (needsFile && !host.prepareOutput) throw new Error('This DSH composition has no permission-aware binary writer; use save:none (durable attachment). No image request was sent.');
  const output = args.save !== 'none' && host.prepareOutput ? await host.prepareOutput(args) : undefined;
  if (needsFile && !output) throw new Error('Secure workspace binary output is unavailable. No image request was sent.');
  host.signal.throwIfAborted();
  const images: string[] = [];
  if (args.referencedImagePaths.length) {
    if (!host.approveUpload || await host.approveUpload(Object.freeze([...args.referencedImagePaths])) !== true) throw new Error('Reference image upload requires explicit user approval. No image request was sent.');
    host.signal.throwIfAborted();
    let totalSource = 0, totalEncoded = 0;
    for (const path of args.referencedImagePaths) {
      const bytes = await host.readReference(path, 20 * 1024 * 1024);
      totalSource += bytes.byteLength;
      if (bytes.byteLength > 20 * 1024 * 1024 || totalSource > 50 * 1024 * 1024) throw new Error('Reference image source limit exceeded.');
      const mime = sniffReference(bytes);
      host.signal.throwIfAborted();
      // DSH's full decoder/normalizer is authoritative; never upload unvalidated file bytes.
      const ref = await host.saveAttachment(bytes, mime);
      if (ref.bytes > 15 * 1024 * 1024) throw new Error('Normalized reference image exceeds the upload size limit.');
      host.signal.throwIfAborted();
      const normalized = await host.readAttachment(ref);
      host.signal.throwIfAborted();
      const dataUrl = `data:${ref.mediaType};base64,${Buffer.from(normalized).toString('base64')}`;
      totalEncoded += dataUrl.length;
      if (dataUrl.length > 20 * 1024 * 1024 || totalEncoded > 60 * 1024 * 1024) throw new Error('Reference image upload size limit exceeded.');
      images.push(dataUrl);
    }
  }
  host.signal.throwIfAborted();
  const credential = await resolveToolAuth(auth);
  host.signal.throwIfAborted();
  const client = new CodexImagesClient(host.transport ?? new FetchHttpTransport());
  const input = { prompt: args.prompt, quality: args.quality ?? 'auto', size: args.size ?? 'auto' };
  const generated = images.length ? await client.edit({ ...input, images }, credential, host.signal) : await client.generate(input, credential, host.signal);
  host.signal.throwIfAborted();
  const bytes = decodePngBase64(generated.base64);
  const attachment = await host.saveAttachment(bytes, 'image/png');
  host.signal.throwIfAborted();
  const savedPath = output ? await output.save(bytes, host.signal) : undefined;
  return {
    model: 'gpt-image-2' as const, attachment,
    ...(savedPath === undefined ? {} : { savedPath }),
    ...(generated.created === undefined ? {} : { created: generated.created }),
    ...(generated.quality === undefined ? {} : { quality: generated.quality }),
    ...(generated.size === undefined ? {} : { size: generated.size }),
  };
}

// Adapted from Pi image-store.ts (MIT, vendor/image/LICENSE). Local ImageStore is deliberately NOT used.
export function decodePngBase64(value: string, maximumBytes = 25 * 1024 * 1024): Buffer {
  const encoded = value.trim();
  if (!encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || Math.floor(encoded.length * 3 / 4) > maximumBytes + 2) throw new Error('Invalid generated PNG.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > maximumBytes || bytes.toString('base64') !== encoded || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid generated PNG.');
  return bytes;
}
function sniffReference(bytes: Uint8Array): ImageMediaType {
  if (Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (Buffer.from(bytes.subarray(0,4)).toString() === 'RIFF' && Buffer.from(bytes.subarray(8,12)).toString() === 'WEBP') return 'image/webp';
  throw new Error('Reference images must be PNG, JPEG or WebP.');
}
