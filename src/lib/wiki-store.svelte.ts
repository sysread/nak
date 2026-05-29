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
import {
  DEFAULT_LIST_PAGE_SIZE,
  type SupabaseService,
  type WikiArticle,
} from './supabase';
import { emitWikiChange } from './wiki-events';
import { searchWikiArticlesSemantic } from './wiki';

interface WikiStore {
  /**
   * The articles currently shown. Two regimes feed this list:
   *
   *   - Browse (empty query): an offset window paged in from
   *     `listWikiArticlesPage`, alphabetical by title, grown by the
   *     sidebar's infinite-scroll sentinel via `loadMoreWiki`. Rendered
   *     in server order - no client re-sort, which would disagree with
   *     the server's page boundaries mid-scroll.
   *   - Search (non-empty query): a capped, unpaged relevance set from
   *     `searchWikiArticlesSemantic`. `hasMore` is forced false here.
   */
  results: WikiArticle[];
  loading: boolean;
  /** Set true after the first load resolves, success or error. */
  loaded: boolean;
  error: string | null;
  /** Bound to the sidebar search input. */
  query: string;
  /** Row count paged into `results` so far - the next browse page's offset. */
  offset: number;
  /**
   * False once the browse list is drained, or whenever a search is
   * active (search results are capped, not paged). Gates the sidebar's
   * infinite-scroll sentinel.
   */
  hasMore: boolean;
  /** True while a `loadMoreWiki` page is in flight (drives the sentinel spinner). */
  loadingMore: boolean;
}

export const wikiStore = $state<WikiStore>({
  results: [],
  loading: false,
  loaded: false,
  error: null,
  query: '',
  offset: 0,
  hasMore: false,
  loadingMore: false,
});

// Match the assistant's `wiki_search` per-call cap so a search never
// hides articles the assistant can reach.
const WIKI_LIST_LIMIT = 100;

let currentAbort: AbortController | null = null;

/**
 * Load the wiki browse list from the first page (empty-query regime),
 * alphabetical by title. Resets the offset window. Called by the
 * sidebar when the query is empty - on mount and on clearing a search.
 */
export async function loadWikiFirstPage(
  supabase: SupabaseService,
): Promise<void> {
  // Supersede any in-flight semantic search so a slow embed from a
  // just-cleared query can't clobber the fresh browse list.
  if (currentAbort) currentAbort.abort();
  wikiStore.loading = true;
  wikiStore.error = null;
  try {
    const page = await supabase.listWikiArticlesPage({
      offset: 0,
      pageSize: DEFAULT_LIST_PAGE_SIZE,
    });
    wikiStore.results = page.rows;
    wikiStore.offset = page.rows.length;
    wikiStore.hasMore = page.hasMore;
  } catch (err) {
    wikiStore.error = err instanceof Error ? err.message : String(err);
  } finally {
    wikiStore.loading = false;
    wikiStore.loaded = true;
  }
}

/**
 * Append the next browse page. No-op while a page is in flight, when
 * the list is drained, or when a search is active, so the sidebar
 * sentinel can fire it freely. A failed page leaves `hasMore` intact
 * so the next scroll retries.
 */
export async function loadMoreWiki(
  supabase: SupabaseService,
): Promise<void> {
  if (wikiStore.loadingMore || !wikiStore.hasMore) return;
  if (wikiStore.query.trim().length > 0) return;
  wikiStore.loadingMore = true;
  try {
    const page = await supabase.listWikiArticlesPage({
      offset: wikiStore.offset,
      pageSize: DEFAULT_LIST_PAGE_SIZE,
    });
    wikiStore.results = [...wikiStore.results, ...page.rows];
    wikiStore.offset += page.rows.length;
    wikiStore.hasMore = page.hasMore;
    wikiStore.error = null;
  } catch (err) {
    wikiStore.error = err instanceof Error ? err.message : String(err);
  } finally {
    wikiStore.loadingMore = false;
  }
}

/**
 * Drive `wikiStore` from the bound query. The single entry point every
 * caller uses; it dispatches on the query:
 *
 *   - Empty query -> the paginated browse list (`loadWikiFirstPage`).
 *   - Non-empty query -> the capped semantic search below.
 *
 * Callers should debounce - this runs immediately. Cancels any
 * in-flight search so a stale result can't clobber the latest query.
 */
export async function runWikiSearch(
  supabase: SupabaseService,
): Promise<void> {
  if (wikiStore.query.trim().length === 0) {
    return loadWikiFirstPage(supabase);
  }
  if (currentAbort) currentAbort.abort();
  const ctl = new AbortController();
  currentAbort = ctl;
  wikiStore.loading = true;
  wikiStore.error = null;
  try {
    const hits = await searchWikiArticlesSemantic(
      wikiStore.query.trim(),
      WIKI_LIST_LIMIT,
      { supabase, signal: ctl.signal },
    );
    if (ctl.signal.aborted) return;
    wikiStore.results = hits;
    // Search results are capped, not paged - close the sentinel.
    wikiStore.offset = hits.length;
    wikiStore.hasMore = false;
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
