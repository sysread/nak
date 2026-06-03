// doc_get (function-side port)
//
// Document overview by id: metadata + line count, without the full
// text (a multi-MB document body would blow the model's context).
// Returns {found: false} for unknown / non-owned ids. Wire schema
// lives in src/lib/tools/doc_get.schema.ts.
//
// Auth: b-strict. The browser path goes through the document_stat
// RPC, which uses auth.uid() - that returns NULL under our
// service-role admin client, so the RPC is unusable from the
// function. We inline the same SELECT here with an explicit
// user_id filter so the RPC's schema doesn't need a SECURITY
// DEFINER variant just for the function.
//
// The line-count math mirrors the RPC: chars - chars-without-newlines
// + 1 when the body is non-empty, 0 when null/empty.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

interface DocumentStatRow {
  id: string;
  title: string | null;
  description: string | null;
  filename: string;
  mime_type: string;
  size_bytes: number;
  extraction_status: string;
  extraction_error: string | null;
  extracted_text: string | null;
  created_at: string;
  updated_at: string;
}

export const docGet: ToolDef = {
  name: 'doc_get',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) throw new Error('id is required');

    // RLS OFF: filter by userId. documents.user_id direct match,
    // plus id eq - matches the browser's RPC behavior shape (miss
    // and not-owned both surface as {found: false}).
    const { data, error } = await ctx.adminClient
      .from('documents')
      .select(
        'id, title, description, filename, mime_type, size_bytes, extraction_status, extraction_error, extracted_text, created_at, updated_at',
      )
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .maybeSingle<DocumentStatRow>();
    if (error) throw new Error(`getDocumentStat failed: ${error.message}`);
    if (!data) return { found: false };

    const text = data.extracted_text;
    const has_text = typeof text === 'string' && text.length > 0;
    // Newline-counting math from the document_stat SQL: total_lines =
    // (length - length_without_newlines) + 1 for a non-empty body.
    // A body with no newlines is one line; empty body is zero lines.
    const total_lines = has_text && text !== null
      ? text.length - text.replace(/\n/g, '').length + 1
      : 0;

    return {
      found: true,
      document: {
        id: data.id,
        title: data.title,
        description: data.description,
        filename: data.filename,
        mime_type: data.mime_type,
        size_bytes: data.size_bytes,
        extraction_status: data.extraction_status,
        has_text,
        total_lines,
        created_at: data.created_at,
        updated_at: data.updated_at,
      },
    };
  },
};

registerTool(docGet);
