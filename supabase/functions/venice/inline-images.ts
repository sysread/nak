// Inline owned image attachments as data URIs at /stream body receipt
// (image-retry-data-uri-plan.md, Change 2).
//
// The browser builds the chat wire body with image attachments riding as
// signed Storage URLs, which Venice fetches server-side on every turn
// for the life of the thread. Any slow or erroring fetch 400s the whole
// turn (prod incident 2026-11-02: a fresh, valid, public URL failed
// transiently). This phase replaces those parts with `data:` URIs
// downloaded service-role, so the per-turn Venice fetch dependency
// disappears for owned images.
//
// Every failure degrades to the signed URL - no match, ownership
// mismatch, download error, timeout, byte cap, phase deadline - so the
// worst case is exactly the pre-inline behavior. The phase runs inside
// the synchronous envelope POST, so it is bounded in both bytes and
// time: hard-stop byte cap (newest-first walk, so eviction takes the
// oldest history images), per-download timeout, whole-phase deadline.

import type { SupabaseClient } from '@supabase/supabase-js';
import { attachmentObjectAsDataUrl } from './tools/_vision.ts';

// Signed URL shape produced by Supabase Storage createSignedUrls for the
// attachments bucket. The path mirrors the storage_path layout
// `<user_id>/<attachment_id>/<filename>` (schema.sql, message_attachments).
// The literal prefix is Supabase's standard signed-URL shape and appears
// nowhere else in-repo; a test pins it against a real minted URL.
const SIGNED_IMAGE_URL_RE =
  /^\/storage\/v1\/object\/sign\/attachments\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/(.+)$/i;

export interface ImagePartRef {
  /**
   * The content-part array holding the image_url part (the message's
   * `content` array). Mutation happens in place at `partIndex`.
   */
  parts: unknown[];
  partIndex: number;
  url: string;
  attachmentId: string;
  /** Bucket-relative path parsed from the URL (percent-decoded). */
  storagePath: string;
}

/**
 * Pure walker: every `image_url` content part whose URL matches the
 * signed-attachments shape. Nothing else in the codebase traverses
 * message content parts (the _shared/venice.ts walkers operate on
 * top-level body fields), so this is genuinely new surface. Exported for
 * unit tests; production callers use inlineAttachmentImages.
 */
export function walkImageParts(
  wireBody: Record<string, unknown>
): ImagePartRef[] {
  const messages = wireBody.messages;
  if (!Array.isArray(messages)) return [];
  const refs: ImagePartRef[] = [];
  for (const message of messages) {
    const content = (message as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (let i = 0; i < content.length; i += 1) {
      const part = content[i] as
        | { type?: unknown; image_url?: { url?: unknown } }
        | null;
      if (part?.type !== 'image_url') continue;
      const url = part.image_url?.url;
      if (typeof url !== 'string') continue;
      const parsed = parseSignedImageUrl(url);
      if (!parsed) continue;
      refs.push({
        parts: content,
        partIndex: i,
        url,
        attachmentId: parsed.attachmentId,
        storagePath: parsed.storagePath,
      });
    }
  }
  return refs;
}

/**
 * Parse a signed attachments URL into its attachment id and
 * bucket-relative storage path. Returns null for anything else (remote
 * hosts we do not own, data URIs, other buckets) - those parts pass
 * through untouched.
 */
export function parseSignedImageUrl(
  url: string
): { attachmentId: string; storagePath: string } | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const match = SIGNED_IMAGE_URL_RE.exec(pathname);
  if (!match) return null;
  let tail: string;
  try {
    tail = decodeURIComponent(match[3]);
  } catch {
    tail = match[3];
  }
  // storage_path is the FULL bucket key <user_id>/<attachment_id>/<filename>.
  return {
    attachmentId: match[2],
    storagePath: `${match[1]}/${match[2]}/${tail}`,
  };
}

export interface InlineResult {
  /** Parts swapped to data URIs. */
  inlined: number;
  /** Raw bytes (pre-base64) of the inlined images. */
  bytesInlined: number;
}

export interface InlineOpts {
  /**
   * Hard stop: once this many raw bytes have been inlined, the walk
   * ends and every remaining (older) part keeps its signed URL.
   */
  byteCap?: number;
  /** Whole-phase wall clock in ms (the walk is synchronous). */
  phaseDeadlineMs?: number;
  /** Per-download wall clock in ms; a hung download degrades that part. */
  perDownloadTimeoutMs?: number;
  /**
   * Download override (tests). Defaults to attachmentObjectAsDataUrl
   * with the attachment row's mime type.
   */
  download?: (
    admin: SupabaseClient,
    storagePath: string,
    mimeType: string,
    label: string
  ) => Promise<string>;
}

