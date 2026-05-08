/**
 * Schema-only export for journal_read. Impl lives in `./journal_read`.
 */
export const journalReadSchema = {
  name: 'journal_read',
  description:
    "Read journal entries for a single date in the user's local " +
    'timezone. Returns an array of entries (at most one user entry ' +
    'plus one automatic entry per source conversation that day). Each ' +
    'has {id, entry_date, source, content, topics, mood, people, ' +
    'thread_id, thread_title, created_at, updated_at}.',
  shortDescription: 'read one day of journal entries',
  parameters: {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        description: "ISO date (YYYY-MM-DD), user's local timezone.",
      },
    },
    required: ['date'],
    additionalProperties: false,
  },
} as const;
