// Shared machinery for the image-op tools (edit_image, upscale_image,
// remove_background) and the analyze_image lookup they all need.
//
// Why this exists: the three edit-family tools are the same pipeline with a
// different Venice endpoint at the middle - resolve args, cap check, find
// the source attachment in the thread, fetch its bytes, call Venice, guard
// the output size, hand the orchestrator the __generated_image envelope.
// Only the endpoint call and the model resolution differ, so everything
// else lives here.
//
// The lookup is a careful extraction from analyze_image (the vision tool
// that set the pattern): thread-scoped ownership rides the validated
// threadId, and the miss diagnostics are load-bearing - each wording was
// written to redirect the model productively (see
// supabase/functions/tests/attachment-vision-tools.test.ts, which pins the
// analyze_image renderings byte-for-byte).

import type { SupabaseClient } from '@supabase/supabase-js';
import { requireThreadId, type ToolContext } from '../performToolCall.ts';
import {
  GENERATED_IMAGE_RESULT_KEY,
  type GeneratedImagePayload,
} from './_generated_image.ts';

// --- Attachment lookup ------------------------------------------------------

interface ImageAttachmentRow {
  id: string;
  filename: string;
  storage_path: string | null;
  mime_type: string;
}

/**
 * Explain a filename that exists in the thread but isn't an image.
 *
 * Without this the tool reported "No image attachment named X in this
 * thread" for a PDF the user had plainly attached, which is FALSE - the
 * attachment is right there. The model read that as "the file is gone",
 * told the user it couldn't read PDFs, and stopped. Naming what the file
 * actually is, and which lever reaches it, is what turns a dead end into a
 * redirect.
 *
 * `toolName` parameterizes the one tool-name-bearing phrase so each caller
 * reports its own limitation; the analyze_pdf_page redirect is common to
 * every image tool (a PDF page is reachable the same way from any of them).
 */
async function describeNonImageMatch(
  ctx: ToolContext,
  filename: string,
  toolName: string,
): Promise<string | null> {
  const { data } = await ctx.adminClient
    .from('message_attachments')
    .select('mime_type, page_count, messages!inner(thread_id)')
    .eq('messages.thread_id', requireThreadId(ctx))
    .eq('filename', filename)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ mime_type: string; page_count: number | null }>();
  if (!data) return null;

  const base =
    `"${filename}" is in this conversation but it is not an image ` +
    `(${data.mime_type}), so ${toolName} cannot read it.`;
  if (typeof data.page_count === 'number' && data.page_count > 0) {
    return (
      `${base} Its text was extracted at upload time and is inlined in the ` +
      `user turn where it was attached - read it there. To LOOK at a page ` +
      `(scans, charts, diagrams, layout, signatures), call ` +
      `analyze_pdf_page(filename, page, query); the document has ` +
      `${data.page_count} pages.`
    );
  }
  return (
    `${base} Its text was extracted at upload time and is inlined in the ` +
    `user turn where it was attached - read it there rather than calling a tool.`
  );
}

/**
 * Find the most recent image attachment with this filename in the current
 * thread, or throw a model-actionable error. The error text distinguishes
 * three miss shapes: the file exists but is not an image (redirect to the
 * right lever), the image's storage object was deleted (its data is gone -
 * do not retry), and no such file at all.
 *
 * Thread-scoped lookup: message_attachments inherits ownership from
 * messages -> threads, and threadId was already validated against userId
 * at /stream entry, so a filter on messages.thread_id is the correct
 * scope.
 *
 * RLS OFF: scoped via parent thread (validated upstream). Join
 * message_attachments to messages so the thread_id check rides
 * on the relationship. Take the most recent matching image.
 */
export async function findImageAttachmentByFilename(
  ctx: ToolContext,
  filename: string,
  toolName: string,
): Promise<ImageAttachmentRow> {
  const { data, error } = await ctx.adminClient
    .from('message_attachments')
    .select('id, filename, storage_path, mime_type, messages!inner(thread_id)')
    .eq('messages.thread_id', requireThreadId(ctx))
    .eq('filename', filename)
    .like('mime_type', 'image/%')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<ImageAttachmentRow>();
  if (error) throw new Error(`findImageAttachmentByFilename failed: ${error.message}`);
  if (!data) {
    // The `image/%` filter above means a miss can mean two very different
    // things. Distinguish them before answering, or a non-image
    // attachment gets reported as absent.
    const nonImage = await describeNonImageMatch(ctx, filename, toolName);
    throw new Error(nonImage ?? `No image attachment named "${filename}" in this thread.`);
  }
  return data;
}

