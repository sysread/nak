/**
 * Schema-only export for doc_delete. Impl lives in `./doc_delete`.
 */
export const docDeleteSchema = {
  name: 'doc_delete',
  description:
    'Permanently delete a Library document, its searchable text, and its ' +
    'stored original file. Use when the user says a document is obsolete or ' +
    'asks you to remove it (e.g. "I switched insurers, delete the old ' +
    'policy"). Irreversible. Returns {deleted: true, document_id} or ' +
    '{deleted: false, reason}.',
  shortDescription: 'delete a Library document',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the document to delete (from doc_list or doc_search).',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
