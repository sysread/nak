/**
 * Helpers for the message-attachments feature — shared between the
 * composer (picks, pastes, drops), the send path (inlining to Venice),
 * and the message renderer (download links, extracted-text drawer).
 *
 * Nothing in this module touches Supabase or Venice directly — those
 * calls live in `supabase.ts` and `venice.ts`. This file is the place
 * for pure transforms (base64, downscale, size validation) and the
 * `isConsumableBy` predicate that decides whether the pre-send guard
 * should block.
 */
import type { Attachment, NewAttachment } from './supabase';
import type { ModelSpec } from './models';

/**
 * Hard ceiling per file, in bytes. Images over this cap are rejected
 * at add-time; non-image files over the cap are rejected before we
 * round-trip them through Venice's text-parser. 10 MiB is comfortable
 * for phone photos (post-downscale), long PDFs, and source trees;
 * going higher starts to bloat the Postgres WAL and realtime payloads
 * enough to notice.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Aggregate cap across every attachment on a single message. Set to
 * 2.5x the per-file cap so a user can send a handful of typical files
 * without hitting the limit, while keeping the upper bound on
 * payload-per-turn predictable.
 */
export const MAX_MESSAGE_AGGREGATE_BYTES = 25 * 1024 * 1024;

/**
 * Cap on the number of attachments per message. Mostly a UI-sanity
 * guard — the real limits are the size caps above. 20 is high enough
 * that no reasonable use case hits it; a user staring at 20 chips in
 * the composer preview has probably queued up the wrong folder.
 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 20;

/**
 * Long-edge pixel cap for images before persistence. Vision models
 * don't benefit from more — most vision pipelines downsample to
 * ~1024px internally — and storing a 12MP original just means base64
 * bloat on every realtime frame and row fetch. The canvas downscale
 * preserves aspect ratio; images already under this threshold pass
 * through untouched.
 */
const IMAGE_MAX_EDGE_PX = 2048;

/**
 * One attachment the user has queued in the composer but not sent
 * yet. `data_base64` is populated for images (after any downscale) at
 * add time so the send path can inline immediately without a second
 * FileReader round-trip. `extracted_text` is populated for non-image
 * files after the Venice text-parser call returns — a pending value
 * (`null` while the call is in flight) keeps the preview chip's
 * "extracting…" spinner truthful. On send, these fields map directly
 * to NewAttachment for the Supabase insert.
 */
export interface LocalAttachment {
  /** Client-generated id; replaced by the DB id after insert. */
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  data_base64: string;
  /**
   * Text extracted from the file by Venice's /augment/text-parser.
   * Null for images (they're consumed inline on vision tiers, not via
   * extracted text) and for non-image files where the text-parser
   * hasn't returned yet or errored. A chip is considered "ready" when
   * either an image or `extracted_text !== null`.
   */
  extracted_text: string | null;
  /**
   * True while the extracted-text call is in flight, or while an
   * image is being downscaled. Send is blocked until every pending
   * attachment finishes.
   */
  pending: boolean;
  /** If set, the attachment failed to process — render as an error chip. */
  error: string | null;
}

export function isImageMimeType(mime: string): boolean {
  return mime.startsWith('image/');
}

/**
 * Convert a LocalAttachment into the NewAttachment shape the
 * `addAttachments` RPC expects. `position` is caller-assigned so the
 * render order matches the order the user queued them in.
 */
export function toNewAttachment(a: LocalAttachment, position: number): NewAttachment {
  return {
    position,
    filename: a.filename,
    mime_type: a.mime_type,
    size_bytes: a.size_bytes,
    data_base64: a.data_base64,
    extracted_text: a.extracted_text,
  };
}

/**
 * True iff the given attachment can be made visible to the model with
 * the given spec — either an image on a vision tier (inlined as
 * `image_url`), or any attachment whose `extracted_text` is a non-
 * empty string (prepended to the user's text part). Used by both the
 * composer pre-send guard and the send-path content-builder.
 *
 * An empty extracted_text string doesn't count — it means the parser
 * ran but found nothing, so there's no signal for the model to use.
 */
export function isConsumableBy(
  a: Pick<Attachment | LocalAttachment, 'mime_type' | 'extracted_text'>,
  _spec: Pick<ModelSpec, 'supportsVision'>
): boolean {
  // Images are always consumable: vision tiers inline them directly;
  // non-vision tiers receive a note instructing the model to call
  // analyze_image(). The spec parameter is retained for API compatibility
  // but is no longer consulted for the image branch.
  if (isImageMimeType(a.mime_type)) return true;
  if (typeof a.extracted_text === 'string' && a.extracted_text.trim().length > 0) {
    return true;
  }
  return false;
}

