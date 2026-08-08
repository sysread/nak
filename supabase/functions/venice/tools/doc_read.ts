// doc_read (function-side port)
//
// Read a contiguous line range of a Library document via the
// read_document_lines RPC. Wire schema lives in
// src/lib/tools/doc_read.schema.ts.
//
// Span clamping: a single read can't ship more than
// DOC_READ_MAX_SPAN lines. The model pages with successive reads if
// it needs more. Empty result triggers a fall-back stat lookup that
// disambiguates "doc missing", "no extracted text", or "range past
// end" without re-shipping the text.
//
// Auth: b-strict. Both RPCs take p_user_id (schema delta in this
// branch).

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

// Mirror of DOC_READ_MAX_SPAN in src/lib/tools/doc_read.schema.ts.
const DOC_READ_MAX_SPAN = 500;

interface LineRow {
  line_number: number;
  content: string;
  total_lines: number;
}

interface DocStatRow {
  extracted_text: string | null;
}

export const docRead: ToolDef = {
  name: 'doc_read',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const documentId =
      typeof args.document_id === 'string' ? args.document_id.trim() : '';
    if (!documentId) throw new Error('document_id is required');

    if (typeof args.start_line !== 'number' || typeof args.end_line !== 'number' ||
        !Number.isFinite(args.start_line) || !Number.isFinite(args.end_line)) {
      throw new Error('start_line and end_line are required and must be numbers');
    }
    const start = Math.max(1, Math.floor(Number(args.start_line)));
    const rawEnd = Math.max(start, Math.floor(Number(args.end_line)));
    const end = Math.min(rawEnd, start + DOC_READ_MAX_SPAN - 1);

    const { data, error } = await ctx.adminClient.rpc('read_document_lines', {
      p_document_id: documentId,
      p_start: start,
      p_end: end,
      p_user_id: ctx.userId,
    });
    if (error) throw new Error(`readDocumentLines failed: ${error.message}`);

    const rows = (data ?? []) as LineRow[];
    if (rows.length === 0) {
      // Disambiguate by inlining the stat query - same shape as
      // doc_get's inlined SELECT. // RLS OFF: filter by userId on
      // documents.
      const { data: stat, error: statErr } = await ctx.adminClient
        .from('documents')
        .select('extracted_text')
        .eq('user_id', ctx.userId)
        .eq('id', documentId)
        .maybeSingle<DocStatRow>();
      if (statErr) throw new Error(`document_stat fallback failed: ${statErr.message}`);
      if (!stat) return { found: false };

      const text = stat.extracted_text;
      const has_text = typeof text === 'string' && text.length > 0;
      const total_lines = has_text && text !== null
        ? text.length - text.replace(/\n/g, '').length + 1
        : 0;
      return {
        found: true,
        total_lines,
        start_line: start,
        end_line: end,
        lines: [],
        note: total_lines === 0
          ? 'This document has no extracted text to read.'
          : `Requested range is past the end; the document has ${total_lines} lines.`,
      };
    }

    return {
      found: true,
      total_lines: rows[0].total_lines,
      start_line: rows[0].line_number,
      end_line: rows[rows.length - 1].line_number,
      lines: rows.map((r) => ({ line_number: r.line_number, content: r.content })),
    };
  },
};

registerTool(docRead);
