/**
 * Schema-only export for journal_delete. Impl lives in
 * `./journal_delete`.
 */
export const journalDeleteSchema = {
  name: 'journal_delete',
  description:
    'Delete a journal entry by id. Automatic entries also mark their ' +
    'source conversations as excluded so the background worker does ' +
    "not regenerate them; user-authored entries are a plain delete. " +
    'Returns {id, source, excluded_threads}.',
  shortDescription: 'delete a journal entry',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        minLength: 1,
        description: 'Journal entry UUID.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
