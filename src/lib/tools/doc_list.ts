/**
 * Browse the user's Library documents (metadata only, newest first). The
 * counterpart to doc_search: a survey of what's on file when the model wants
 * to know which documents exist before drilling into one with doc_get.
 */
import type { ToolDef } from './types';
import { docListSchema, DOC_LIST_DEFAULT_LIMIT, DOC_LIST_MAX_LIMIT } from './doc_list.schema';

export const docList: ToolDef = {
  ...docListSchema,
  async execute(args, ctx) {
    const rawLimit =
      typeof args.limit === 'number' ? args.limit : DOC_LIST_DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(DOC_LIST_MAX_LIMIT, Math.floor(rawLimit)));
    const docs = await ctx.supabase.listDocuments({ limit });
    return docs.map((d) => ({
      id: d.id,
      title: d.title,
      description: d.description,
      filename: d.filename,
      mime_type: d.mime_type,
      size_bytes: d.size_bytes,
      extraction_status: d.extraction_status,
      created_at: d.created_at,
    }));
  },
};
