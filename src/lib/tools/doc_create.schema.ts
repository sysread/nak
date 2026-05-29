/**
 * Schema-only export for doc_create. Impl lives in `./doc_create`.
 */
export const docCreateSchema = {
  name: 'doc_create',
  description:
    'Save a file the user attached to THIS conversation as a permanent ' +
    'Library document, so it becomes long-term searchable reference ' +
    'material (it would otherwise expire after 30 days as a message ' +
    'attachment). Identify the file by its exact filename as shown in the ' +
    'conversation. The model cannot upload files itself - this only ' +
    'promotes a file the user already attached. Returns ' +
    '{created: true, document_id, title} or {created: false, reason}. ' +
    'Always write a clear `description` of what the document is for.',
  shortDescription: 'save a pasted file to the Library',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        minLength: 1,
        description: 'Exact filename of the attachment in this conversation.',
      },
      title: {
        type: 'string',
        description: 'Display title for the Library (defaults to the filename).',
      },
      description: {
        type: 'string',
        description:
          'What this document is for, e.g. "2024 Aetna health insurance ' +
          'policy" or "HOA covenants and restrictions". Helps later recall.',
      },
    },
    required: ['filename', 'description'],
    additionalProperties: false,
  },
} as const;
