/**
 * The offline-cache brain: it owns the reactive online/cache status,
 * the reconcile pass that mirrors the user's marked set into IndexedDB,
 * and the read-through resolvers the detail views call. `offline-cache`
 * is the dumb storage layer underneath; this module decides *what* to
 * store and *when*.
 *
 * The marked set (what gets saved offline):
 *   - articles: every favorited wiki article.
 *   - recipes: every favorited OR upcoming recipe (union, deduped).
 *
 * Freshness uses the row's `updated_at`. Content edits bump it on both
 * tables; favorite / upcoming toggles deliberately do NOT (they are
 * bookmarks, not content), so a re-favorite is correctly a no-op for
 * the cache - the body never changed.
 *
 * The load-bearing rule (requirement: "remote updated" vs "can't reach
 * remote"): the reconcile only ever mutates the cache against a
 * SUCCESSFUL fetch of the authoritative marked set. A failed fetch
 * (offline, transient Supabase blip) leaves the cache untouched and
 * returns early - otherwise an offline moment would evict the very
 * records the user saved for offline use. See `syncOfflineCache`.
 */

import {
  getAllCached,
  getCached,
  putCached,
  deleteCached,
} from './offline-cache';
import type { Recipe, SupabaseService, WikiArticle } from './supabase';
import { createLogger } from './logger.svelte';

// Drawer source tag for the offline cache. Everything the cache does
// is invisible by design (it works in the background), so these
// breadcrumbs are the only way to confirm on a real device that a
// favorited record actually downloaded. Filter the Logs drawer to
// `offline` to watch it.
const log = createLogger('offline');

/**
 * Reactive snapshot the UI reads for the offline indicator and the
 * "available offline" affordances. `online` tracks `navigator.onLine`;
 * the counts are the number of rows currently mirrored per store,
 * refreshed after each reconcile.
 */
export const offlineStatus = $state<{
  online: boolean;
  lastSyncAt: number | null;
  articleCount: number;
  recipeCount: number;
}>({
  online: true,
  lastSyncAt: null,
  articleCount: 0,
  recipeCount: 0,
});

/**
 * Start tracking connectivity. Seeds `offlineStatus.online` from
 * `navigator.onLine` and keeps it current via the window online/offline
 * events. Returns a teardown that removes the listeners. Safe to call
 * in a non-browser context (returns a no-op teardown). Does NOT trigger
 * a sync itself - the caller wires online -> syncOfflineCache, because
 * only it holds the SupabaseService.
 */
export function initOfflineStatus(): () => void {
  if (typeof window === 'undefined') return () => {};
  offlineStatus.online = navigator.onLine;
  const goOnline = (): void => {
    offlineStatus.online = true;
    log.info('back online');
  };
  const goOffline = (): void => {
    offlineStatus.online = false;
    log.info('went offline');
  };
  log.debug(`connectivity: ${offlineStatus.online ? 'online' : 'offline'} at start`);
  window.addEventListener('online', goOnline);
  window.addEventListener('offline', goOffline);
  return () => {
    window.removeEventListener('online', goOnline);
    window.removeEventListener('offline', goOffline);
  };
}

// Smallest row shape the reconcile cares about: an id and a version
// stamp. Both WikiArticle and Recipe satisfy it.
interface Versioned {
  id: string;
  updated_at: string;
}

/**
 * Pure diff between what's cached and the authoritative marked set.
 * Returns the rows to (re)write and the ids to evict:
 *   - put: new rows, plus rows whose `updated_at` differs from the
 *     cached copy (a content edit; a bookmark toggle leaves it equal).
 *   - deleteIds: cached rows no longer in the marked set (un-favorited
 *     / no longer upcoming).
 * Kept pure so the add / refresh / evict logic is unit-testable without
 * an IndexedDB.
 */