/**
 * Human-readable size for chips and download links. Matches the usual
 * binary-prefix convention: 1024-based, two sig-figs under 100, one
 * above. `0 B` for empty files.
 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return kb < 100 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return mb < 100 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

/**
 * Validate one candidate file at add-time. Returns an error message
 * the caller can surface on the preview chip, or null when the file
 * passes. Aggregate/count limits are the caller's job — this function
 * only judges the file in isolation.
 */
export function validateFile(file: File): string | null {
  if (file.size <= 0) return 'Empty file.';
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `Too large (${formatBytes(file.size)}; max ${formatBytes(MAX_ATTACHMENT_BYTES)}).`;
  }
  return null;
}

/**
 * Encode an ArrayBuffer into a base64 string. Used for both the wire
 * payload (PostgREST accepts base64 for bytea columns when the body is
 * JSON) and the data: URIs we hand to Venice for vision inlining.
 *
 * Chunked so a 10MB buffer doesn't blow the argument count on
 * `String.fromCharCode.apply` — that function's limit is
 * implementation-defined and crashes have been reported around 65k
 * bytes. 32KB per chunk stays well under every browser's threshold.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * Inverse of arrayBufferToBase64. Used by the message renderer to
 * turn the stored base64 back into a Blob for download anchor hrefs.
 */
export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

/**
 * Hex-encoded SHA-256 of an arbitrary byte buffer. Used by the
 * recipe-photos path on both the editor side (file picked by the
 * user) and the tools side (image copied out of a conversation
 * attachment) to compute the dedup key the `recipe_image_upsert`
 * RPC expects on `(user_id, sha256)`. The 64-char hex shape is
 * what the schema enforces; lower-case hex matches the convention
 * used elsewhere in the codebase.
 *
 * Web Crypto's SubtleCrypto is available in modern browsers and in
 * Web Worker contexts (the reflection worker bundles tools via this
 * file's exports), so this is safe to call from either.
 */
export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * SHA-256 of a base64 string's decoded bytes. Convenience wrapper
 * around `sha256Hex` for callers (the LLM tool path) that already
 * hold the bytes as base64 - decoding to an ArrayBuffer in one place
 * keeps the call site terse.
 */
export async function sha256HexFromBase64(base64: string): Promise<string> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return sha256Hex(bytes.buffer);
}

/**
 * Downscale an image File to fit within IMAGE_MAX_EDGE_PX on its
 * longest edge, re-encoding as JPEG (for photographic images) or PNG
 * (for images with transparency — detected by a presence of an alpha
 * channel in the input MIME type).
 *
 * When the original fits under the cap, returns the input File
 * unchanged so we don't pay for a canvas round-trip on already-small
 * images. Returns null when the browser can't decode the image
 * (corrupt file, unsupported format); the caller treats that as an
 * error and rejects the attachment.
 *
 * Why canvas instead of a `createImageBitmap` + OffscreenCanvas path:
 * OffscreenCanvas isn't available on Safari < 16.4, and the composer
 * ships to every modern browser. HTMLCanvasElement + drawImage works
 * everywhere we care about. The tradeoff is that the main thread
 * blocks during the paint — acceptable for a one-off on user action.
 */
