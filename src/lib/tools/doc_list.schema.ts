/**
 * Schema-only export for doc_list. Impl lives in `./doc_list`.
 */
export const DOC_LIST_DEFAULT_LIMIT = 100;
export const DOC_LIST_MAX_LIMIT = 500;

export const docListSchema = {
  name: 'doc_list',
  description:
    "List the user's Library documents, newest first. Returns " +
    '{id, title, description, filename, mime_type, size_bytes, ' +
    'extraction_status, created_at}[]. Use this to survey what reference ' +
    'material the user has on file and pick which document a question is ' +
    'about (read the descriptions); then doc_grep to find the relevant lines ' +
    'and doc_read to read them.',
  shortDescription: 'list the user’s uploaded documents',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: DOC_LIST_MAX_LIMIT,
        description: `Max documents (default ${DOC_LIST_DEFAULT_LIMIT}, max ${DOC_LIST_MAX_LIMIT}).`,
      },
    },
    required: [],
    additionalProperties: false,
  },
} as const;