function planReconcile<T extends Versioned>(
  cached: { id: string; updatedAt: string }[],
  rows: T[],
): { put: T[]; deleteIds: string[] } {
  const cachedVersion = new Map(cached.map((c) => [c.id, c.updatedAt]));
  const liveIds = new Set(rows.map((r) => r.id));
  const put = rows.filter((r) => cachedVersion.get(r.id) !== r.updated_at);
  const deleteIds = cached
    .filter((c) => !liveIds.has(c.id))
    .map((c) => c.id);
  return { put, deleteIds };
}

/** Union two row lists, keeping the first occurrence of each id. */
function dedupeById<T extends { id: string }>(...lists: T[][]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const list of lists) {
    for (const row of list) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
    }
  }
  return out;
}

interface ReconcileStats {
  total: number;
  written: number;
  evicted: number;
}

async function reconcileStore<T extends Versioned>(
  store: 'articles' | 'recipes',
  rows: T[],
): Promise<ReconcileStats> {
  const cached = await getAllCached<T>(store);
  const plan = planReconcile(
    cached.map((c) => ({ id: c.id, updatedAt: c.row.updated_at })),
    rows,
  );
  for (const row of plan.put) {
    await putCached(store, { id: row.id, row, cachedAt: Date.now() });
  }
  for (const id of plan.deleteIds) {
    await deleteCached(store, id);
  }
  return {
    total: rows.length,
    written: plan.put.length,
    evicted: plan.deleteIds.length,
  };
}

/**
 * Reconcile the IndexedDB cache against the user's current marked set.
 * Fetches the authoritative favorite / upcoming buckets, then upserts
 * changed rows and evicts rows that left the set.
 *
 * Returns `{ ok: false }` without touching the cache if the fetch
 * fails - the never-evict-on-failure invariant (see file header). On
 * success, refreshes the reactive counts and `lastSyncAt`.
 */
export async function syncOfflineCache(
  supabase: SupabaseService,
): Promise<{ ok: boolean }> {
  log.debug('sync: fetching marked set (favorites + upcoming)');
  let favoriteArticles: WikiArticle[];
  let favoriteRecipes: Recipe[];
  let upcomingRecipes: Recipe[];
  try {
    [favoriteArticles, favoriteRecipes, upcomingRecipes] = await Promise.all([
      supabase.listFavoriteWikiArticles(),
      supabase.listFavoriteRecipes(),
      supabase.listUpcomingRecipes(),
    ]);
  } catch (err) {
    // Authoritative fetch failed - offline, or a transient Supabase
    // error. Do NOT reconcile: leaving the cache exactly as it is is
    // the whole point of distinguishing "can't reach remote" from
    // "remote changed". Evicting here would wipe the offline copies on
    // the first network hiccup.
    log.warn('sync skipped: could not reach server; cache left intact', err);
    return { ok: false };
  }
  const recipeRows = dedupeById(favoriteRecipes, upcomingRecipes);
  const articleStats = await reconcileStore('articles', favoriteArticles);
  const recipeStats = await reconcileStore('recipes', recipeRows);
  await refreshCounts();
  offlineStatus.lastSyncAt = Date.now();
  // Headline breadcrumb: how many records are now saved for offline use,
  // and what this pass changed. On a fresh device the `written` count is
  // the proof your favorites just downloaded. Details carry the per-store
  // breakdown for the expand caret.
  log.info(
    `sync ok: ${articleStats.total} article(s), ${recipeStats.total} recipe(s) saved` +
      ` (wrote ${articleStats.written + recipeStats.written}, evicted ${articleStats.evicted + recipeStats.evicted})`,
    { articles: articleStats, recipes: recipeStats },
  );
  return { ok: true };
}

/** Recompute the reactive cache counts from IndexedDB. */
export async function refreshCounts(): Promise<void> {
  const [articles, recipes] = await Promise.all([
    getAllCached<WikiArticle>('articles'),
    getAllCached<Recipe>('recipes'),
  ]);
  offlineStatus.articleCount = articles.length;
  offlineStatus.recipeCount = recipes.length;
}

