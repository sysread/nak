/**
 * Library document primitives, shared by the UI
 * (`src/screens/Library.svelte`, `src/components/LibraryList.svelte`) and the
 * LLM-facing tools (`src/lib/tools/doc_*.ts`):
 *
 *   - ingestDocument: the browser-side upload pipeline (create row, upload the
 *     original, extract text).
 *   - the application-side length / size ceilings.
 *
 * There is no embedding/chunking layer: documents are searched by exact regex
 * (grep_documents / doc_grep) and read by line range (read_document_lines /
 * doc_read), not by vector similarity. The drawer's browse search is a plain
 * substring match (`SupabaseService.searchDocuments`).
 */

import type { SupabaseService } from './supabase';

/** Ceiling on the document title. Defensive cap on the display/sort field. */
export const MAX_DOCUMENT_TITLE_CHARS = 300;

/** Ceiling on the "what this is for" description. */
export const MAX_DOCUMENT_DESCRIPTION_CHARS = 2000;

/** Max upload size (24 MiB). Sits below Venice's text-parser cap (advertised
 * as "25 MB", enforced somewhere between 24 and 25 MiB) so an over-cap upload
 * trips this guard with a clean message at the form rather than surfacing as
 * an opaque 502 once the extraction call reaches Venice. Comfortable headroom
 * for scanned PDFs and longer DOCX. */
export const MAX_DOCUMENT_FILE_BYTES = 24 * 1024 * 1024;

export interface IngestDocumentDeps {
  supabase: SupabaseService;
}

/**
 * Full browser-side ingest of a user-uploaded file into the Library:
 *
 *   1. write the metadata row (status 'pending'),
 *   2. upload the original to the private bucket and record its path,
 *   3. extract text via Venice's parser (through the venice edge function)
 *      and store it.
 *
 * Steps 1-2 are committed before extraction runs, so a parser failure leaves a
 * downloadable doc marked 'failed' rather than losing the upload. The stored
 * text is immediately searchable via doc_grep / doc_read - there is no
 * embedding step to wait on. Returns the new document's id.
 */
export async function ingestDocument(
  args: { title: string; description?: string; file: File },
  deps: IngestDocumentDeps
): Promise<string> {
  const { supabase } = deps;
  const { file } = args;
  const mimeType = file.type || 'application/octet-stream';

  const doc = await supabase.createDocument({
    title: args.title.slice(0, MAX_DOCUMENT_TITLE_CHARS),
    description: (args.description ?? '').slice(0, MAX_DOCUMENT_DESCRIPTION_CHARS),
    filename: file.name,
    mimeType,
    sizeBytes: file.size,
  });

  const path = await supabase.uploadDocumentFile({
    documentId: doc.id,
    filename: file.name,
    file,
    contentType: mimeType,
  });
  await supabase.setDocumentStoragePath(doc.id, path);

  try {
    const text = await supabase.extractText(file, file.name);
    await supabase.setDocumentExtraction(doc.id, { status: 'done', text });
  } catch (err) {
    // Best-effort: the original is uploaded and downloadable; we just mark the
    // doc unsearchable and surface why. Re-uploading is the recovery path.
    const reason = err instanceof Error ? err.message : String(err);
    await supabase.setDocumentExtraction(doc.id, { status: 'failed', error: reason });
  }
  return doc.id;
}
