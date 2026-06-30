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
import { getCachedArticles, offlineStatus } from './offline-sync.svelte';

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
  /**
   * Every `favorite`-flagged article (complete, not paged), title ASC.
   * Rendered as a "Favorites" bucket above the browse list - and a
   * favorite is what marks an article for offline caching, so this is
   * also the set `offline-sync` mirrors into IndexedDB. Refetched whole
   * by `loadWikiFirstPage`; empty while a search is active (the bucket
   * only makes sense over the browse regime). Mirrors
   * `cookbook.favorites`.
   */
  favorites: WikiArticle[];
  loading: boolean;
  /** Set true after the first load resolves, success or error. */
  loaded: boolean;
  /**
   * True when `results` / `favorites` were served from the IndexedDB
   * offline mirror because the authoritative fetch couldn't reach the
   * server. In this regime there is no browse list and no search (both
   * need the server), so the sidebar shows only the saved Favorites
   * bucket and hides the search box. Cleared on the next successful
   * network load (mount, reconnect, or a wiki-change refresh).
   */
  fromCache: boolean;
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
  favorites: [],
  loading: false,
  loaded: false,
  fromCache: false,
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

  // Cache-first: paint the saved Favorites bucket from the IndexedDB
  // mirror right away. Opening the tab offline or on a dead link then
  // shows the saved articles immediately instead of a spinner that
  // blocks on a fetch that may never fail fast (airplane mode rejects
  // only after a long connection timeout). The network result below
  // replaces this.
  const cachedFavorites = await getCachedArticles();
  if (cachedFavorites.length > 0) wikiStore.favorites = cachedFavorites;

  // Known offline: don't attempt the doomed fetch. Settle into the
  // buckets-only regime now (search box hidden) so there's no hang.
  // offlineStatus.online is the app-wide connectivity source the
  // read-through and the disabled-control gating already trust.
  if (!offlineStatus.online) {
    wikiStore.favorites = cachedFavorites;
    wikiStore.results = [];
    wikiStore.offset = 0;
    wikiStore.hasMore = false;
    wikiStore.fromCache = true;
    wikiStore.error = null;
    wikiStore.loading = false;
    wikiStore.loaded = true;
    return;
  }

  try {
    // Fetch the browse page and the complete Favorites bucket together.
    // Favorites is its own whole-set fetch (not a slice of the page)
    // because it renders above the list and a favorited article living
    // past the loaded page window would otherwise vanish from it -
    // same rationale as cookbook.favorites.
    const [page, favorites] = await Promise.all([
      supabase.listWikiArticlesPage({
        offset: 0,
        pageSize: DEFAULT_LIST_PAGE_SIZE,
      }),
      supabase.listFavoriteWikiArticles(),
    ]);
    wikiStore.results = page.rows;
    wikiStore.offset = page.rows.length;
    wikiStore.hasMore = page.hasMore;
    wikiStore.favorites = favorites;
    wikiStore.fromCache = false;
    wikiStore.error = null;
  } catch (err) {
    // Online at the start but the fetch failed - either we dropped
    // offline mid-request, or a transient Supabase blip. If we're
    // offline now, keep the cache-painted Favorites and enter the
    // buckets-only regime (no browse list offline - it needs the
    // server); otherwise surface the error (still authoritative, an
    // error beats silently showing a stale subset).
    if (!offlineStatus.online) {
      wikiStore.favorites = cachedFavorites;
      wikiStore.results = [];
      wikiStore.offset = 0;
      wikiStore.hasMore = false;
      wikiStore.fromCache = true;
      wikiStore.error = null;
    } else {
      wikiStore.fromCache = false;
      wikiStore.error = err instanceof Error ? err.message : String(err);
    }
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
    // A search round-trip only resolves online, so we're authoritative
    // again - drop any offline-cache regime left over from before.
    wikiStore.fromCache = false;
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
  // A favorited article also lives in the Favorites bucket; keep its
  // copy in step so a title / content edit shows there too.
  wikiStore.favorites = wikiStore.favorites.map((a) =>
    a.id === id ? { ...a, ...patch } : a,
  );
}

/**
 * Reflect a favorite toggle locally without a refetch: patch the row's
 * flag in `results` and add/remove it from the Favorites bucket
 * (re-sorted alphabetically so the bucket order matches the browse
 * list). The full `article` is passed so an add has a row to insert
 * even when the toggle fires from a detail view whose row was never in
 * `results`.
 */
export function applyWikiFavorite(article: WikiArticle, favorite: boolean): void {
  wikiStore.results = wikiStore.results.map((a) =>
    a.id === article.id ? { ...a, favorite } : a,
  );
  if (favorite) {
    if (!wikiStore.favorites.some((a) => a.id === article.id)) {
      const next = [...wikiStore.favorites, { ...article, favorite: true }];
      next.sort((a, b) =>
        a.title.toLowerCase().localeCompare(b.title.toLowerCase()),
      );
      wikiStore.favorites = next;
    }
  } else {
    wikiStore.favorites = wikiStore.favorites.filter((a) => a.id !== article.id);
  }
}

/** Drop one row from the list (and the Favorites bucket if present). */
export function removeWikiRow(id: string): void {
  wikiStore.results = wikiStore.results.filter((a) => a.id !== id);
  wikiStore.favorites = wikiStore.favorites.filter((a) => a.id !== id);
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
  wikiStore.favorites = [];
  wikiStore.loaded = true;
  wikiStore.error = null;
  emitWikiChange();
}
