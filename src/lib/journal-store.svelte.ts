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
import type { VeniceClient } from './venice';
import { emitJournalChange } from './journal-events';
// `JournalAgent` is type-only so the chunker doesn't pull
// agent.ts (and its transitive `snowball-stemmers` import via
// spam_filter.ts, ~60 kB gzipped) into the main bundle. The class
// is instantiated only inside regenerateAutomaticEntry, which fires
// on a user clicking Regenerate inside the Journal modal - we
// dynamic-import the implementation there.
import type { JournalAgent, RegenerateResult } from './agents/journal/agent';
export type { RegenerateResult };

// Spam-filter helpers live in `./agents/journal/spam_filter`, which
// pulls in `snowball-stemmers` (~865 kB raw / ~60 kB gzipped). The
// filter only fires on explicit journal actions (save / delete / ham
// click), so we dynamic-import the module on-demand to keep
// snowball out of the main chunk. Each call site goes through
// `loadSpamFilter()` and reads the helper off the resolved module
// namespace. Module is cached after first load, so subsequent uses
// pay only a Promise resolution.
async function loadSpamFilter(): Promise<
  typeof import('./agents/journal/spam_filter')
> {
  return import('./agents/journal/spam_filter');
}

// JournalAgent ctor lives on the same lazy path - its module
// chain is what pulls spam_filter into main if we statically
// import it here.
async function loadJournalAgentClass(): Promise<typeof JournalAgent> {
  const m = await import('./agents/journal/agent');
  return m.JournalAgent;
}

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
  void loadSpamFilter().then((m) =>
    m.trainSpamFilterForUserEntry(supabase, entry.content)
  );
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
      const m = await loadSpamFilter();
      if (wasHam) {
        await m.untrainSpamFilterForThread(supabase, threadId, 'ham');
      }
      await m.trainSpamFilterForThread(supabase, threadId, 'spam');
    })();
  }
  // User entries get auto-hammed on creation. Rescind that vote on
  // delete so a written-then-deleted entry doesn't leave orphaned
  // ham evidence in the model. The untrain RPC floors at zero, so
  // legacy user entries (created before auto-ham wiring) decrement
  // to no-op rather than underflowing.
  if (target?.source === 'user' && target.content) {
    const content = target.content;
    void loadSpamFilter().then((m) =>
      m.untrainSpamFilterForUserEntry(supabase, content)
    );
  }
}

/**
 * "Save the decline" path for the regenerate modal. Runs when the
 * user agrees with the journaler's worthy=false decision (e.g. the
 * source conversation turned out to be purely technical with no
 * inner-life material) and wants to dismiss the existing entry
 * without re-triggering it. Three steps:
 *
 *   1. Delete the existing journal entry. The body the user is
 *      looking at is being abandoned - the journaler decided it
 *      doesn't merit an entry, and the user accepted that read.
 *   2. Advance the thread's `last_journaled_msg_id` to the current
 *      terminal via {@link SupabaseService.markThreadJournaledForUser}.
 *      Without this the worker would re-claim the same thread on
 *      its next sweep, run the agent again, and most likely return
 *      worthy=false a second time - wasted Venice call.
 *   3. Crucially, do NOT add the thread to journal_thread_excludes
 *      (the way deleteEntry does for thumbs-down) and do NOT train
 *      the spam filter. The semantics are "this snapshot wasn't
 *      worth journaling" rather than "this kind of conversation is
 *      never journal-worthy" - if the user has more reflective
 *      turns later in the same thread, the next claim should still
 *      consider it.
 *
 * The orphan-thread case (entry.thread_id is null - thread was
 * deleted out from under the entry) skips step 2 silently. Step 1
 * still runs so the orphan row leaves the journal.
 */
export async function dismissDeclinedRegenerate(
  supabase: SupabaseService,
  entry: JournalEntry
): Promise<void> {
  // Empty excludes array: this is the "review only" delete, not
  // the "this kind of conversation is spam" delete the thumbs-down
  // button uses.
  await supabase.deleteJournalEntry(entry.id, []);
  journal.entries = journal.entries.filter((e) => e.id !== entry.id);
  emitJournalChange();
  if (entry.source === 'automatic' && entry.thread_id) {
    // Best-effort. A failure here means the worker may re-process
    // this thread on the next sweep and rediscover the
    // worthy=false outcome itself - wasteful but not broken.
    try {
      await supabase.markThreadJournaledForUser(entry.thread_id);
    } catch {
      // Swallow - the entry is already gone from the user's view,
      // and the worker has its own idempotent path.
    }
  }
}

