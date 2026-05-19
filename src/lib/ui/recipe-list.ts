/**
 * UI-behavior primitives for the sidebar recipe listing. Pure
 * functions only - no runes, no Svelte imports, no DOM. The
 * companion `src/components/RecipeList.svelte` composes these with
 * its own framework-native reactivity (the `query` / `sortMode`
 * runes, the search-state runes, the debounce `$effect` that
 * orchestrates the embed-then-search round trip, the
 * `AbortController` that supersedes stale calls).
 *
 * Type imports from `$lib/supabase` carry the `Recipe` row shape;
 * that is a domain type, not a framework type, so it is fair game
 * to share with a port.
 */
import type { Recipe } from '../supabase';
import { UNTAGGED_TOPIC_SENTINEL } from '../supabase';

export type SortMode = 'updated' | 'rating' | 'alphabetical';

/**
 * How long to wait after the user's last keystroke before firing
 * the embed-then-search round trip. Universal UX rule - a port
 * would pick the same kind of pause.
 */
export const SEARCH_DEBOUNCE_MS = 200;

/**
 * Upper bound on the recipe-search response. Matches the
 * comparable wiki search; the Supabase RPC also enforces a
 * server-side cap so this is belt-and-braces.
 */
export const RECIPE_SEARCH_LIMIT = 50;

/**
 * Whether the user has typed a non-empty search query (after
 * trim). Drives every "are we in search mode" branch: the sort
 * picker is hidden, the buckets are suppressed, the empty-state
 * message changes, and the visible list switches from store-
 * sorted to server-relevance order.
 */
export function isSearching(query: string): boolean {
  return query.trim().length > 0;
}

/**
 * Comparator for the rating sort. Null ratings rank below any
 * rated row (treated as -1); ties break by `updated_at` desc so
 * the most recently edited recipe at each rating tier floats up.
 */
function compareByRating(a: Recipe, b: Recipe): number {
  const ar = a.rating ?? -1;
  const br = b.rating ?? -1;
  if (ar !== br) return br - ar;
  return (b.updated_at ?? '').localeCompare(a.updated_at ?? '');
}

/**
 * Comparator for the alphabetical sort. Case- and accent-
 * insensitive title compare via `localeCompare` with sensitivity
 * "base", so "Espresso" / "espresso" and "creme" / "creme" collate
 * together regardless of how the diacritics got typed. Titles are
 * trimmed before comparison so a stray leading space cannot float
 * a row above its peers.
 *
 * Untitled drafts (empty or whitespace-only `title`) sink to the
 * bottom - they would otherwise leapfrog every real recipe whose
 * name starts with a letter, which is not what "sort alphabetically"
 * means to the user.
 *
 * Ties fall back to `updated_at` desc so the order is stable
 * across reloads even when two recipes share a title.
 */
function compareByTitle(a: Recipe, b: Recipe): number {
  const at = (a.title ?? '').trim();
  const bt = (b.title ?? '').trim();
  if (!at && bt) return 1;
  if (at && !bt) return -1;
  const cmp = at.localeCompare(bt, undefined, { sensitivity: 'base' });
  if (cmp !== 0) return cmp;
  return (b.updated_at ?? '').localeCompare(a.updated_at ?? '');
}

/**
 * Topic-filter predicate applied client-side over the bounded
 * cookbook (~200 rows on a heavy account; server-side filtering
 * would add scope for no perceptible perf win, and the same
 * predicate has to narrow Upcoming, Favorites, search results,
 * AND the main listing uniformly).
 *
 * Empty selection passes everything through. The `(untagged)`
 * sentinel matches recipes whose topics column is empty - the
 * background topics worker hasn't reached the row, or chose to
 * emit nothing. Real-topic entries match by overlap (OR
 * semantics, same as the conversation drawer's filter).
 */
export function matchesTopicFilter(
  recipe: Recipe,
  selectedTopics: readonly string[]
): boolean {
  if (selectedTopics.length === 0) return true;
  let includeUntagged = false;
  const real: string[] = [];
  for (const t of selectedTopics) {
    if (t === UNTAGGED_TOPIC_SENTINEL) includeUntagged = true;
    else real.push(t);
  }
  const topics = Array.isArray(recipe.topics) ? recipe.topics : [];
  if (topics.length === 0 && includeUntagged) return true;
  if (real.length > 0 && topics.some((t) => real.includes(t))) return true;
  return false;
}

