/**
 * Read a contiguous line range of a Library document, numbered - the read half
 * of the grep-then-read loop. The span is clamped so one call can't ship the
 * whole document; the model pages with successive reads. When the requested
 * range comes back empty we fall back to a stat lookup to tell the model
 * whether the document is missing or the range was simply out of bounds.
 */
import type { ToolDef } from './types';
import { docReadSchema, DOC_READ_MAX_SPAN } from './doc_read.schema';

export const docRead: ToolDef = {
  ...docReadSchema,
  async execute(args, ctx) {
    const documentId = typeof args.document_id === 'string' ? args.document_id.trim() : '';
    if (!documentId) throw new Error('document_id is required');
    const start = Math.max(1, Math.floor(Number(args.start_line)));
    const rawEnd = Math.max(start, Math.floor(Number(args.end_line)));
    // Clamp the span so a single read stays bounded; the model asks again for
    // the next window if it needs more.
    const end = Math.min(rawEnd, start + DOC_READ_MAX_SPAN - 1);

    const { lines, totalLines } = await ctx.supabase.readDocumentLines(documentId, start, end);

    if (lines.length === 0) {
      // Empty could mean the doc doesn't exist, has no text yet, or the range
      // was past the end. Stat disambiguates without re-shipping text.
      const stat = await ctx.supabase.getDocumentStat(documentId);
      if (!stat) return { found: false };
      return {
        found: true,
        total_lines: stat.total_lines,
        start_line: start,
        end_line: end,
        lines: [],
        note:
          stat.total_lines === 0
            ? 'This document has no extracted text to read.'
            : `Requested range is past the end; the document has ${stat.total_lines} lines.`,
      };
    }

    return {
      found: true,
      total_lines: totalLines,
      start_line: lines[0].line_number,
      end_line: lines[lines.length - 1].line_number,
      lines,
    };
  },
};
