/**
 * Passage-level semantic search over the user's Library documents. Embeds the
 * query via Venice, runs the chunk cosine-search RPC, and merges an ILIKE
 * fallback so a just-uploaded doc participates before the backfill embeds its
 * chunks (same merge contract as wiki_search). Documents are never
 * auto-injected - this tool, doc_list, and doc_get are the only paths to them.
 */
import type { ToolDef } from './types';
import { searchDocumentsSemantic } from '../documents';
import {
  docSearchSchema,
  DOC_SEARCH_DEFAULT_LIMIT,
  DOC_SEARCH_MAX_LIMIT,
} from './doc_search.schema';

export const docSearch: ToolDef = {
  ...docSearchSchema,
  async execute(args, ctx) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new Error('query is required');
    const rawLimit =
      typeof args.limit === 'number' ? args.limit : DOC_SEARCH_DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(DOC_SEARCH_MAX_LIMIT, Math.floor(rawLimit)));

    const hits = await searchDocumentsSemantic(query, limit, {
      supabase: ctx.supabase,
      venice: ctx.venice,
      signal: ctx.signal,
    });
    return hits.map((h) => ({
      document_id: h.document_id,
      title: h.title,
      filename: h.filename,
      description: h.description,
      chunk_index: h.chunk_index,
      content: h.content,
      ...(typeof h.similarity === 'number' ? { similarity: h.similarity } : {}),
    }));
  },
};
