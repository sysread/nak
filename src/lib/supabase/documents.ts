/**
 * Library / documents domain slice of the Supabase data layer:
 * document metadata CRUD, the Library drawer's offset paging and
 * keyword search, and - under their own banner below - the private
 * `documents` bucket helpers (original-file upload and signed
 * download URLs).
 *
 * Upload flow is two-phase on purpose: createDocument writes the metadata
 * row first (status 'pending', storage_path null), then the caller uploads
 * the binary to the bucket and calls setDocumentStoragePath, then extracts
 * text in the browser and calls setDocumentExtraction.
 * Splitting it this way means a row always exists for the UI to show a
 * "processing" placeholder, and a crash mid-upload leaves a recoverable
 * pending row rather than an orphaned bucket object.
 *
 * The deterministic grep-then-read pair the chat model uses on a
 * document is NOT here: both run server-side over
 * documents.extracted_text (see grep_documents / read_document_lines
 * in schema.sql) so a multi-MB document's text never crosses the
 * wire - only matching snippets or the requested line range come
 * back.
 *
 * Plain async functions taking the shared SupabaseClient as their
 * first argument - no class, no state - so each can be unit-tested
 * against a stubbed client without constructing SupabaseService. The
 * SupabaseService facade (../supabase.ts) delegates its document
 * methods here one-for-one under the same names; UI code calls
 * `app.supabase.<method>()` and should not import this module
 * directly. Row types and coercers live in ./types; the ILIKE helper
 * shared with the thread / memory / recipe paths lives in
 * ./query-utils.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseError } from './error';
import { getSession } from './session';
import { ilikeLogicTreePattern } from './query-utils';
import type { Document, OffsetPage } from './types';
import { coerceDocument } from './types';

/**
 * Mirror of the facade's getSession: unwrap client.auth.getSession(),
 * throwing SupabaseError on failure. Private to this slice so the
 * metadata insert and storage upload keep their exact error behavior
 * without reaching back into SupabaseService.
 */
// Documents ----------------------------------------------------------------

export async function createDocument(
  client: SupabaseClient,
  args: {
    title: string;
    description?: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }
): Promise<Document> {
  const session = await getSession(client);
  if (!session) throw new SupabaseError('Not authenticated.');
  const { data, error } = await client
    .from('documents')
    .insert({
      user_id: session.user.id,
      title: args.title,
      description: args.description ?? '',
      filename: args.filename,
      mime_type: args.mimeType,
      size_bytes: args.sizeBytes,
    })
    .select(
      'id, title, description, filename, mime_type, size_bytes, storage_path, extracted_text, extraction_status, extraction_error, created_at, updated_at'
    )
    .single();
  if (error) throw new SupabaseError(error.message);
  return coerceDocument(data as Record<string, unknown>);
}

export async function setDocumentStoragePath(
  client: SupabaseClient,
  id: string,
  storagePath: string
): Promise<void> {
  const { error } = await client
    .from('documents')
    .update({ storage_path: storagePath })
    .eq('id', id);
  if (error) throw new SupabaseError(error.message);
}

/**
 * Record the outcome of the browser-side text extraction. On success pass
 * the extracted text and status 'done'; on failure pass status 'failed' and
 * a trimmed error so the Library UI can explain why the doc isn't
 * searchable. The original file stays downloadable either way.
 */
export async function setDocumentExtraction(
  client: SupabaseClient,
  id: string,
  result:
    | { status: 'done'; text: string }
    | { status: 'failed'; error: string }
): Promise<void> {
  const patch: Record<string, unknown> =
    result.status === 'done'
      ? { extraction_status: 'done', extracted_text: result.text, extraction_error: null }
      : { extraction_status: 'failed', extraction_error: result.error.slice(0, 500) };
  const { error } = await client.from('documents').update(patch).eq('id', id);
  if (error) throw new SupabaseError(error.message);
}

/**
 * One offset page of the Library list, newest first. Powers the drawer's
 * infinite scroll. `id` is the final tiebreak so docs sharing a created_at
 * keep a stable cross-page order.
 */
export async function listDocumentsPage(
  client: SupabaseClient,
  opts: {
    offset: number;
    pageSize: number;
  }
): Promise<OffsetPage<Document>> {
  const { data, error } = await client
    .from('documents')
    .select(
      'id, title, description, filename, mime_type, size_bytes, storage_path, extracted_text, extraction_status, extraction_error, created_at, updated_at'
    )
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .range(opts.offset, opts.offset + opts.pageSize);
  if (error) throw new SupabaseError(error.message);
  const all = (data ?? []).map((row) => coerceDocument(row as Record<string, unknown>));
  const hasMore = all.length > opts.pageSize;
  return { rows: hasMore ? all.slice(0, opts.pageSize) : all, hasMore };
}

