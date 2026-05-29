/**
 * Library document primitives, shared by the UI
 * (`src/screens/Library.svelte`, `src/components/LibraryList.svelte`) and the
 * LLM-facing tools (`src/lib/tools/doc_*.ts`):
 *
 *   - chunkText: split extracted document text into embeddable passages.
 *   - searchDocumentsSemantic: embed the query via Venice and run the
 *     vector + ILIKE search so the user finds what the assistant finds.
 *   - the application-side length / size ceilings.
 *
 * The split between this module and `SupabaseService` mirrors `wiki.ts`:
 * SupabaseService owns the DB round-trips; this module owns the query
 * embedding and the pure chunking transform.
 */

import type { SupabaseService, DocumentChunkHit } from './supabase';
import type { VeniceClient } from './venice';
import { VENICE_EMBEDDING_MODEL, padEmbeddingForStorage } from './models';

/**
 * Target chunk size in characters. bge-m3's effective window is roughly
 * 512 tokens (~2-4k chars); 2000 keeps a whole chunk comfortably inside it
 * so the embedding represents the entire passage rather than a truncated head.
 * The server-side embed-input builder caps at 4000 (DOCUMENT_CHUNK_CHARS * 2)
 * as a defensive backstop, so a chunk that overshoots slightly still embeds.
 */
export const DOCUMENT_CHUNK_CHARS = 2000;

/**
 * Overlap carried from the end of one chunk into the start of the next.
 * Overlap keeps an answer that straddles a chunk boundary ("...the late fee
 * is" | "$50 per occurrence...") retrievable from at least one chunk that
 * contains the whole phrase. 200 chars is ~10% of the chunk - enough to span
 * a sentence without materially inflating the chunk count.
 */
export const DOCUMENT_CHUNK_OVERLAP_CHARS = 200;

/** Max characters of extracted text we chunk + embed per document. A defense
 * against a pathological multi-hundred-page upload generating tens of
 * thousands of chunk rows; well past any normal contract / policy / tax doc. */
export const MAX_DOCUMENT_TEXT_CHARS = 1_000_000;

/** Ceiling on the document title. Defensive cap on the display/sort field. */
export const MAX_DOCUMENT_TITLE_CHARS = 300;

/** Ceiling on the "what this is for" description. */
export const MAX_DOCUMENT_DESCRIPTION_CHARS = 2000;

/** Max upload size (25 MB). Large enough for scanned PDFs, bounded so a
 * single upload can't exhaust the base64 round-trip the text-parser uses. */
export const MAX_DOCUMENT_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Split a document's extracted text into overlapping chunks for embedding.
 *
 * Strategy: pack whole paragraphs (split on blank lines) into chunks up to
 * DOCUMENT_CHUNK_CHARS so a chunk boundary lands on a natural break wherever
 * possible. A paragraph longer than the chunk size on its own is hard-split
 * on character count (no natural break to honor). Each chunk after the first
 * is prefixed with the trailing DOCUMENT_CHUNK_OVERLAP_CHARS of the previous
 * chunk so a phrase straddling a boundary stays retrievable.
 *
 * Returns [] for empty / whitespace-only input.
 */
export function chunkText(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const capped =
    trimmed.length > MAX_DOCUMENT_TEXT_CHARS
      ? trimmed.slice(0, MAX_DOCUMENT_TEXT_CHARS)
      : trimmed;

  // First pass: pack paragraphs into size-bounded base chunks with no overlap.
  const paragraphs = capped.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
  const base: string[] = [];
  let current = '';
  const flush = () => {
    if (current.length > 0) {
      base.push(current);
      current = '';
    }
  };
  for (const para of paragraphs) {
    if (para.length > DOCUMENT_CHUNK_CHARS) {
      // Paragraph too big to ever fit: flush what we have, then hard-split it.
      flush();
      for (let i = 0; i < para.length; i += DOCUMENT_CHUNK_CHARS) {
        base.push(para.slice(i, i + DOCUMENT_CHUNK_CHARS));
      }
      continue;
    }
    const candidate = current.length === 0 ? para : `${current}\n\n${para}`;
    if (candidate.length > DOCUMENT_CHUNK_CHARS) {
      flush();
      current = para;
    } else {
      current = candidate;
    }
  }
  flush();

  if (base.length <= 1) return base;

  // Second pass: prefix each chunk (after the first) with the tail of its
  // predecessor so a boundary-straddling phrase survives in one chunk.
  const out: string[] = [base[0]];
  for (let i = 1; i < base.length; i++) {
    const prev = base[i - 1];
    const overlap = prev.slice(Math.max(0, prev.length - DOCUMENT_CHUNK_OVERLAP_CHARS));
    out.push(`${overlap}\n\n${base[i]}`);
  }
  return out;
}

export interface IngestDocumentDeps {
  supabase: SupabaseService;
  venice: VeniceClient;
}

/**
 * Full browser-side ingest of a user-uploaded file into the Library:
 *
 *   1. write the metadata row (status 'pending'),
 *   2. upload the original to the private bucket and record its path,
 *   3. extract text via Venice's parser, chunk it, and insert the chunks
 *      (the server-side backfill embeds them on its next sweep).
 *
 * Steps 1-2 are committed before extraction runs, so a parser failure leaves a
 * downloadable doc marked 'failed' rather than losing the upload. The returned
 * Document reflects the final extraction status. Embeddings are NOT awaited -
 * they land asynchronously via the cron backfill (~5 min), exactly like a
 * fresh memory or wiki article.
 */
export async function ingestDocument(
  args: { title: string; description?: string; file: File },
  deps: IngestDocumentDeps
): Promise<string> {
  const { supabase, venice } = deps;
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
    const text = await venice.extractText(file, file.name);
    await supabase.setDocumentExtraction(doc.id, { status: 'done', text });
    await supabase.insertDocumentChunks(doc.id, chunkText(text));
  } catch (err) {
    // Best-effort: the original is uploaded and downloadable; we just mark the
    // doc unsearchable and surface why. Re-uploading is the recovery path.
    const reason = err instanceof Error ? err.message : String(err);
    await supabase.setDocumentExtraction(doc.id, { status: 'failed', error: reason });
  }
  return doc.id;
}

export interface SearchDocumentsDeps {
  supabase: SupabaseService;
  venice: VeniceClient | null;
  signal?: AbortSignal;
}

/**
 * Embed the query (when Venice is available) and run the chunk search. Falls
 * back silently to ILIKE-only on any Venice error - a transient embedding
 * failure should degrade ranking, not blank the results. Mirrors
 * searchWikiArticlesSemantic.
 */
export async function searchDocumentsSemantic(
  query: string,
  limit: number,
  deps: SearchDocumentsDeps
): Promise<DocumentChunkHit[]> {
  const { supabase, venice, signal } = deps;
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  let queryEmbedding: number[] | null = null;
  if (venice) {
    try {
      const response = await venice.embed({
        model: VENICE_EMBEDDING_MODEL,
        input: trimmed,
        signal,
      });
      const raw = response.data[0]?.embedding;
      if (raw && raw.length > 0) queryEmbedding = padEmbeddingForStorage(raw);
    } catch {
      // Silent fallback to ILIKE-only - see function comment.
      queryEmbedding = null;
    }
  }

  return supabase.searchDocumentChunks({ query: trimmed, queryEmbedding, limit });
}
