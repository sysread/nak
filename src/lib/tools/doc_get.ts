/**
 * Read a single Library document's metadata and extracted text by id. Returns
 * {found: false} for an unknown id (or one owned by another user - RLS filters
 * it) rather than throwing, matching wiki_get / recipe_get. Long bodies are
 * truncated to the inline cap with a flag so the model knows to fall back to
 * doc_search for the remainder.
 */
import type { ToolDef } from './types';
import { docGetSchema, DOC_GET_MAX_TEXT_CHARS } from './doc_get.schema';

export const docGet: ToolDef = {
  ...docGetSchema,
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) throw new Error('id is required');
    const doc = await ctx.supabase.getDocumentById(id);
    if (!doc) return { found: false };

    const full = doc.extracted_text ?? '';
    const truncated = full.length > DOC_GET_MAX_TEXT_CHARS;
    return {
      found: true,
      document: {
        id: doc.id,
        title: doc.title,
        description: doc.description,
        filename: doc.filename,
        mime_type: doc.mime_type,
        size_bytes: doc.size_bytes,
        extraction_status: doc.extraction_status,
        text: truncated ? full.slice(0, DOC_GET_MAX_TEXT_CHARS) : full,
        text_truncated: truncated,
        created_at: doc.created_at,
        updated_at: doc.updated_at,
      },
    };
  },
};