export async function maybeDownscaleImage(file: File): Promise<File | null> {
  if (!isImageMimeType(file.type)) return file;
  // Browsers reliably decode jpeg/png/webp/gif; SVGs go through
  // untouched (they're vector and tiny already).
  if (file.type === 'image/svg+xml') return file;

  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
    if (longEdge <= IMAGE_MAX_EDGE_PX) return file;
    const scale = IMAGE_MAX_EDGE_PX / longEdge;
    const targetW = Math.round(img.naturalWidth * scale);
    const targetH = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, targetW, targetH);
    // Preserve transparency for PNGs and GIFs by re-encoding as PNG;
    // otherwise JPEG at a high but not perfect quality level for a
    // sensible size/quality tradeoff. WebP would compress tighter
    // still but Safari's encode path has historically had edge cases.
    const keepAlpha = file.type === 'image/png' || file.type === 'image/gif';
    const targetType = keepAlpha ? 'image/png' : 'image/jpeg';
    const blob = await canvasToBlob(canvas, targetType, 0.9);
    if (!blob) return null;
    // Keep the original filename so the user recognises the download;
    // if the extension doesn't match the new MIME type anymore that's
    // acceptable — the Content-Type header is authoritative.
    return new File([blob], file.name, { type: targetType });
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = (): void => resolve(img);
    img.onerror = (): void => reject(new Error('Failed to decode image.'));
    img.src = url;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number
): Promise<Blob | null> {
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

/**
 * Build a data: URI from a mime type + base64. Still used by the recipe-
 * image rendering path (recipe_images remains a base64 store, outside the
 * attachments-storage migration). The message-attachment render path uses
 * signed URLs instead.
 */
export function dataUrlFor(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`;
}

/**
 * One entry in an OpenAI-compatible multimodal content array. Mirrors
 * `ContentPart` in venice.ts — redeclared here so `attachments.ts`
 * doesn't have to reach across to the Venice module. If the Venice
 * shape diverges, update both.
 */
export type WireContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * Build the `content` field of a VeniceMessage for a user turn with
 * attachments. Returns a plain string when no attachments contribute
 * visible content, or a multimodal content array when at least one
 * image is being inlined.
 *
 * Rules:
 *   - Every attachment with non-empty `extracted_text` contributes a
 *     fenced block prepended to the user's text part, tagged with the
 *     filename so the model knows where the excerpt came from. This
 *     runs regardless of tier — extracted text is cheap to include
 *     and often the only way a non-image attachment reaches the
 *     model.
 *   - Every live image attachment becomes an `image_url` content part
 *     IFF the target model supports vision AND the caller resolved a
 *     URL for it in `imageUrls` (a short-lived signed URL into the
 *     attachments bucket - Venice fetches it server-side). On
 *     non-vision tiers, or for an image whose URL couldn't be resolved,
 *     the image is skipped silently (the pre-send guard should have
 *     already blocked; this is a defensive fallback for history replay
 *     when the tier changes mid-conversation, or for an expired image).
 *   - The user's typed `text` is always present as the first part
 *     (or the sole content when there are no images to inline).
 *
 * Callers pass this the model spec for the SEND plus an `imageUrls` map
 * (attachment id -> signed URL) they pre-resolved via
 * `SupabaseService.createAttachmentSignedUrls`. History messages and the
 * just-added user message all render through the same function so the
 * wire format stays consistent across the history. The builder stays a
 * pure transform - all I/O (minting the URLs) happens upstream.
 */
export function buildUserVeniceContent(
  text: string,
  attachments: Array<
    Pick<Attachment, 'id' | 'mime_type' | 'extracted_text' | 'filename' | 'storage_path'>
  > | null | undefined,
  spec: Pick<ModelSpec, 'supportsVision'>,
  imageUrls: ReadonlyMap<string, string>
): string | WireContentPart[] {
  if (!attachments || attachments.length === 0) return text;

  const extractedBlocks = attachments
    .filter((a) => a.extracted_text && a.extracted_text.trim().length > 0)
    .map(
      (a) =>
        // Fenced block tagged with the filename so the model can cite
        // back to the document in its answer. Three-backtick fences
        // match the markdown conventions already in use elsewhere in
        // the prompt; the filename sits on the opener line like a
        // language hint.
        `\`\`\`[${a.filename}]\n${a.extracted_text}\n\`\`\``
    );

  // On non-vision tiers, images are invisible to the model on the wire
  // (inlineImages will be empty below). Prepend a note so the model
  // knows the attachments exist and knows to call analyze_image() to
  // see them. On vision tiers imageNote is null and composedText is
  // identical to the previous behaviour.
  const imageAttachments = attachments.filter((a) => isImageMimeType(a.mime_type));
  const imageNote =
    !spec.supportsVision && imageAttachments.length > 0
      ? `Attached images: [${imageAttachments.map((a) => a.filename).join(', ')}] - call analyze_image() to see them.`
      : null;

  const composedText = [
    imageNote,
    extractedBlocks.length > 0 ? extractedBlocks.join('\n\n') : null,
    text,
  ]
    .filter((s): s is string => s !== null)
    .join('\n\n');

  const inlineImages = spec.supportsVision
    ? attachments.filter(
        (a) =>
          isImageMimeType(a.mime_type) &&
          a.storage_path !== null &&
          imageUrls.has(a.id)
      )
    : [];

  if (inlineImages.length === 0) return composedText;

  const parts: WireContentPart[] = [{ type: 'text', text: composedText }];
  for (const img of inlineImages) {
    parts.push({
      type: 'image_url',
      image_url: { url: imageUrls.get(img.id) as string },
    });
  }
  return parts;
}