const BYTE_CAP = 8 * 1024 * 1024;
const PHASE_DEADLINE_MS = 15_000;
const PER_DOWNLOAD_TIMEOUT_MS = 10_000;

/**
 * Swap every OWNED image part in the wire body to a data URI, in place.
 *
 * "Owned" is the thread-scoped idiom of findImageAttachmentByFilename
 * (tools/_image_ops.ts): the attachment id parsed from the URL must
 * resolve to a live message_attachments row in THIS thread (service role
 * bypasses RLS, so the thread filter is what closes the cross-user hole;
 * the thread itself was already validated against the caller at /stream
 * entry by resolveStreamContext) AND the row's storage_path must equal
 * the path in the URL.
 *
 * Never throws: any failure is logged and left as a signed URL, which
 * is the pre-inline behavior. Owned images include generated ones -
 * both pastes and generated images are message_attachments rows with
 * the same Venice-fetch risk.
 */
export async function inlineAttachmentImages(
  admin: SupabaseClient,
  wireBody: Record<string, unknown>,
  threadId: string,
  opts: InlineOpts = {}
): Promise<InlineResult> {
  const byteCap = opts.byteCap ?? BYTE_CAP;
  const phaseDeadlineMs = opts.phaseDeadlineMs ?? PHASE_DEADLINE_MS;
  const perDownloadTimeoutMs =
    opts.perDownloadTimeoutMs ?? PER_DOWNLOAD_TIMEOUT_MS;
  const download = opts.download ?? attachmentObjectAsDataUrl;

  const refs = walkImageParts(wireBody);
  if (refs.length === 0) return { inlined: 0, bytesInlined: 0 };

  // One batched lookup for all candidate ids (the walk can carry many
  // parts across a long history). Thread-scoped per the idiom above.
  const ids = [...new Set(refs.map((r) => r.attachmentId))];
  const { data, error } = await admin
    .from('message_attachments')
    .select('id, storage_path, mime_type, size_bytes, messages!inner(thread_id)')
    .in('id', ids)
    .eq('messages.thread_id', threadId);
  if (error) {
    console.warn(`[inline-images] ownership lookup failed: ${error.message}`);
    return { inlined: 0, bytesInlined: 0 };
  }
  const rows = new Map(
    ((data ?? []) as Array<{
      id: string;
      storage_path: string | null;
      mime_type: string;
      size_bytes: number;
    }>).map((r) => [r.id, r])
  );

  const phaseDeadline = Date.now() + phaseDeadlineMs;
  let inlined = 0;
  let bytesInlined = 0;

  // Newest-first: history order is oldest-first, and the images the
  // current turn is about are at the tail. The byte cap must evict the
  // OLDEST images, never the anchor turn's.
  for (const ref of [...refs].reverse()) {
    if (Date.now() > phaseDeadline) break;
    const row = rows.get(ref.attachmentId);
    // All three must agree: live row, image mime, and the row's storage
    // path is exactly what the URL claims (an id reuse or path drift
    // degrades to the URL rather than inlining a guess).
    if (
      !row ||
      typeof row.storage_path !== 'string' ||
      row.storage_path !== ref.storagePath ||
      !row.mime_type.startsWith('image/')
    ) {
      continue;
    }
    // Hard stop BEFORE downloading: the row's own size_bytes is known
    // up front, so the first part that would push the total past the
    // cap is skipped, and every older part after it keeps its URL too.
    const rowBytes = row.size_bytes > 0 ? row.size_bytes : 0;
    if (bytesInlined + rowBytes > byteCap) break;
    try {
      const dataUrl = await withTimeout(
        download(admin, row.storage_path, row.mime_type, ref.storagePath),
        perDownloadTimeoutMs
      );
      ref.parts[ref.partIndex] = {
        type: 'image_url',
        image_url: { url: dataUrl },
      };
      inlined += 1;
      // Account with the payload's actual size (base64 length minus the
      // header), not the row's claim, so the cap tracks what was sent.
      bytesInlined += estimateRawBytes(dataUrl) || rowBytes;
    } catch (err) {
      // Degrade this part to its signed URL - the pre-inline behavior.
      console.warn(
        `[inline-images] ${ref.storagePath} stays a signed URL: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
  return { inlined, bytesInlined };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  // If the download fails AFTER the timeout already won the race, its
  // rejection would be unhandled - in Deno that can kill the isolate.
  // Attaching a no-op handler changes nothing for the race (the first
  // settlement still wins); it only silences the late-loser case.
  p.catch(() => {});
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function estimateRawBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  const base64 = dataUrl.length - comma - 1;
  return Math.floor((base64 * 3) / 4);
}
