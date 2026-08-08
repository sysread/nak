/**
 * Schema-only export for doc_read. Impl lives in `./doc_read`.
 */

/**
 * Cap on the line span a single doc_read can pull, so reading from a large
 * document can't blow the context window in one call. The model pages with
 * successive reads, exactly like reading a big file in offset/limit windows.
 */
export const DOC_READ_MAX_SPAN = 500;

export const docReadSchema = {
  name: 'doc_read',
  description:
    'Read a range of lines from a Library document, numbered - the read half ' +
    'of the grep-then-read loop. Feed it the line numbers doc_grep returned ' +
    '(or page through a document in successive windows). Returns ' +
    '{found, total_lines, start_line, end_line, lines: [{line_number, ' +
    `content}]}. A single call returns at most ${DOC_READ_MAX_SPAN} lines; ` +
    'request a narrower range or call again for more. Use doc_get first to ' +
    'see how many lines the document has.',
  shortDescription: 'read a line range of a document',
  parameters: {
    type: 'object',
    properties: {
      document_id: {
        type: 'string',
        description: 'UUID of the document (from doc_list, doc_grep, or doc_get).',
      },
      start_line: {
        type: 'integer',
        minimum: 1,
        description: '1-based first line to read (inclusive).',
      },
      end_line: {
        type: 'integer',
        minimum: 1,
        description: `Last line to read (inclusive). Clamped so the span is at most ${DOC_READ_MAX_SPAN} lines.`,
      },
    },
    required: ['document_id', 'start_line', 'end_line'],
    additionalProperties: false,
  },
} as const;
