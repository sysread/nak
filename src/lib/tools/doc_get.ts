/**
 * Document overview by id: metadata + total line count, without shipping the
 * extracted text (a multi-MB document would blow the context window). This is
 * the "stat" call - it tells the model what a document is and how many lines it
 * can address; doc_read pulls the actual lines and doc_grep finds specific
 * ones. Returns {found: false} for an unknown id (or one owned by another user
 * - RLS filters it) rather than throwing, matching wiki_get / recipe_get.
 */
import type { ToolDef } from './types';
import { docGetSchema } from './doc_get.schema';

export const docGet: ToolDef = {
  ...docGetSchema,
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) throw new Error('id is required');
    const stat = await ctx.supabase.getDocumentStat(id);
    if (!stat) return { found: false };
    return {
      found: true,
      document: {
        id: stat.id,
        title: stat.title,
        description: stat.description,
        filename: stat.filename,
        mime_type: stat.mime_type,
        size_bytes: stat.size_bytes,
        extraction_status: stat.extraction_status,
        has_text: stat.has_text,
        total_lines: stat.total_lines,
        created_at: stat.created_at,
        updated_at: stat.updated_at,
      },
    };
  },
};