/**
 * Run the journal agent in regenerate mode against an existing
 * automatic entry. Bypasses the worker queue (no claim, no lease,
 * no pointer advance) and the worthy/not-worthy gate - the user
 * has clicked Regenerate, which is an explicit opt-in. Does NOT
 * write the result; callers preview the proposed entry and either
 * persist via {@link acceptRegeneratedEntry} or discard.
 *
 * Throws when the source thread is gone, the model returned
 * unparseable output, or the call was aborted - the modal renders
 * the error inline so the user can retry or cancel.
 */
export async function regenerateAutomaticEntry(
  supabase: SupabaseService,
  venice: VeniceClient,
  entry: JournalEntry,
  /**
   * Settings -> AI -> About you. Empty strings are "not set"; the
   * agent's prompt builder suppresses the "About the user" block
   * when both are empty. Caller passes `app.userName` /
   * `app.userLocation` so the regenerated entry refers to the user
   * by name (rather than the generic "User") on the same terms as
   * the background worker.
   */
  userName: string,
  userLocation: string,
  signal?: AbortSignal
): Promise<RegenerateResult> {
  if (entry.source !== 'automatic') {
    throw new Error('Only automatic entries can be regenerated.');
  }
  if (!entry.thread_id) {
    throw new Error(
      'Source conversation no longer exists; cannot regenerate.'
    );
  }
  const trimmedName = userName.trim();
  const trimmedLocation = userLocation.trim();
  const profile =
    trimmedName.length === 0 && trimmedLocation.length === 0
      ? null
      : {
          name: trimmedName.length > 0 ? trimmedName : null,
          location: trimmedLocation.length > 0 ? trimmedLocation : null,
        };
  const AgentClass = await loadJournalAgentClass();
  const agent = new AgentClass(venice, supabase, undefined, profile);
  return agent.regenerate({
    threadId: entry.thread_id,
    entryDate: entry.entry_date,
    existingEntry: {
      content: entry.content,
      topics: entry.topics,
      mood: entry.mood,
      people: entry.people,
    },
    signal,
  });
}

/**
 * Persist a regenerated entry's content/topics/mood/people over the
 * existing automatic row. The thread's `last_journaled_msg_id`
 * pointer is intentionally NOT advanced - the entry was already
 * journaled up to wherever the worker left it; the regenerate just
 * rewrites the body. `ham_marked_at` is preserved for the same
 * reason - the user's prior "this conversation IS journal-worthy"
 * vote still stands; only the entry's wording changed.
 *
 * If the conversation gets new turns later, the worker will pick
 * the thread up again, fetch the regenerated entry as the
 * "existing entry" prior, and extend it via the standard prompt
 * flow. The regenerated content is treated as the base from there
 * on - same way a worker-written entry would be.
 */
export async function acceptRegeneratedEntry(
  supabase: SupabaseService,
  id: string,
  proposed: {
    content: string;
    topics: string[];
    mood: string | null;
    people: string[];
  }
): Promise<JournalEntry> {
  const entry = await supabase.updateJournalEntry(id, {
    content: proposed.content,
    topics: proposed.topics,
    mood: proposed.mood,
    people: proposed.people,
  });
  journal.entries = journal.entries.map((e) => (e.id === id ? entry : e));
  emitJournalChange();
  return entry;
}

/**
 * Settings -> Journal -> Reset. Wipes every journal entry the user
 * owns AND clears the per-thread journal pipeline state so the
 * background worker re-evaluates conversations from scratch. The
 * server-side RPC does both in one transaction (see
 * `reset_journal_data` in schema.sql); we mirror by clearing the
 * in-memory list and emitting a change event so the Journal modal
 * (and any future drawer) repaint immediately.
 *
 * The caller is responsible for the confirmation prompt - this
 * function assumes the user has already accepted the irreversible
 * action.
 *
 * Note: the spam filter's accumulated counts (`journal_spam_tokens` /
 * `journal_spam_stats`) are intentionally left alone. Reset is "wipe
 * the entries and re-process from scratch"; the trained classifier
 * represents what the user has taught about journal-worthiness over
 * time and should outlive a single sweep. A user who wants a fully
 * blank slate can flip the auto-journal toggle off before resetting.
 */
export async function resetAllJournalData(
  supabase: SupabaseService
): Promise<void> {
  await supabase.resetJournalData();
  journal.entries = [];
  journal.loaded = true;
  journal.error = null;
  emitJournalChange();
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
    const threadId = updated.thread_id;
    void loadSpamFilter().then((m) =>
      m.trainSpamFilterForThread(supabase, threadId, 'ham')
    );
  }
  return updated;
}
