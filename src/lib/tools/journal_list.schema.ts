/**
 * Schema-only export for the journal_list tool. Lives in its own
 * file so `tools/index.ts` can statically import the schema for the
 * catalog + wire payload without dragging the impl module's
 * runtime imports (and any future imports it grows) into the main
 * chunk. The full ToolDef arrives via dynamic import on first
 * dispatch - see the lazy wrapper in `tools/index.ts` and the
 * `journal_list.ts` impl.
 *
 * Keep the constants used by `parameters` here too: the impl file
 * re-imports them so the limit clamp stays in sync with what the
 * model is told it can pass.
 */
export const JOURNAL_LIST_DEFAULT_LIMIT = 20;
export const JOURNAL_LIST_MAX_LIMIT = 100;

export const journalListSchema = {
  name: 'journal_list',
  description:
    "List the user's journal entries, most-recent day first. " +
    'Optional `from` / `to` clip the range (ISO YYYY-MM-DD). Returns an ' +
    'array of {id, entry_date, source, content, topics, mood, people, ' +
    'updated_at}. Use journal_search for meaning-based queries; this is ' +
    'for date-based browsing.',
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
