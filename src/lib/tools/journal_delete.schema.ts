/**
 * Schema-only export for journal_delete. Impl lives in
 * `./journal_delete`.
 */
export const journalDeleteSchema = {
  name: 'journal_delete',
  description:
    'Delete a journal entry by id. For automatic entries, also marks ' +
    'the source conversations as excluded from future journaling so the ' +
    'background worker does not regenerate the entry. For user-authored ' +
    'entries, a plain delete. Returns {id, source, excluded_threads} so ' +
    'the caller can confirm what happened.',
  shortDescription: 'delete a journal entry',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        minLength: 1,
        description: 'Journal entry id (UUID).',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