/**
 * Top of the visible listing. Four modes, in precedence:
 *
 *   - Searching - server-returned hits in relevance order win;
 *     ranking is exactly what the user asked for.
 *   - sortMode === 'rating' - rating descending with the null-rank
 *     / recency tie-break.
 *   - sortMode === 'alphabetical' - title compare (case- and
 *     accent-insensitive) with untitled drafts sinking to the
 *     bottom and recency as the tie-break.
 *   - Default ('updated') - the store's existing order (most-
 *     recently-edited first; the cookbook store sorts on insert).
 *
 * The active topic filter narrows whichever source is in play -
 * the search ranking stays intact (the filter is applied AFTER
 * the server returns hits, so it does not perturb relevance
 * order), and the sort/default branches filter before sorting so
 * the chosen order is computed over only the matching subset.
 */
export function pickVisibleRecipes(args: {
  searching: boolean;
  searchResults: readonly Recipe[];
  storeRecipes: readonly Recipe[];
  sortMode: SortMode;
  selectedTopics: readonly string[];
}): Recipe[] {
  const match = (r: Recipe): boolean =>
    matchesTopicFilter(r, args.selectedTopics);
  if (args.searching) return args.searchResults.filter(match);
  const filtered = args.storeRecipes.filter(match);
  if (args.sortMode === 'alphabetical') {
    return filtered.sort(compareByTitle);
  }
  if (args.sortMode === 'rating') {
    return filtered.sort(compareByRating);
  }
  return filtered;
}

/**
 * The "Upcoming" bucket at the top of the listing. Filtered to
 * recipes the user flagged for the current grocery cycle and
 * narrowed by the active topic filter, sorted by `updated_at`
 * desc so the most recently edited upcoming recipe sits first
 * (mirrors the conversation drawer's Recent bucket).
 *
 * Empty during a search because the relevance ranking is what the
 * user asked for and a bucket above it would visually fight the
 * result order.
 */
export function pickUpcomingRecipes(
  recipes: readonly Recipe[],
  searching: boolean,
  selectedTopics: readonly string[]
): Recipe[] {
  if (searching) return [];
  return recipes
    .filter(
      (r) => r.upcoming && matchesTopicFilter(r, selectedTopics)
    )
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
}

/**
 * The "Favorites" bucket between Upcoming and the main list.
 * Same shape and same hide-on-search rule as `pickUpcomingRecipes`,
 * keyed on the long-lived `favorite` flag rather than the
 * shopping-cycle `upcoming` flag. Same topic-filter narrowing so
 * "filter to italian" affects Upcoming and Favorites identically
 * to the All list.
 */
export function pickFavoriteRecipes(
  recipes: readonly Recipe[],
  searching: boolean,
  selectedTopics: readonly string[]
): Recipe[] {
  if (searching) return [];
  return recipes
    .filter(
      (r) => r.favorite && matchesTopicFilter(r, selectedTopics)
    )
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
}

/**
 * Tagged union returned by `computeListView`. The component
 * dispatches on `kind` to render the right surface and carries
 * the small bit of payload each variant needs.
 */
export type ListView =
  | { kind: 'scanner-search' }
  | { kind: 'error'; message: string }
  | { kind: 'scanner-loading' }
  | { kind: 'empty'; reason: 'no-matches' | 'no-recipes-yet' }
  | { kind: 'list' };

/**
 * Top-level render-state decision for the listing area. Five
 * states, in precedence order:
 *
 *   1. `scanner-search`  - active search, request in flight.
 *   2. `error`           - active search, error landed.
 *   3. `scanner-loading` - cold start, store still hydrating.
 *   4. `empty`           - visible list is empty; the reason picks
 *                          the message (no matches for the search,
 *                          versus no recipes at all yet).
 *   5. `list`            - render the buckets + main list.
 *
 * The "no matches" reason fires only during a search; when the
 * store has no recipes at all (cold account) the message is the
 * call-to-action variant.
 */
export function computeListView(args: {
  searching: boolean;
  searchBusy: boolean;
  searchError: string | null;
  storeLoading: boolean;
  storeCount: number;
  visibleCount: number;
}): ListView {
  if (args.searching && args.searchBusy) return { kind: 'scanner-search' };
  if (args.searching && args.searchError !== null) {
    return { kind: 'error', message: args.searchError };
  }
  if (!args.searching && args.storeLoading && args.storeCount === 0) {
    return { kind: 'scanner-loading' };
  }
  if (args.visibleCount === 0) {
    return {
      kind: 'empty',
      reason: args.searching ? 'no-matches' : 'no-recipes-yet',
    };
  }
  return { kind: 'list' };
}