/**
 * Every wiki article currently mirrored offline, title ASC. This is the
 * offline fallback for the wiki sidebar list: when the authoritative
 * fetch in `loadWikiFirstPage` can't reach the server, the saved set is
 * still browsable from here. Ordering matches `listFavoriteWikiArticles`
 * (title ASC) so the offline bucket reads identically to the online one.
 */
export async function getCachedArticles(): Promise<WikiArticle[]> {
  const rows = (await getAllCached<WikiArticle>('articles')).map((c) => c.row);
  rows.sort((a, b) =>
    a.title.toLowerCase().localeCompare(b.title.toLowerCase()),
  );
  return rows;
}

/**
 * Every recipe currently mirrored offline (the favorited-or-upcoming
 * union), most-recently-updated first. The offline fallback for the
 * cookbook sidebar: the caller re-buckets by the rows' `favorite` /
 * `upcoming` flags into the Favorites / Upcoming sections. Ordering
 * matches `listUpcomingRecipes` / `listFavoriteRecipes` (updated_at
 * desc).
 */
export async function getCachedRecipes(): Promise<Recipe[]> {
  const rows = (await getAllCached<Recipe>('recipes')).map((c) => c.row);
  rows.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  return rows;
}

export interface CachedRead<T> {
  row: T | null;
  /** True when the row came from the offline cache, not the network. */
  fromCache: boolean;
}

/**
 * Resolve one wiki article, preferring the network when online and
 * falling back to the offline cache when the fetch fails or the device
 * is offline. A successful online read refreshes the cached copy; an
 * authoritative null (article deleted server-side) clears any stale
 * cache entry. Used by the article detail view so a favorited article
 * opens with no network.
 */
export async function getArticleCached(
  supabase: SupabaseService,
  id: string,
): Promise<CachedRead<WikiArticle>> {
  if (offlineStatus.online) {
    try {
      const row = await supabase.getWikiArticleById(id);
      if (row) {
        await putCached('articles', { id, row, cachedAt: Date.now() });
        log.debug(`article ${id}: fetched from server, cache refreshed`);
        return { row, fromCache: false };
      }
      // Server authoritatively has no such row - drop any stale copy so
      // a deleted article doesn't linger offline, and report the miss.
      await deleteCached('articles', id);
      log.debug(`article ${id}: gone on server, cleared from cache`);
      return { row: null, fromCache: false };
    } catch (err) {
      // Network error despite the online flag - fall through to cache.
      log.warn(`article ${id}: fetch failed, falling back to cache`, err);
    }
  }
  const cached = await getCached<WikiArticle>('articles', id);
  log.debug(
    `article ${id}: ${cached ? 'served from offline cache' : 'not in offline cache'}`,
  );
  return { row: cached?.row ?? null, fromCache: cached != null };
}

/**
 * Resolve one recipe, same read-through contract as
 * `getArticleCached`. Used by the cookbook detail view's deep-link
 * fallback so a favorited / upcoming recipe opens with no network.
 */
export async function getRecipeCached(
  supabase: SupabaseService,
  id: string,
): Promise<CachedRead<Recipe>> {
  if (offlineStatus.online) {
    try {
      const row = await supabase.getRecipe(id);
      if (row) {
        await putCached('recipes', { id, row, cachedAt: Date.now() });
        log.debug(`recipe ${id}: fetched from server, cache refreshed`);
        return { row, fromCache: false };
      }
      await deleteCached('recipes', id);
      log.debug(`recipe ${id}: gone on server, cleared from cache`);
      return { row: null, fromCache: false };
    } catch (err) {
      // Fall through to cache.
      log.warn(`recipe ${id}: fetch failed, falling back to cache`, err);
    }
  }
  const cached = await getCached<Recipe>('recipes', id);
  log.debug(
    `recipe ${id}: ${cached ? 'served from offline cache' : 'not in offline cache'}`,
  );
  return { row: cached?.row ?? null, fromCache: cached != null };
}

// Test-only surface: the pure reconcile/dedupe helpers, exercised
// without an IndexedDB. Kept off the production API per the repo's
// test-hook convention.
export const __test = { planReconcile, dedupeById };
