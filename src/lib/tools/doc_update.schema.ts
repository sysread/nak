/**
 * Schema-only export for doc_update. Impl lives in `./doc_update`.
 */
export const docUpdateSchema = {
  name: 'doc_update',
  description:
    "Update a Library document's title or description (the \"what this is " +
    'for" note). Cannot change the document’s text - that is bound to the ' +
    'uploaded file; the user re-uploads to replace content. Use this to ' +
    'rename a document or clarify its purpose. Returns ' +
    '{updated: true, document_id} or {updated: false, reason}.',
  shortDescription: 'edit a document’s title or description',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the document (from doc_list or doc_search).',
      },
      title: { type: 'string', description: 'New display title.' },
      description: {
        type: 'string',
        description: 'New "what this is for" description.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
