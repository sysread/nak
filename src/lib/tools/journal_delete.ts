/**
 * Delete a journal entry by id. Two behaviours keyed on the entry's
 * `source`:
 *
 *   - source='user': straight hard-delete of the row. No side effects.
 *   - source='automatic': hard-delete, AND upsert the entry's
 *     `thread_id` into `journal_thread_excludes` so the background
 *     worker does not recreate the entry on the next cycle. That's
 *     the "do not journal this conversation" flag the user-level
 *     delete semantics demand.
 *
 * The tool fetches the row first so it has the thread id (the row
 * vanishes as part of the delete, so a read-then-delete sequence is
 * the only way to get both). User-sourced deletes skip the excludes
 * population entirely. An automatic entry whose source thread was
 * deleted (FK is `on delete set null` on `thread_id`) carries
 * `thread_id=null`; nothing to exclude in that case, so the delete
 * is just a row removal.
 */
import type { ToolDef } from './types';
import {
  trainSpamFilterForThread,
  untrainSpamFilterForThread,
} from '../agents/journal/spam_filter';

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
      target.source === 'automatic' && target.thread_id ? [target.thread_id] : [];
    await ctx.supabase.deleteJournalEntry(id, excludeThreadIds);
    // Train the spam filter against the source conversation. The
    // user removing an automatic entry is the strong "this kind of
    // conversation should NOT auto-journal" signal. journal_thread_excludes
    // already prevents the same thread from re-journaling, so this
    // training contribution is naturally one-shot per thread.
    //
    // If the entry had been hammed previously, untrain ham first
    // so the same tokens don't contribute to both classes. See the
    // matching block in journal-store.svelte.ts:deleteEntry.
    if (target.source === 'automatic' && target.thread_id) {
      if (target.ham_marked_at !== null) {
        await untrainSpamFilterForThread(ctx.supabase, target.thread_id, 'ham');
      }
      await trainSpamFilterForThread(ctx.supabase, target.thread_id, 'spam');
    }
    return {
      id,
      source: target.source,
      excluded_threads: excludeThreadIds.length,
    };
  },
};
