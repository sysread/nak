/**
 * Reactive store shared by the Skills drawer tab. Sidebar
 * (`SkillList.svelte`) and main panel (`Skills.svelte`) both bind
 * against `skillsStore`, so a search keystroke in the sidebar
 * filters the listing and a panel-side mutation (create / edit /
 * delete) shows up in the sidebar without a remount.
 *
 * Parallel to `wiki-store.svelte.ts` and `memories-store.svelte.ts`
 * with these deltas: no favorites bucket, no offline cache, no
 * relations map, no topic vocabulary - just the paged browse window
 * and the search regime. Rows are the body-less SkillSummary
 * projection in both regimes; bodies load only through the panel's
 * open-skill fetch (getSkill), the same load-on-demand split the
 * skills tool enforces.
 *
 * Bus-driven refresh lives in the panel, not here: Skills.svelte
 * subscribes to the skill-events bus and refreshes the listing plus
 * reclassifies the open skill, torn down with the component - the
 * same shape as the memories panel's bus listener. The store is
 * pure data plus query drivers.
 */
import { DEFAULT_LIST_PAGE_SIZE, type SkillSummary, type SupabaseService } from './supabase';

interface SkillsStore {
  /**
   * The skill rows currently shown. Two regimes feed this list:
   *
   *   - Browse (empty query): an offset window paged in from
   *     `listSkillsPage`, alphabetical by name, grown by the
   *     listing surfaces' infinite-scroll sentinels via
   *     `loadMoreSkills`. Rendered in server order - no client
   *     re-sort, which would disagree with the server's page
   *     boundaries mid-scroll.
   *   - Search (non-empty query): a capped, unpaged set from
   *     `searchSkills`, alphabetical by name like browse (there is
   *     no ranking layer). `hasMore` is forced false here; you
   *     refine the query rather than paging search hits.
   */
  results: SkillSummary[];
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
   * active (search results are capped, not paged). Gates the
   * listing surfaces' infinite-scroll sentinels.
   */
  hasMore: boolean;
  /** True while a `loadMoreSkills` page is in flight (drives the sentinel spinner). */
  loadingMore: boolean;
}

export const skillsStore = $state<SkillsStore>({
  results: [],
  loading: false,
  loaded: false,
  error: null,
  query: '',
  offset: 0,
  hasMore: false,
  loadingMore: false,
});

// Supersede token shared by EVERY in-flight listing load - search,
// first-page browse, load-more, and the depth-preserving refresh.
// Unlike the memories / wiki stores, it is NOT threaded into the
// query itself - the skills slice takes no abort signal (plain
// ILIKE queries, no embed round trip, so flights are short). The
// token still guards each flight's state write: a superseded
// response that lands late is discarded here rather than clobbering
// the newer flight's results.
let currentAbort: AbortController | null = null;
// Kind of the in-flight listing load. The first-page dedupe below
// needs to tell "a first-page load is already in flight" (skip -
// the same load is running) from any other flight (supersede it:
// a search means the query changed, a load-more or refresh means
// the window is being rewritten and page one is now wanted).
let inFlightKind: 'first-page' | 'load-more' | 'refresh' | 'search' | null = null;

/**
 * Load the skills browse list from the first page (empty-query
 * regime), alphabetical by name. Resets the offset window. Called
 * by the sidebar when the query is empty - on mount and on clearing
 * a search - and by the Chat shell's tab-pick kick.
 *
 * Cheap dedupe: tab mount fires this from both the shell's kick and
 * the sidebar's debounced effect. A second call while a browse load
 * is already in flight is a wasted round trip, so it returns early;
 * a search in flight is still superseded (the query was cleared, so
 * the browse list is now the wanted regime).
 */
export async function loadSkillsFirstPage(
  supabase: SupabaseService,
): Promise<void> {
  if (inFlightKind === 'first-page') return;
  // Supersede any in-flight listing load so a slow response from a
  // just-cleared query can't clobber the fresh browse list.
  if (currentAbort) currentAbort.abort();
  const ctl = new AbortController();
  currentAbort = ctl;
  inFlightKind = 'first-page';
  skillsStore.loading = true;
  skillsStore.error = null;
  try {
    const page = await supabase.listSkillsPage({
      offset: 0,
      pageSize: DEFAULT_LIST_PAGE_SIZE,
    });
    if (ctl.signal.aborted) return;
    skillsStore.results = page.rows;
    skillsStore.offset = page.rows.length;
    skillsStore.hasMore = page.hasMore;
  } catch (err) {
    if (ctl.signal.aborted) return;
    skillsStore.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (currentAbort === ctl) {
      currentAbort = null;
      inFlightKind = null;
    }
    if (!ctl.signal.aborted) {
      skillsStore.loading = false;
      skillsStore.loaded = true;
    }
  }
}

/**
 * Append the next browse page. No-op while a page is in flight, when
 * the list is drained, when a search is active, or while a
 * first-page load / refresh is rewriting the window (paging from a
 * stale offset would append rows the rewrite is about to replace),
 * so the sentinels can fire it freely. A failed page leaves
 * `hasMore` intact so the next scroll retries.
 */
