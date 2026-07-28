/**
 * Schema-only export for analyze_pdf_page. Impl lives in
 * `supabase/functions/venice/tools/analyze_pdf_page.ts`.
 */
export const analyzePdfPageSchema = {
  name: 'analyze_pdf_page',
  description:
    'LOOK at one page of a PDF attached to this conversation, via a ' +
    'vision-capable model. Use this when the PDF is a scan (its inlined ' +
    'text is missing or garbled) or when the answer depends on something ' +
    'text extraction drops: charts, diagrams, photos, signatures, stamps, ' +
    'form checkboxes, or table layout. For ordinary prose, read the ' +
    "extracted text already inlined in the user's turn instead - it is " +
    'cheaper and complete. The <thread_attachments> block lists which PDFs ' +
    'have viewable pages and how many. Returns {filename, page, ' +
    "page_count, answer} where answer is the vision model's plain text.",
  shortDescription: 'look at one page of a PDF via vision model',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description:
          'PDF filename from <thread_attachments> (case-sensitive). Any turn ' +
          'of this conversation is reachable, not just the most recent.',
      },
      page: {
        type: 'integer',
        minimum: 1,
        description:
          '1-based page number, the same numbering the user sees in a PDF ' +
          'reader. Not every page of a long document is rendered; an ' +
          'out-of-range request comes back naming the pages that are.',
      },
      query: {
        type: 'string',
        description:
          'What to extract or describe on that page, phrased as a direct ' +
          'instruction to the vision model (e.g. "Transcribe all text on ' +
          'this page" or "What values does the bar chart show?").',
      },
    },
    required: ['filename', 'page', 'query'],
    additionalProperties: false,
  },
} as const;
