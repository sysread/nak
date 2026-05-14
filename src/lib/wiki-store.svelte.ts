/**
 * Reactive store shared by the Wiki drawer tab. Sidebar
 * (`WikiList.svelte`) and main panel (`Wiki.svelte`) both bind
 * against `wikiStore`, so a search keystroke in the sidebar filters
 * the drawer listing and a panel-side mutation (create / edit /
 * delete) updates the drawer without a refetch.
 *
 * Parallel to `memories-store.svelte.ts`. Search semantics call
 * `searchWikiArticlesSemantic` so the drawer matches the assistant's
 * `wiki_search` tool exactly.
 */
import type { SupabaseService, WikiArticle } from './supabase';
import type { VeniceClient } from './venice';
import { emitWikiChange } from './wiki-events';
import { searchWikiArticlesSemantic } from './wiki';

interface WikiStore {
  results: WikiArticle[];
  loading: boolean;
  /** Set true after the first `runWikiSearch` resolves, success or error. */
  loaded: boolean;
  error: string | null;
  /** Bound to the sidebar search input. */
  query: string;
}

export const wikiStore = $state<WikiStore>({
  results: [],
  loading: false,
  loaded: false,
  error: null,
  query: '',
});

// Match the assistant's `wiki_search` per-call cap so the human UI
// never hides articles the assistant can reach.
const WIKI_LIST_LIMIT = 100;

let currentAbort: AbortController | null = null;

/**
 * Run a fresh search against `wikiStore.query`. Callers should
 * debounce - this runs immediately. Cancels any in-flight request so
 * a stale result can't clobber the latest query.
 */
export async function runWikiSearch(
  supabase: SupabaseService,
  venice: VeniceClient | null,
): Promise<void> {
  if (currentAbort) currentAbort.abort();
  const ctl = new AbortController();
  currentAbort = ctl;
  wikiStore.loading = true;
  wikiStore.error = null;
  try {
    const hits = await searchWikiArticlesSemantic(
      wikiStore.query.trim(),
      WIKI_LIST_LIMIT,
      { supabase, venice, signal: ctl.signal },
    );
    if (ctl.signal.aborted) return;
    wikiStore.results = hits;
  } catch (err) {
    if (ctl.signal.aborted) return;
    wikiStore.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (currentAbort === ctl) currentAbort = null;
    if (!ctl.signal.aborted) {
      wikiStore.loading = false;
      wikiStore.loaded = true;
    }
  }
}

/**
 * Replace one row in `results` without re-querying. Called from the
 * panel after `updateWikiArticle` so the list doesn't visually
 * reorder while the user is mid-edit.
 */
export function patchWikiRow(id: string, patch: Partial<WikiArticle>): void {
  wikiStore.results = wikiStore.results.map((a) =>
    a.id === id ? { ...a, ...patch } : a,
  );
}

/** Drop one row from the list. */
export function removeWikiRow(id: string): void {
  wikiStore.results = wikiStore.results.filter((a) => a.id !== id);
}

/**
 * Append a freshly-created article into the list. Inserts in the
 * alphabetical position (case-insensitive on title) so the listing
 * stays sorted without a refetch.
 */
export function addWikiRow(row: WikiArticle): void {
  const next = [...wikiStore.results];
  const lc = row.title.toLowerCase();
  let insertAt = next.findIndex((a) => a.title.toLowerCase() > lc);
  if (insertAt < 0) insertAt = next.length;
  next.splice(insertAt, 0, row);
  wikiStore.results = next;
}

/**
 * Settings -> Wiki -> Reset. Wipes every wiki article the user owns
 * AND clears the per-thread wiki pipeline state so the per-
 * conversation agent re-evaluates from scratch. Backed by the
 * transactional `reset_wiki_data` RPC; we mirror by clearing the
 * in-memory list and emitting a change event so the Wiki drawer
 * repaints immediately.
 *
 * The caller is responsible for the confirmation prompt - this
 * function assumes the user has already accepted the irreversible
 * action.
 *
 * Note: the librarian's last-run timestamp on `profiles` is left
 * alone. A reset is about the article store and the per-thread
 * pipeline; the librarian's cadence is orthogonal.
 */
export async function resetAllWikiData(
  supabase: SupabaseService,
): Promise<void> {
  await supabase.resetWikiData();
  wikiStore.results = [];
  wikiStore.loaded = true;
  wikiStore.error = null;
  emitWikiChange();
}
