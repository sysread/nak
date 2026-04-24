/**
 * List journal entries most-recent-day-first within an optional date
 * range. The LLM uses this to browse what the user has written or
 * what the journaling agent has captured across days - a "what did I
 * journal last week?" question resolves here rather than through
 * search (which filters by meaning).
 *
 * Result shape is a compact projection - `content` is included in
 * full because the LLM typically wants to quote or reference text
 * from recent entries, and truncating would force a second
 * `journal_read` round trip.
 */
import type { ToolDef } from './types';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export const journalList: ToolDef = {
  name: 'journal_list',
  description:
    "List the user's Reflections (journal entries), most-recent day first. " +
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
        maximum: MAX_LIMIT,
        description: `Max entries (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
      },
    },
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const from = typeof args.from === 'string' ? args.from : undefined;
    const to = typeof args.to === 'string' ? args.to : undefined;
    const rawLimit = typeof args.limit === 'number' ? args.limit : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(rawLimit)));
    const rows = await ctx.supabase.listJournalEntries({ from, to, limit });
    return rows.map((e) => ({
      id: e.id,
      entry_date: e.entry_date,
      source: e.source,
      content: e.content,
      topics: e.topics,
      mood: e.mood,
      people: e.people,
      updated_at: e.updated_at,
    }));
  },
};
