/**
 * Reactive store for the Journal modal. Holds the most recent
 * listing of journal entries (newest day first) and a loading flag.
 * The modal reads these directly; writes go through the store helpers
 * so every subscriber re-renders.
 *
 * Parallel to `cookbook-store.svelte.ts`. Event-driven refresh via
 * `JOURNAL_CHANGE_EVENT` so a tool call or compose save updates the
 * list without explicit wiring at every call site.
 */
import type { JournalEntry, SupabaseService } from './supabase';
import { emitJournalChange } from './journal-events';
import {
  trainSpamFilterForThread,
  trainSpamFilterForUserEntry,
  untrainSpamFilterForThread,
  untrainSpamFilterForUserEntry,
} from './agents/journal/spam_filter';

interface JournalStore {
  entries: JournalEntry[];
  loading: boolean;
  /**
   * Set true after the first `loadJournalEntries` resolves (success OR
   * error). The lazy-load effect in Chat.svelte gates on this rather
   * than `entries.length === 0` - otherwise an account with zero
   * entries enters an infinite re-fetch loop: load resolves with [],
   * loading flips to false, the effect re-runs, sees still-empty +
   * not-loading, fires another load, and the spinner never stops.
   */
  loaded: boolean;
  error: string | null;
}

export const journal = $state<JournalStore>({
  entries: [],
  loading: false,
  loaded: false,
  error: null,
});

/**
 * Pull a fresh page of entries. Idempotent - re-entering while a
 * previous load is in flight is tolerated (the second one wins on
 * resolution; the `loading` flag is the latest intent).
 */
export async function loadJournalEntries(
  supabase: SupabaseService,
  opts: { limit?: number; from?: string; to?: string } = {}
): Promise<void> {
  journal.loading = true;
  journal.error = null;
  try {
    const rows = await supabase.listJournalEntries(opts);
    journal.entries = rows;
  } catch (err) {
    journal.error = err instanceof Error ? err.message : String(err);
  } finally {
    journal.loading = false;
    journal.loaded = true;
  }
}

/**
 * Create a user-sourced entry for the given date. Refreshes the
 * in-memory list on success and emits the change event so other
 * surfaces (e.g. a future drawer preview) can refetch.
 *
 * The schema allows multiple user entries per day, but the modal's
 * compose flow only ever creates one (it edits the existing one
 * when present). If a duplicate ever lands here from another path,
 * the resort below keeps the newest entry first by created_at.
 */
export async function saveUserEntry(
  supabase: SupabaseService,
  args: {
    entryDate: string;
    content: string;
    topics: string[];
    mood: string | null;
    people: string[];
  }
): Promise<JournalEntry> {
  const entry = await supabase.createUserJournalEntry(args);
  journal.entries = [entry, ...journal.entries].sort((a, b) => {
    if (a.entry_date !== b.entry_date) return a.entry_date < b.entry_date ? 1 : -1;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return a.created_at < b.created_at ? -1 : 1;
  });
  emitJournalChange();
  // Auto-ham. The user writing their own entry is the strongest
  // possible "this is journal-worthy" signal we have - the entry IS
  // the user's curated framing of what belongs in the journal. Feed
  // the entry's text directly to the model as ham training. We do
  // NOT retrain on edits (updateUserEntry below) - the original tokens
  // already shaped the model on save, and re-training on every save
  // would over-weight verbose users. The trade-off: heavy edits drift
  // the trained vocabulary slightly off the current content.
  void trainSpamFilterForUserEntry(supabase, entry.content);
  return entry;
}

export async function updateUserEntry(
  supabase: SupabaseService,
  id: string,
  patch: {
    content?: string;
    topics?: string[];
    mood?: string | null;
    people?: string[];
  }
): Promise<JournalEntry> {
  const entry = await supabase.updateJournalEntry(id, patch);
  journal.entries = journal.entries.map((e) => (e.id === id ? entry : e));
  emitJournalChange();
  return entry;
}

export async function deleteEntry(
  supabase: SupabaseService,
  id: string
): Promise<void> {
  const target = journal.entries.find((e) => e.id === id);
  const excludeThreadIds =
    target?.source === 'automatic' && target.thread_id ? [target.thread_id] : [];
  await supabase.deleteJournalEntry(id, excludeThreadIds);
  journal.entries = journal.entries.filter((e) => e.id !== id);
  emitJournalChange();
  // Train the spam filter against the deleted automatic entry's
  // source conversation. Best-effort; the helpers swallow errors
  // since training is a side-effect, not a blocking step. Skips
  // user entries (no thread tie) and orphaned automatic entries
  // whose source thread was deleted (FK on delete set null).
  //
  // If the user previously hammed the entry, rescind that vote
  // first - otherwise the same tokens contribute +1 ham AND +1
  // spam, polluting both classes. The untrain RPC floors at zero
  // so an over-untrain (the train side failed silently after the
  // ham_marked_at flip) is a no-op rather than an underflow.
  if (target?.source === 'automatic' && target.thread_id) {
    const threadId = target.thread_id;
    const wasHam = target.ham_marked_at !== null;
    void (async () => {
      if (wasHam) {
        await untrainSpamFilterForThread(supabase, threadId, 'ham');
      }
      await trainSpamFilterForThread(supabase, threadId, 'spam');
    })();
  }
  // User entries get auto-hammed on creation. Rescind that vote on
  // delete so a written-then-deleted entry doesn't leave orphaned
  // ham evidence in the model. The untrain RPC floors at zero, so
  // legacy user entries (created before auto-ham wiring) decrement
  // to no-op rather than underflowing.
  if (target?.source === 'user' && target.content) {
    void untrainSpamFilterForUserEntry(supabase, target.content);
  }
}

/**
 * Mark an automatic entry as appropriate (the "ham" button). One-shot
 * per entry - the supabase call's WHERE clause guards against double-
 * trains via a stale tab. On success, the source thread's tokens get
 * trained as ham. Returns the updated entry on first click; null on
 * subsequent clicks (already marked) so callers can show a no-op
 * state without re-training.
 */
export async function markEntryHam(
  supabase: SupabaseService,
  id: string
): Promise<JournalEntry | null> {
  const updated = await supabase.markJournalEntryHam(id);
  if (!updated) return null;
  journal.entries = journal.entries.map((e) => (e.id === id ? updated : e));
  emitJournalChange();
  if (updated.thread_id) {
    void trainSpamFilterForThread(supabase, updated.thread_id, 'ham');
  }
  return updated;
}
