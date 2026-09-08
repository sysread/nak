/**
 * Schema-only export for doc_save - the create/update-merged Library
 * metadata write (see ./upsert.ts for the routing contract). Impl
 * lives in `./doc_save` on the edge side.
 */
export const docSaveSchema = {
  name: 'doc_save',
  description:
    'Save Library document metadata: promote an attached file into a ' +
    'permanent document (omit id), or update an existing document\'s ' +
    'title/description (pass id from doc_list or doc_grep). Creating ' +
    'with a filename that exactly matches an existing document updates ' +
    'that document instead; a near-match is refused with the ' +
    'candidates named. The document text is bound to the uploaded file ' +
    'and is not editable here - replacing content is a user ' +
    're-upload. Returns {created: true, document_id, title}, ' +
    '{updated: true, document_id}, or {updated: false, reason}.',
  shortDescription: 'save a Library document',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'UUID of the document to update (from doc_list or doc_grep). ' +
          'Omit to promote an attachment into a new document.',
      },
      filename: {
        type: 'string',
        minLength: 1,
        description:
          'Exact filename of the attachment in this conversation. ' +
          'Required on create (the model cannot upload files itself - ' +
          'this only promotes a file the user already attached).',
      },
      title: {
        type: 'string',
        description:
          'Display title for the Library (defaults to the filename on ' +
          'create).',
      },
      description: {
        type: 'string',
        description:
          'What this document is for, e.g. "2024 Aetna health insurance ' +
          'policy" or "HOA covenants and restrictions". Required on ' +
          'create; on update, the new "what this is for" note.',
      },
    },
    required: ['description'],
    additionalProperties: false,
  },
} as const;
