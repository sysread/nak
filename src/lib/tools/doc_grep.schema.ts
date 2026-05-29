/**
 * Schema-only export for doc_grep. Impl lives in `./doc_grep`.
 */
export const DOC_GREP_DEFAULT_CONTEXT = 2;
export const DOC_GREP_MAX_CONTEXT = 5;
export const DOC_GREP_DEFAULT_MAX_MATCHES = 50;
export const DOC_GREP_MAX_MATCHES = 200;

export const docGrepSchema = {
  name: 'doc_grep',
  description:
    'The primary way to search Library documents: exact regex, like ' +
    "`grep -n` over the document's text. Returns every matching line with its " +
    'line number and a few lines of context, so you can pinpoint an exact ' +
    'clause ("late fee", "quorum", a section heading) and then doc_read the ' +
    'surrounding section. POSIX regex, case-insensitive by default. Omit ' +
    'document_id to search across every document. Broaden with alternations ' +
    '(e.g. "water|flood|leak|seepage") when the user\'s wording may differ ' +
    'from the document\'s. Returns {document_id, title, line_number, ' +
    'line_text, context_before[], context_after[]}[] plus match_count. ' +
    'Reach for this the way you would grep a large file before reading it.',
  shortDescription: 'regex-search inside documents for exact lines',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        minLength: 1,
        description: 'POSIX regular expression (e.g. "late fee|penalty|delinquent").',
      },
      document_id: {
        type: 'string',
        description:
          'Restrict to one document (from doc_list or doc_get). Omit to ' +
          'search across all of the user\'s documents.',
      },
      case_sensitive: {
        type: 'boolean',
        description: 'Match case exactly. Defaults to false (case-insensitive).',
      },
      context: {
        type: 'integer',
        minimum: 0,
        maximum: DOC_GREP_MAX_CONTEXT,
        description: `Lines of context above and below each match (default ${DOC_GREP_DEFAULT_CONTEXT}, max ${DOC_GREP_MAX_CONTEXT}).`,
      },
      max_matches: {
        type: 'integer',
        minimum: 1,
        maximum: DOC_GREP_MAX_MATCHES,
        description: `Cap on matches returned (default ${DOC_GREP_DEFAULT_MAX_MATCHES}, max ${DOC_GREP_MAX_MATCHES}).`,
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
} as const;