export async function getDocumentById(
  client: SupabaseClient,
  id: string
): Promise<Document | null> {
  const { data, error } = await client
    .from('documents')
    .select(
      'id, title, description, filename, mime_type, size_bytes, storage_path, extracted_text, extraction_status, extraction_error, created_at, updated_at'
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw new SupabaseError(error.message);
  if (!data) return null;
  return coerceDocument(data as Record<string, unknown>);
}

/**
 * Substring search over the user's documents for the Library drawer, newest
 * first. Matches the query against title, description, filename, and the
 * extracted body, so a document surfaces whether the user typed its name or a
 * phrase from inside it. This is the drawer's browse-by-keyword surface; the
 * chat model's precise in-document search is grep_documents (doc_grep).
 */
export async function searchDocuments(
  client: SupabaseClient,
  opts: { query: string; limit?: number }
): Promise<Document[]> {
  const query = opts.query.trim();
  if (query.length === 0) return [];
  const pattern = ilikeLogicTreePattern(query);
  const { data, error } = await client
    .from('documents')
    .select(
      'id, title, description, filename, mime_type, size_bytes, storage_path, extracted_text, extraction_status, extraction_error, created_at, updated_at'
    )
    .or(
      `title.ilike.${pattern},description.ilike.${pattern},filename.ilike.${pattern},extracted_text.ilike.${pattern}`
    )
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 100);
  if (error) throw new SupabaseError(error.message);
  return (data ?? []).map((row) => coerceDocument(row as Record<string, unknown>));
}

/**
 * Patch a document's user-editable metadata (title, description). The
 * extracted body is bound to the original file and is not editable here -
 * replacing content means re-uploading the file.
 */
export async function updateDocument(
  client: SupabaseClient,
  id: string,
  patch: { title?: string; description?: string }
): Promise<Document> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.title !== undefined) update.title = patch.title;
  if (patch.description !== undefined) update.description = patch.description;
  const { data, error } = await client
    .from('documents')
    .update(update)
    .eq('id', id)
    .select(
      'id, title, description, filename, mime_type, size_bytes, storage_path, extracted_text, extraction_status, extraction_error, created_at, updated_at'
    )
    .single();
  if (error) throw new SupabaseError(error.message);
  return coerceDocument(data as Record<string, unknown>);
}

/**
 * Delete a document, its chunks (FK cascade), and its original file in the
 * bucket. The bucket object is removed first; if that fails we still throw
 * before deleting the row, so we never orphan a bucket object behind a
 * deleted row. A leftover row whose object is already gone is the safer
 * failure direction (the UI can retry the delete).
 */
export async function deleteDocument(client: SupabaseClient, id: string): Promise<void> {
  const doc = await getDocumentById(client, id);
  if (doc?.storage_path) {
    const { error: rmErr } = await client.storage
      .from('documents')
      .remove([doc.storage_path]);
    if (rmErr) throw new SupabaseError(rmErr.message);
  }
  const { error } = await client.from('documents').delete().eq('id', id);
  if (error) throw new SupabaseError(error.message);
}

// Documents Storage helpers --------------------------------------------

/**
 * Upload an original file to the private `documents` bucket. The object key
 * convention `<user_id>/<document_id>/<filename>` is what the bucket RLS
 * policy keys on (top-level folder must equal auth.uid()).
 */
export async function uploadDocumentFile(
  client: SupabaseClient,
  args: {
    documentId: string;
    filename: string;
    file: Blob;
    contentType: string;
  }
): Promise<string> {
  const session = await getSession(client);
  if (!session) throw new SupabaseError('Not authenticated.');
  const path = `${session.user.id}/${args.documentId}/${args.filename}`;
  const { error } = await client.storage
    .from('documents')
    .upload(path, args.file, { contentType: args.contentType, upsert: true });
  if (error) throw new SupabaseError(error.message);
  return path;
}

/**
 * Time-limited signed URL for downloading an original file. The bucket is
 * private, so this is the only way the browser surfaces the binary.
 */
export async function createDocumentDownloadUrl(
  client: SupabaseClient,
  storagePath: string,
  expiresInSeconds = 300
): Promise<string> {
  const { data, error } = await client.storage
    .from('documents')
    .createSignedUrl(storagePath, expiresInSeconds);
  if (error) throw new SupabaseError(error.message);
  return data.signedUrl;
}
