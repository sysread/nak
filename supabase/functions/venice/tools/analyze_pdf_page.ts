// analyze_pdf_page (function-side - the live implementation)
//
// Vision sub-completion against ONE rasterized page of a PDF attached
// anywhere in the current thread. Wire schema lives in
// src/lib/tools/analyze_pdf_page.schema.ts.
//
// Why this tool exists: Venice's text-parser gives us a PDF's text layer,
// which is inlined into the user turn and covers most documents. It does
// nothing for a SCANNED PDF (no text layer at all) and it drops charts,
// diagrams, signatures, stamps, and table layout from the ones it does
// handle. Before this tool the model's only filename-taking lever was
// analyze_image, which rejects a PDF outright - so those documents read as
// unreadable no matter what the user asked.
//
// The pages are rasterized in the BROWSER at upload time (src/lib/pdf-pages.ts)
// and stored in message_attachment_pages; this side only reads them. See
// docs/dev/attachments.md, "PDF page rendering".
//
// Auth: b-strict. The page lookup joins message_attachment_pages ->
// message_attachments -> messages and filters by thread, which the
// orchestrator validated against userId at /stream entry.

import { requireThreadId, registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { readVeniceKey } from './_venice_key.ts';
import { askVision, attachmentObjectAsDataUrl } from './_vision.ts';

interface PdfAttachmentRow {
  id: string;
  filename: string;
  page_count: number | null;
}

/**
 * Which pages of this attachment actually rendered, ascending.
 *
 * Not always a contiguous 1..N: rendering is capped (a long document only
 * gets its leading pages) and an individual page that failed to rasterize is
 * skipped rather than failing the whole document. So "which pages can I
 * look at" has to be answered from the rows, not computed from page_count.
 */
async function renderedPageNumbers(ctx: ToolContext, attachmentId: string): Promise<number[]> {
  const { data, error } = await ctx.adminClient
    .from('message_attachment_pages')
    .select('page_number')
    .eq('attachment_id', attachmentId)
    .order('page_number', { ascending: true });
  if (error) throw new Error(`attachment page lookup failed: ${error.message}`);
  return ((data ?? []) as Array<{ page_number: number }>).map((r) => r.page_number);
}

/**
 * "1-30" for a contiguous run, "1-12, 15, 40" when there are gaps. The model
 * relays this to the user when it can't see the page they asked about, so it
 * has to be readable prose, not a raw array.
 */
function describeRanges(pages: readonly number[]): string {
  const ranges: string[] = [];
  let start = pages[0];
  let prev = pages[0];
  for (const page of pages.slice(1)) {
    if (page === prev + 1) {
      prev = page;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = page;
    prev = page;
  }
  ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  return ranges.join(', ');
}

export const analyzePdfPage: ToolDef = {
  name: 'analyze_pdf_page',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const filename = typeof args.filename === 'string' ? args.filename.trim() : '';
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    // Accept a float or a numeric string and normalize: the wire schema is
    // advisory (Venice does no constrained decoding), so the model can and
    // does send "3" or 3.0 where an integer was asked for.
    const rawPage = typeof args.page === 'string' ? Number(args.page) : args.page;
    const page = typeof rawPage === 'number' && Number.isFinite(rawPage)
      ? Math.trunc(rawPage)
      : NaN;

    if (!filename) throw new Error('analyze_pdf_page requires a non-empty `filename` argument');
    if (!query) throw new Error('analyze_pdf_page requires a non-empty `query` argument');
    if (!Number.isFinite(page) || page < 1) {
      throw new Error('analyze_pdf_page requires `page` to be a positive integer (pages are 1-based)');
    }

    // RLS OFF: scoped via parent thread (validated upstream). Most recent
    // attachment with this filename, restricted to documents we rasterize.
    const { data: attachment, error } = await ctx.adminClient
      .from('message_attachments')
      .select('id, filename, page_count, messages!inner(thread_id)')
      .eq('messages.thread_id', requireThreadId(ctx))
      .eq('filename', filename)
      .eq('mime_type', 'application/pdf')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<PdfAttachmentRow>();
    if (error) throw new Error(`analyze_pdf_page lookup failed: ${error.message}`);
    if (!attachment) {
      throw new Error(
        `No PDF named "${filename}" in this conversation. Filenames in ` +
          '<thread_attachments> are case-sensitive; analyze_pdf_page only ' +
          'reads PDFs (use analyze_image for pictures).',
      );
    }

    const { data: pageRow } = await ctx.adminClient
      .from('message_attachment_pages')
      .select('storage_path')
      .eq('attachment_id', attachment.id)
      .eq('page_number', page)
      .maybeSingle<{ storage_path: string }>();

    if (!pageRow) {
      const available = await renderedPageNumbers(ctx, attachment.id);
      if (available.length === 0) {
        throw new Error(
          `"${filename}" has no rendered pages, so none of it can be viewed. ` +
            'Its extracted text (if any) is inlined in the user turn where it ' +
            'was attached. Tell the user the document could not be rendered ' +
            'rather than guessing at its visual content.',
        );
      }
      const total = attachment.page_count ?? available[available.length - 1];
      throw new Error(
        `Page ${page} of "${filename}" was not rendered. The document has ` +
          `${total} pages; viewable pages are ${describeRanges(available)}. ` +
          'Pick one of those, or tell the user that page is outside the ' +
          'range that was rendered.',
      );
    }

    const label = `page ${page} of "${filename}"`;
    const imageUrl = await attachmentObjectAsDataUrl(
      ctx.adminClient,
      pageRow.storage_path,
      'image/jpeg',
      label.charAt(0).toUpperCase() + label.slice(1),
    );

    const apiKey = await readVeniceKey(ctx.adminClient);
    if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

    return {
      filename,
      page,
      page_count: attachment.page_count,
      answer: await askVision(apiKey, query, imageUrl, label),
    };
  },
};

registerTool(analyzePdfPage);

// Test-only surface. describeRanges has no external caller in production;
// exporting it outright would widen the tool's API for a unit test.
export const __test = { describeRanges };
