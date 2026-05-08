/**
 * Schema-only export for journal_read. Impl lives in `./journal_read`.
 */
export const journalReadSchema = {
  name: 'journal_read',
  description:
    'Read the journal entries for a single date. Returns an array of ' +
    'entries (any number; at most one user entry plus one automatic ' +
    'entry per source conversation that day). `date` is ISO YYYY-MM-DD ' +
    "in the user's local timezone. Each entry has {id, entry_date, " +
    'source, content, topics, mood, people, thread_id, thread_title, ' +
    'created_at, updated_at}.',
  shortDescription: 'read one day of journal entries',
  parameters: {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        description: "ISO date (YYYY-MM-DD) in the user's local timezone.",
      },
    },
    required: ['date'],
    additionalProperties: false,
  },
} as const;
