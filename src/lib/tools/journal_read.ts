/**
 * Read the journal entries for a specific day. Returns zero, one, or
 * two rows - at most one automatic and one user entry per day. Kept as
 * a distinct tool from journal_list so "what did I write today?" is a
 * single precise call rather than a ranged scan the LLM has to filter.
 *
 * Returns the full entry rows including `source_thread_ids` so the LLM
 * can surface "this is derived from <N> conversations" when summarising.
 */
import type { ToolDef } from './types';

export const journalRead: ToolDef = {
  name: 'journal_read',
  description:
    'Read the journal entries for a single date. Returns an array with ' +
    'up to two entries (automatic + user). `date` is ISO YYYY-MM-DD in ' +
    "the user's local timezone. Each entry has {id, entry_date, source, " +
    'content, topics, mood, people, source_thread_ids, created_at, ' +
    'updated_at}.',
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
  async execute(args, ctx) {
    const date = typeof args.date === 'string' ? args.date : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('date must match YYYY-MM-DD');
    }
    const rows = await ctx.supabase.getJournalEntriesForDate(date);
    return rows.map((e) => ({
      id: e.id,
      entry_date: e.entry_date,
      source: e.source,
      content: e.content,
      topics: e.topics,
      mood: e.mood,
      people: e.people,
      source_thread_ids: e.source_thread_ids,
      created_at: e.created_at,
      updated_at: e.updated_at,
    }));
  },
};