export async function loadMoreSkills(
  supabase: SupabaseService,
): Promise<void> {
  if (skillsStore.loadingMore || !skillsStore.hasMore) return;
  if (skillsStore.query.trim().length > 0) return;
  if (skillsStore.loading) return;
  if (currentAbort) currentAbort.abort();
  const ctl = new AbortController();
  currentAbort = ctl;
  inFlightKind = 'load-more';
  skillsStore.loadingMore = true;
  try {
    const page = await supabase.listSkillsPage({
      offset: skillsStore.offset,
      pageSize: DEFAULT_LIST_PAGE_SIZE,
    });
    if (ctl.signal.aborted) return;
    skillsStore.results = [...skillsStore.results, ...page.rows];
    skillsStore.offset += page.rows.length;
    skillsStore.hasMore = page.hasMore;
    skillsStore.error = null;
  } catch (err) {
    if (ctl.signal.aborted) return;
    skillsStore.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (currentAbort === ctl) {
      currentAbort = null;
      inFlightKind = null;
    }
    // loadingMore belongs to this flight alone - nothing else ever
    // sets it - so it clears even when superseded; otherwise the
    // sentinel spinner would stick on after an abort.
    skillsStore.loadingMore = false;
  }
}

/**
 * Bus-driven refresh of the browse regime that preserves loaded
 * depth in ONE query. A skill write (panel create / edit / delete,
 * the server-side skills tool, another device) means "the listing
 * may be stale", but resetting to page one would collapse every page
 * the user scrolled in - so the refresh refetches rows 0 through
 * max(pageSize, offset): the inclusive range's extra row is the
 * hasMore probe (the same page math `listSkillsPage` applies),
 * whatever exists is kept, and the offset becomes the kept length.
 *
 * The search regime is not handled here - the panel's bus listener
 * re-runs the search instead (`runSkillsSearch`).
 */
export async function refreshSkillsListing(
  supabase: SupabaseService,
): Promise<void> {
  if (skillsStore.query.trim().length > 0) return;
  if (currentAbort) currentAbort.abort();
  const ctl = new AbortController();
  currentAbort = ctl;
  inFlightKind = 'refresh';
  skillsStore.loading = true;
  skillsStore.error = null;
  try {
    const depth = Math.max(DEFAULT_LIST_PAGE_SIZE, skillsStore.offset);
    const page = await supabase.listSkillsPage({
      offset: 0,
      pageSize: depth,
    });
    if (ctl.signal.aborted) return;
    skillsStore.results = page.rows;
    skillsStore.offset = page.rows.length;
    skillsStore.hasMore = page.hasMore;
  } catch (err) {
    if (ctl.signal.aborted) return;
    skillsStore.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (currentAbort === ctl) {
      currentAbort = null;
      inFlightKind = null;
    }
    if (!ctl.signal.aborted) {
      skillsStore.loading = false;
      skillsStore.loaded = true;
    }
  }
}

/**
 * Drive `skillsStore` from the bound query. The single entry point
 * every caller uses; it dispatches on the query:
 *
 *   - Empty query -> the paginated browse list (`loadSkillsFirstPage`).
 *   - Non-empty query -> the capped ILIKE search.
 *
 * Callers should debounce - this runs immediately. Supersedes any
 * in-flight listing load so a stale result can't clobber the latest
 * query.
 */
export async function runSkillsSearch(
  supabase: SupabaseService,
): Promise<void> {
  if (skillsStore.query.trim().length === 0) {
    return loadSkillsFirstPage(supabase);
  }
  if (currentAbort) currentAbort.abort();
  const ctl = new AbortController();
  currentAbort = ctl;
  inFlightKind = 'search';
  skillsStore.loading = true;
  skillsStore.error = null;
  try {
    // No explicit limit: the slice defaults to one browse page's
    // worth (DEFAULT_LIST_PAGE_SIZE), and the sidebar renders search
    // hits as one flat list. A larger limit would not remove the
    // cap - the hits would just stop at a different point.
    const hits = await supabase.searchSkills({
      query: skillsStore.query.trim(),
    });
    if (ctl.signal.aborted) return;
    skillsStore.results = hits;
    // Search results are capped, not paged - close the sentinel so
    // a scroll to the bottom of a search doesn't try to "load more."
    skillsStore.offset = hits.length;
    skillsStore.hasMore = false;
  } catch (err) {
    if (ctl.signal.aborted) return;
    skillsStore.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (currentAbort === ctl) {
      currentAbort = null;
      inFlightKind = null;
    }
    if (!ctl.signal.aborted) {
      skillsStore.loading = false;
      skillsStore.loaded = true;
    }
  }
}

/**
 * Replace one row in `results` without re-querying. Called from the
 * panel after a successful edit save so the listing surfaces reflect
 * the new name / description immediately (the bus listener's refresh
 * follows a beat later and lands the same data).
 */
export function patchSkillRow(
  id: string,
  patch: Partial<SkillSummary>,
): void {
  skillsStore.results = skillsStore.results.map((row) =>
    row.id === id ? { ...row, ...patch } : row,
  );
}

/**
 * Drop one row from the list. Called from the panel after a
 * confirmed delete, ahead of the bus listener's refresh, so the row
 * vanishes with no perceptible round trip.
 */
export function removeSkillRow(id: string): void {
  skillsStore.results = skillsStore.results.filter((row) => row.id !== id);
}
