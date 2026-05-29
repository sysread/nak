/**
 * Schema-only export for doc_get. Impl lives in `./doc_get`.
 */
export const docGetSchema = {
  name: 'doc_get',
  description:
    'Fetch one Library document\'s metadata and size by id - the cheap ' +
    '"overview" that tells you what a document is and how many lines it has, ' +
    'WITHOUT pulling its text. Returns {found: true, document: {id, title, ' +
    'description, filename, mime_type, size_bytes, extraction_status, ' +
    'has_text, total_lines, created_at, updated_at}} or {found: false}. To ' +
    'read the actual contents use doc_read (by line range) or doc_grep (to ' +
    'find specific lines first); total_lines tells you the range you can ' +
    'address. Discover ids with doc_list or doc_search.',
  shortDescription: 'document overview + line count by id',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the document (from doc_list or doc_search).',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
