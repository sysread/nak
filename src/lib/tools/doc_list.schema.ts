/**
 * Schema-only export for doc_list. Impl lives in `./doc_list`.
 */
export const DOC_LIST_DEFAULT_LIMIT = 50;
export const DOC_LIST_MAX_LIMIT = 200;

export const docListSchema = {
  name: 'doc_list',
  description:
    "List the user's Library documents, newest first. Returns " +
    '{id, title, description, filename, mime_type, size_bytes, ' +
    'extraction_status, created_at}[]. Use this to survey what reference ' +
    'material the user has on file; use doc_search to find a passage by ' +
    'meaning, or doc_get to read one document’s full text by id.',
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
