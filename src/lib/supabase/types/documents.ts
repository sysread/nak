/**
 * Library-domain row types: persistent reference documents, plus the
 * grep-hit and stat projections the doc_* tools read. Re-exported
 * through `../../supabase.ts` so consumers keep importing from
 * `$lib/supabase`.
 */

// --- appended verbatim from the original supabase.ts type block ---
/**
 * A persistent reference document in the user's Library. Mirrors the
 * `public.documents` table. The original file lives in the `documents`
 * Storage bucket (pointed at by `storage_path`); `extracted_text` is the
 * Venice text-parser output that gets chunked + embedded for search.
 */
export interface Document {
  id: string;
  title: string;
  description: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string | null;
  extracted_text: string | null;
  extraction_status: 'pending' | 'done' | 'failed';
  extraction_error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One hit from `grep_documents`: a matching line with its location and a few
 * lines of context on either side.
 */
export interface DocumentGrepHit {
  document_id: string;
  title: string;
  line_number: number;
  line_text: string;
  context_before: string[];
  context_after: string[];
}

/**
 * `document_stat` output: a document's metadata plus its total line count,
 * fetched without shipping the extracted text. Powers the `doc_get` tool.
 */
export interface DocumentStat {
  id: string;
  title: string;
  description: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  extraction_status: 'pending' | 'done' | 'failed';
  extraction_error: string | null;
  has_text: boolean;
  total_lines: number;
  created_at: string;
  updated_at: string;
}

