/**
 * Delete a journal entry by id. Two behaviours keyed on the entry's
 * `source`:
 *
 *   - source='user': straight hard-delete of the row. No side effects.
 *   - source='automatic': hard-delete, AND upsert every thread in
 *     `source_thread_ids` into `journal_thread_excludes` so the
 *     background worker does not recreate the entry on the next
 *     cycle. That's the "do not journal this conversation" flag the
 *     user-level delete semantics demand (see the Reflections plan:
 *     "per-thread 'do not journal' flag").
 *
 * The tool fetches the row first so it has the source-thread list
 * (the row vanishes as part of the delete, so a read-then-delete
 * sequence is the only way to get both). User-sourced deletes skip
 * the excludes population entirely.
 */
import type { ToolDef } from './types';

export const journalDelete: ToolDef = {
  name: 'journal_delete',
  description:
    'Delete a journal entry by id. For automatic entries, also marks ' +
    "the source conversations as excluded from future journaling so the " +
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
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) throw new Error('id is required');
    // Look up the row before delete so we can populate the excludes
    // table on the same round trip. The listJournalEntries path filters
    // to the signed-in user at RLS level, so an unknown-to-this-user id
    // returns nothing and we surface a clean error.
    const rows = await ctx.supabase.listJournalEntries({ limit: 500 });
    const target = rows.find((e) => e.id === id);
    if (!target) {
      throw new Error(`journal entry ${id} not found`);
    }
    const excludeThreadIds =
      target.source === 'automatic' ? target.source_thread_ids : [];
    await ctx.supabase.deleteJournalEntry(id, excludeThreadIds);
    return {
      id,
      source: target.source,
      excluded_threads: excludeThreadIds.length,
    };
  },
};
