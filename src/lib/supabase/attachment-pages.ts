/**
 * Persistence for rasterized attachment pages - the `message_attachment_pages`
 * rows and their bytes in the `attachments` bucket.
 *
 * The renderer that produces these blobs is `src/lib/pdf-pages.ts`; the reader
 * is server-side (`supabase/functions/venice/tools/analyze_pdf_page.ts`), which
 * queries the table directly. This module is the write half plus the cleanup
 * helpers the attachment/thread/message deletes call to reclaim page objects.
 *
 * Page objects share the `attachments` bucket with the originals, keyed
 * `<user_id>/<attachment_id>/pages/<page_number>.jpg`. The `<user_id>` prefix
 * is what the bucket's storage.objects RLS policy keys on, so it is load-
 * bearing (see docs/dev/file-storage.md).
 *
 * Plain async functions taking the shared SupabaseClient first, matching the
 * convention in ./messages.ts; the SupabaseService facade delegates here.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseError } from './error';
import type { RenderedPdfPage } from '../pdf-pages';

/** Bucket shared with attachment originals and generated images. */
const ATTACHMENTS_BUCKET = 'attachments';

/**
 * Object key for one rendered page. Zero-padded so a plain lexical listing of
 * the bucket prefix reads in page order, which makes manual inspection of a
 * document's pages in the Storage browser sane.
 */
function pageObjectPath(userId: string, attachmentId: string, pageNumber: number): string {
  return `${userId}/${attachmentId}/pages/${String(pageNumber).padStart(4, '0')}.jpg`;
}

/**
 * Upload rendered pages for one attachment and insert their rows.
 *
 * Called after `addAttachments` has committed the parent row, because the
 * rows FK to it and the object key embeds its id. Best-effort per page: an
 * upload that fails drops that page rather than failing the send, since a
 * partially-viewable PDF is strictly better than a rejected message. The
 * caller treats a total failure the same way - the attachment still carries
 * its extracted text.
 *
 * Objects are uploaded before the rows are inserted, so a crash between the
 * two strands objects with no row. That is the orphan shape `attachment-gc`
 * already reclaims (its anti-join covers this table - see schema.sql), so the
 * failure mode costs bucket space until the next daily sweep, never
 * correctness.
 */
export async function addAttachmentPages(
  client: SupabaseClient,
  userId: string,
  attachmentId: string,
  pages: readonly RenderedPdfPage[]
): Promise<number> {
  if (pages.length === 0) return 0;

  const uploaded: Array<{ attachment_id: string; page_number: number; storage_path: string }> = [];
  for (const page of pages) {
    const path = pageObjectPath(userId, attachmentId, page.pageNumber);
    const { error } = await client.storage
      .from(ATTACHMENTS_BUCKET)
      .upload(path, page.blob, { contentType: 'image/jpeg', upsert: true });
    // Swallowed on purpose: one page that won't upload leaves the rest of the
    // document viewable, and analyze_pdf_page reports the gap when asked for
    // that page. Failing the whole send over it would be worse.
    if (error) continue;
    uploaded.push({
      attachment_id: attachmentId,
      page_number: page.pageNumber,
      storage_path: path,
    });
  }
  if (uploaded.length === 0) return 0;

  const { error } = await client.from('message_attachment_pages').insert(uploaded);
  if (error) throw new SupabaseError(error.message);
  return uploaded.length;
}

/**
 * Object keys of every rendered page belonging to the given attachments.
 *
 * The delete paths (thread delete, message delete, Artifacts-tab per-file
 * delete) collect these alongside the originals' keys so one Storage remove
 * reclaims both. Returns an empty array for an empty input rather than
 * issuing a query with an empty `in` list, which PostgREST treats as
 * matching nothing but still costs a round trip.
 */
export async function listAttachmentPagePaths(
  client: SupabaseClient,
  attachmentIds: readonly string[]
): Promise<string[]> {
  if (attachmentIds.length === 0) return [];
  const { data, error } = await client
    .from('message_attachment_pages')
    .select('storage_path')
    .in('attachment_id', attachmentIds);
  if (error) throw new SupabaseError(error.message);
  return ((data ?? []) as Array<{ storage_path: string }>).map((r) => r.storage_path);
}

/**
 * Drop every rendered page of one attachment - rows and objects both.
 *
 * The Artifacts-tab delete needs this explicitly because it EXPIRES the
 * attachment (nulls `storage_path`, stamps `expired_at`) rather than deleting
 * the row, so the `on delete cascade` that would otherwise clear these rows
 * never fires. Without this call a deleted PDF would keep its page renders
 * both in the table and in the bucket, and `analyze_pdf_page` would happily
 * keep showing the user a document they asked to delete.
 *
 * Rows first, then objects: the same ordering `deleteAttachment` uses, so a
 * Storage hiccup leaves reclaimable orphans (attachment-gc's job) rather than
 * rows pointing at objects that are gone.
 */
export async function deleteAttachmentPages(
  client: SupabaseClient,
  attachmentId: string
): Promise<void> {
  const paths = await listAttachmentPagePaths(client, [attachmentId]);
  const { error } = await client
    .from('message_attachment_pages')
    .delete()
    .eq('attachment_id', attachmentId);
  if (error) throw new SupabaseError(error.message);
  if (paths.length > 0) {
    // Swallowed on purpose: attachment-gc reclaims whatever the remove
    // misses, and the rows are already gone regardless.
    await client.storage.from(ATTACHMENTS_BUCKET).remove(paths);
  }
}
