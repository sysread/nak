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


export function coerceDocument(raw: Record<string, unknown>): Document {
  const status = raw.extraction_status;
  return {
    id: String(raw.id),
    title: typeof raw.title === 'string' ? raw.title : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    filename: typeof raw.filename === 'string' ? raw.filename : '',
    mime_type: typeof raw.mime_type === 'string' ? raw.mime_type : '',
    size_bytes: typeof raw.size_bytes === 'number' ? raw.size_bytes : Number(raw.size_bytes ?? 0),
    storage_path: typeof raw.storage_path === 'string' ? raw.storage_path : null,
    extracted_text: typeof raw.extracted_text === 'string' ? raw.extracted_text : null,
    extraction_status:
      status === 'done' || status === 'failed' ? status : 'pending',
    extraction_error: typeof raw.extraction_error === 'string' ? raw.extraction_error : null,
    created_at: String(raw.created_at ?? raw.updated_at ?? ''),
    updated_at: String(raw.updated_at ?? raw.created_at ?? ''),
  };
}

export function coerceDocumentGrepHit(raw: Record<string, unknown>): DocumentGrepHit {
  const toLines = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : String(x ?? ''))) : [];
  return {
    document_id: String(raw.document_id),
    title: typeof raw.title === 'string' ? raw.title : '',
    line_number: typeof raw.line_number === 'number' ? raw.line_number : Number(raw.line_number ?? 0),
    line_text: typeof raw.line_text === 'string' ? raw.line_text : '',
    context_before: toLines(raw.context_before),
    context_after: toLines(raw.context_after),
  };
}

export function coerceDocumentStat(raw: Record<string, unknown>): DocumentStat {
  const status = raw.extraction_status;
  return {
    id: String(raw.id),
    title: typeof raw.title === 'string' ? raw.title : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    filename: typeof raw.filename === 'string' ? raw.filename : '',
    mime_type: typeof raw.mime_type === 'string' ? raw.mime_type : '',
    size_bytes: typeof raw.size_bytes === 'number' ? raw.size_bytes : Number(raw.size_bytes ?? 0),
    extraction_status: status === 'done' || status === 'failed' ? status : 'pending',
    extraction_error: typeof raw.extraction_error === 'string' ? raw.extraction_error : null,
    has_text: raw.has_text === true,
    total_lines: typeof raw.total_lines === 'number' ? raw.total_lines : Number(raw.total_lines ?? 0),
    created_at: String(raw.created_at ?? raw.updated_at ?? ''),
    updated_at: String(raw.updated_at ?? raw.created_at ?? ''),
  };
}