// --- Attachment bytes -------------------------------------------------------

/**
 * Download one object from the `attachments` bucket as RAW base64 (no
 * `data:` prefix) plus its mime type. This is the edit-family twin of
 * attachmentObjectAsDataUrl in ./_vision.ts - same deliberate inlining
 * (Venice cannot reach the local signed URLs; see that function's rationale),
 * different encoding because /image/upscale rejects data URIs while the
 * other two endpoints accept them. One download, two encodings.
 */
export async function attachmentObjectAsBase64(
  adminClient: SupabaseClient,
  storagePath: string,
  mimeType: string,
  label: string,
): Promise<{ base64: string; mimeType: string }> {
  const { data: blob, error } = await adminClient.storage
    .from('attachments')
    .download(storagePath);
  if (error || !blob) {
    throw new Error(`${label} could not be downloaded. Try again.`);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return { base64: btoa(binary), mimeType };
}

// --- Output-size guard ------------------------------------------------------
//
// Venice's upscale output is unbounded by the request: a 4x of a 2048px
// chat upload is an 8192px PNG, plausibly tens of MB photographic. The
// attachments bucket rejects files over 50MiB (supabase/config.toml), and
// attachGeneratedImages swallows upload failures - an oversized result
// would report success to the model while the image never lands anywhere.
// So the tool guards the size itself, in two layers: a pre-flight decode
// that refuses a scale bound to exceed the budget BEFORE Venice is paid,
// and a post-hoc byte check on the returned bytes as the backstop for
// formats the pre-flight cannot decode (HEIC/AVIF).

/** Safe attachment size: 45MiB, margin under the bucket's 50MiB limit. */
export const IMAGE_OP_SAFE_OUTPUT_BYTES = 45 * 1024 * 1024;
/**
 * Worst-case encoded bytes per output pixel assumed by the pre-flight:
 * photographic PNG rarely exceeds ~1.5 bytes/px (filtered, not raw 3).
 * Conservative in the refusal direction - a refusal at this floor can be
 * wrong for a compressible image, never for an incompressible one, and the
 * post-hoc check catches any misestimate.
 */
const PRE_FLIGHT_BYTES_PER_PX = 1.5;

export function preFlightOutputBudgetPx(): number {
  return Math.floor(IMAGE_OP_SAFE_OUTPUT_BYTES / PRE_FLIGHT_BYTES_PER_PX);
}

/**
 * Read pixel dimensions from the image's own header - no decode, no deps.
 * Covers the three formats chat uploads actually produce (the composer
 * re-encodes everything to JPEG or PNG, and WebP arrives from prior image
 * ops); anything else (HEIC, AVIF, SVG) returns null and skips pre-flight.
 */
export function decodeImageDimensions(bytes: Uint8Array): {
  width: number;
  height: number;
} | null {
  // PNG: 8-byte signature, then IHDR chunk - length(4) type(4) then
  // width/height as big-endian uint32 at offsets 16 and 20.
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    return {
      width: ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0,
      height: ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0,
    };
  }
  // JPEG: scan the segment chain for a Start-Of-Frame marker.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let off = 2;
    while (off + 9 < bytes.length) {
      if (bytes[off] !== 0xff) break;
      const marker = bytes[off + 1];
      // SOF0-SOF15 except DHT (C4), JPG (C8), DAC (CC) carry dimensions.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          height: (bytes[off + 5] << 8) | bytes[off + 6],
          width: (bytes[off + 7] << 8) | bytes[off + 8],
        };
      }
      const segLen = (bytes[off + 2] << 8) | bytes[off + 3];
      if (segLen < 2) break;
      off += 2 + segLen;
    }
    return null;
  }
  // WebP: RIFF container, VP8X (extended) / VP8 (lossy) / VP8L (lossless)
  // chunks each carry dimensions in their own packing.
  if (
    bytes.length >= 30 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunk === 'VP8X') {
      // 24-bit little-endian canvas minus one, at offsets 24 and 27.
      const read24 = (o: number) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) + 1;
      return { width: read24(24), height: read24(27) };
    }
    if (chunk === 'VP8 ') {
      // 14-bit values, little-endian at offsets 26 and 28.
      return {
        width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
        height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
      };
    }
    if (chunk === 'VP8L') {
      // Packed 14-bit width-1 / height-1 starting at byte 21.
      const b = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

/**
 * Pre-flight an upscale: with the source's dimensions known, refuse a
 * scale whose output must exceed the safe byte budget, so the failed
 * attempt costs nothing. Returns null when the pre-flight passes (or the
 * format is undecodable - then the post-hoc check is the only guard), or
 * a tool-error message telling the model what WILL succeed.
 */
export function upscalePreFlightMessage(
  sourceBytes: Uint8Array,
  scale: number
): string | null {
  const dims = decodeImageDimensions(sourceBytes);
  if (!dims || dims.width === 0 || dims.height === 0) return null;
  const outputPx = dims.width * dims.height * scale * scale;
  if (outputPx <= preFlightOutputBudgetPx()) return null;
  const srcPx = `${dims.width}x${dims.height}`;
  if (scale > 2) {
    return (
      `Upscaling "${srcPx}" by ${scale}x would produce an image too large to ` +
      `store (about ${(outputPx / 1_000_000).toFixed(0)}MP). ` +
      `Retry with scale 2 instead.`
    );
  }
  return (
    `"${srcPx}" is already too large to upscale further - the result would ` +
    `exceed the storage limit. Use scale 2 on a smaller image instead.`
  );
}

/**
 * Post-hoc guard on the returned image bytes: throw (with achievable
 * guidance) when the result could not be stored. Backstops the pre-flight
 * for undecodable formats and bounds edit/bg-remove outputs too.
 */
export function assertResultStorable(imageBase64: string, scale?: number): void {
  const padding = imageBase64.endsWith('==') ? 2 : imageBase64.endsWith('=') ? 1 : 0;
  const sizeBytes = Math.floor((imageBase64.length * 3) / 4) - padding;
  if (sizeBytes <= IMAGE_OP_SAFE_OUTPUT_BYTES) return;
  const mb = (sizeBytes / (1024 * 1024)).toFixed(0);
  const guidance =
    scale !== undefined && scale > 2
      ? ' Retry with scale 2 instead.'
      : ' The source image is too large for this operation.';
  throw new Error(
    `The edited image (${mb}MB) exceeds the attachment storage limit and ` +
      `could not be saved.${guidance}`
  );
}

// --- Result envelope --------------------------------------------------------

/**
 * Byte length of a base64 string (no `data:` prefix) - mirrors
 * generate_image.ts's local helper; duplicated here because the edit tools
 * live in this module and generate_image stays an untouched mirror.
 */
export function base64ByteLength(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/**
 * Mint a collision-proof filename: two parallel same-tool calls could
 * otherwise mint the same millisecond (generate_image uses bare
 * Date.now()); downstream lookups resolve most-recent-by-created_at, so an
 * ambiguous filename would be a silent correctness hazard. The random
 * suffix closes that for every image-op tool.
 */
export function mintImageFilename(prefix: string, ext: string): string {
  const rand = crypto.randomUUID().slice(0, 4);
  return `${prefix}-${Date.now()}-${rand}.${ext}`;
}

/**
 * Build the tool-return envelope the orchestrator expects: a compact
 * model-visible descriptor plus the heavy payload under
 * GENERATED_IMAGE_RESULT_KEY, which the orchestrator harvests for the
 * message_attachments row and strips from the model-visible tool result
 * (see _generated_image.ts for why the base64 never rides the tool row).
 * Edit-family results omit width/height - the server never knows the
 * output pixel dimensions - and the image card falls back to a square
 * placeholder (existing code path).
 */
export function buildImageOpResult(opts: {
  filename: string;
  mimeType: string;
  imageBase64: string;
  note: string;
}): Record<string, unknown> {
  const ext = opts.mimeType.split('/')[1] ?? 'png';
  const payload: GeneratedImagePayload = {
    filename: opts.filename,
    mime_type: opts.mimeType,
    data_base64: opts.imageBase64,
    size_bytes: base64ByteLength(opts.imageBase64),
  };
  return {
    filename: opts.filename,
    format: ext,
    note: opts.note,
    [GENERATED_IMAGE_RESULT_KEY]: payload,
  };
}
