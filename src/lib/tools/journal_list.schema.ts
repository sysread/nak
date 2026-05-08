/**
 * Schema-only export for journal_list. Impl lives in `./journal_list`.
 * The constants are exported here so the impl can re-import them and
 * keep the limit clamp in sync with what the model is told.
 */
export const JOURNAL_LIST_DEFAULT_LIMIT = 20;
export const JOURNAL_LIST_MAX_LIMIT = 100;

export const journalListSchema = {
  name: 'journal_list',
  description:
    "List the user's journal entries, most-recent day first. " +
    'Optional from/to clip the range (ISO YYYY-MM-DD). Returns ' +
    '{id, entry_date, source, content, topics, mood, people, ' +
    'updated_at}[]. Use journal_search for meaning-based queries.',
  shortDescription: 'list journal entries by date',
  parameters: {
    type: 'object',
    properties: {
      from: {
        type: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        description: 'Inclusive lower bound (ISO YYYY-MM-DD).',
      },
      to: {
        type: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        description: 'Inclusive upper bound (ISO YYYY-MM-DD).',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: JOURNAL_LIST_MAX_LIMIT,
        description: `Max entries (default ${JOURNAL_LIST_DEFAULT_LIMIT}, max ${JOURNAL_LIST_MAX_LIMIT}).`,
      },
    },
    additionalProperties: false,
  },
} as const;
