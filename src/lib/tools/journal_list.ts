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
 *
 * The schema half of this tool lives in `./journal_list.schema.ts`
 * so tools/index.ts can statically include it in the catalog
 * without pulling this impl into the main chunk - this file is
 * only reached via dynamic import on first dispatch.
 */
import type { ToolDef } from './types';
import {
  journalListSchema,
  JOURNAL_LIST_DEFAULT_LIMIT,
  JOURNAL_LIST_MAX_LIMIT,
} from './journal_list.schema';

export const journalList: ToolDef = {
  ...journalListSchema,
  async execute(args, ctx) {
    const from = typeof args.from === 'string' ? args.from : undefined;
    const to = typeof args.to === 'string' ? args.to : undefined;
    const rawLimit =
      typeof args.limit === 'number' ? args.limit : JOURNAL_LIST_DEFAULT_LIMIT;
    const limit = Math.max(
      1,
      Math.min(JOURNAL_LIST_MAX_LIMIT, Math.floor(rawLimit))
    );
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
