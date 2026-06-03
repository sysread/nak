// doc_list (function-side port)
//
// List documents in the user's Library, newest first. Wire schema
// lives in src/lib/tools/doc_list.schema.ts. Returns a compact
// projection (id + title + filename + size + extraction status); the
// model calls doc_get / doc_read for the body.
//
// Auth: b-strict. documents.user_id direct ownership filter.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

// Mirror of the limits in src/lib/tools/doc_list.schema.ts.
const DOC_LIST_DEFAULT_LIMIT = 100;
const DOC_LIST_MAX_LIMIT = 500;

export const docList: ToolDef = {
  name: 'doc_list',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const rawLimit =
      typeof args.limit === 'number' ? args.limit : DOC_LIST_DEFAULT_LIMIT;
    const limit = Math.max(
      1,
      Math.min(DOC_LIST_MAX_LIMIT, Math.floor(rawLimit)),
    );

    // RLS OFF: filter by userId. documents.user_id is the direct
    // ownership column.
    const { data, error } = await ctx.adminClient
      .from('documents')
      .select(
        'id, title, description, filename, mime_type, size_bytes, extraction_status, created_at, updated_at',
      )
      .eq('user_id', ctx.userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`listDocuments failed: ${error.message}`);

    return (data ?? []).map((d) => ({
      id: d.id as string,
      title: d.title as string | null,
      description: d.description as string | null,
      filename: d.filename as string,
      mime_type: d.mime_type as string,
      size_bytes: d.size_bytes as number,
      extraction_status: d.extraction_status as string,
      created_at: d.created_at as string,
      updated_at: d.updated_at as string,
    }));
  },
};

registerTool(docList);
