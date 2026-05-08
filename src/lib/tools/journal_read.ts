/**
 * Read the journal entries for a specific day. Returns any number of
 * rows: at most one user entry plus one automatic row per conversation
 * the user had on that day. Kept as a distinct tool from journal_list
 * so "what did I write today?" is a single precise call rather than a
 * ranged scan the LLM has to filter.
 *
 * Each row carries `thread_id` (and `thread_title` when the source
 * thread still exists) so the LLM can name the source conversation
 * when summarising back to the user.
 */
import type { ToolDef } from './types';
import { journalReadSchema } from './journal_read.schema';

export const journalRead: ToolDef = {
  ...journalReadSchema,
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
      thread_id: e.thread_id,
      thread_title: e.thread_title,
      created_at: e.created_at,
      updated_at: e.updated_at,
    }));
  },
};
