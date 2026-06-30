/**
 * Shared reactive state for the cookbook surfaces. The Cookbook modal
 * and the drawer's Recipes tab both read from `cookbook.recipes`, so a
 * write from one surface (or from an LLM `recipe_*` tool call) flows
 * to the other without either needing to know the other exists.
 *
 * Why a module-level rune instead of folding this into
 * `state.svelte.ts`: that file owns auth + services + theme — the
 * cross-screen primitives. Recipe list state is per-feature, shares
 * nothing with auth, and lives and dies on its own refresh triggers.
 * Keeping it separate means a reader of `state.svelte.ts` doesn't have
 * to parse cookbook-specific concerns to understand the phase machine.
 *
 * Refresh cadence: surfaces call `loadRecipes()` on mount and after
 * any local mutation. Model-driven recipe writes happen server-side
 * (the recipe_* tools dispatch in the venice function); the
 * recipes-table realtime relay in Chat.svelte fires
 * `COOKBOOK_CHANGE_EVENT` when one lands, so a model-driven save
 * updates the drawer list even when the user never leaves the chat
 * canvas. The event is the only bridge into the UI; no direct import
 * the other way.
 *
 * The event name and both bus halves (emit + subscribe) live in the
 * plain-`.ts` sibling `cookbook-events.ts`.
 */
import {
  DEFAULT_LIST_PAGE_SIZE,
  type Recipe,
  type RecipePhoto,
  type SupabaseService,
  type TopicVocabulary,
} from './supabase';
import type { SortMode } from './ui/recipe-list';
import { getCachedRecipes, offlineStatus } from './offline-sync.svelte';

interface CookbookState {
  /**
   * One offset window of the "All recipes" browse list - the rows the
   * sidebar has paged in so far, in `sort` order. NOT the whole
   * cookbook: a heavy account pages through this list rather than
   * loading every recipe at once. The Upcoming and Favorites buckets
   * live in their own complete arrays below because they render above
   * this list and a partial page would misrepresent them.
   */
  recipes: Recipe[];
  /** Every `upcoming`-flagged recipe (complete, not paged). */
  upcoming: Recipe[];
  /** Every `favorite`-flagged recipe (complete, not paged). */
  favorites: Recipe[];
  /** Sort applied to the paginated "All recipes" list. Drives the query. */
  sort: SortMode;
  /** Row count fetched into `recipes` so far - the next page's offset. */
  offset: number;
  /** False once the "All recipes" list has been paged to the end. */
  hasMore: boolean;
  /** True while a `loadMoreRecipes` page is in flight (drives the sentinel spinner). */
  loadingMore: boolean;
  loading: boolean;
  /**
   * True when `upcoming` / `favorites` were served from the IndexedDB
   * offline mirror because the authoritative fetch couldn't reach the
   * server. The paginated "All recipes" list and search both need the
   * server, so in this regime the sidebar hides its controls and shows
   * only the Upcoming / Favorites buckets. Cleared on the next
   * successful network load (mount, reconnect, or a cookbook-change
   * refresh).
   */
  fromCache: boolean;
  /** Last error from a load attempt. Cleared on the next successful load. */
  error: string | null;
  /**
   * Photo cache, keyed by recipe id. `undefined` = never fetched;
   * `null` = fetch in flight; `RecipePhoto[]` = loaded (possibly
   * empty). Lazy by design — the bytes live as base64 on the row, so
   * eagerly loading every recipe's photos at list-fetch time would
   * blow the wire payload on a cookbook with many photo'd recipes.
   * Detail open is the only path that needs them.
   */
  photos: Record<string, RecipePhoto[] | null | undefined>;
  /**
   * Active topic filter. Empty array = no filter. Includes the
   * UNTAGGED_TOPIC_SENTINEL when the user selected "untagged" in the
   * dropdown. Applied two ways depending on the surface: server-side
   * for the paginated "All recipes" list (a partial page has to be
   * narrowed before it's sliced or the page count would be wrong), and
   * client-side over the complete Upcoming / Favorites buckets and the
   * capped search results (those are whole sets in memory, so the
   * client predicate is enough). Both paths share the same OR-overlap
   * semantics so the filter narrows every section identically.
   */
  selectedTopics: string[];
  /**
   * Per-user topic vocabulary + per-topic counts returned by
   * `list_user_recipe_topics`. Drives the TopicsFilter dropdown
   * options and the count each row shows in parens. Refreshed on every
   * successful `loadRecipes` so a newly-minted topic from the
   * background worker shows up in the dropdown the next time the list
   * reloads (which fires on tool mutations, modal opens, and tab
   * switches).
   */
  topicsVocabulary: TopicVocabulary;
}

export const cookbook = $state<CookbookState>({
  recipes: [],
  upcoming: [],
  favorites: [],
  sort: 'updated',
  offset: 0,
  hasMore: false,
  loadingMore: false,
  loading: false,
  fromCache: false,
  error: null,
  photos: {},
  selectedTopics: [],
  topicsVocabulary: { topics: [], untagged: 0 },
});

/**
 * Reload the cookbook from the first page. Resets the "All recipes"
 * pagination window to page one (current `sort` + `selectedTopics`),
 * refetches the complete Upcoming / Favorites buckets, and refreshes
 * the topic vocabulary. This is the entry point every refresh trigger
 * uses (sidebar mount, modal open, tool completion, sort / topic
 * change) - "refresh" always means "start over at the top," never
 * "append."
 *
 * Safe to call concurrently - a second call while the first is in
 * flight just overwrites with the newer result. We don't debounce
 * because the triggers are already low-frequency.
 */
export async function loadRecipes(supabase: SupabaseService): Promise<void> {
  cookbook.loading = true;
  try {
    const [page, upcoming, favorites] = await Promise.all([
      supabase.listRecipesPage({
        offset: 0,
        pageSize: DEFAULT_LIST_PAGE_SIZE,
        sort: cookbook.sort,
        selectedTopics: cookbook.selectedTopics,
      }),
      supabase.listUpcomingRecipes(),
      supabase.listFavoriteRecipes(),
    ]);
    cookbook.recipes = page.rows;
    cookbook.offset = page.rows.length;
    cookbook.hasMore = page.hasMore;
    cookbook.upcoming = upcoming;
    cookbook.favorites = favorites;
    cookbook.fromCache = false;
    cookbook.error = null;
    // Piggy-back a vocabulary refresh so a newly-minted topic from
    // the background worker shows up in the dropdown the next time
    // the list reloads. Best-effort: a failure leaves the prior
    // vocabulary in place rather than blanking it - the dropdown
    // stays usable across a transient Supabase blip.
    void refreshRecipesTopicsVocabulary(supabase);
  } catch (err) {
    // Authoritative fetch failed. When genuinely offline, re-bucket the
    // IndexedDB mirror into Upcoming / Favorites so the saved set stays
    // browsable - the cache holds exactly the favorited-or-upcoming
    // union, and each row carries its own flags to sort it back into the
    // right section. No paginated "All recipes" list offline (it needs
    // the server), so `recipes` is emptied. A failure while ONLINE is
    // left as an error - hiding the full list + search over a transient
    // blip is the worse trade. offlineStatus.online is the app-wide
    // connectivity source the read-through and disabled-control gating
    // already trust.
    if (!offlineStatus.online) {
      const cached = await getCachedRecipes();
      cookbook.recipes = [];
      cookbook.offset = 0;
      cookbook.hasMore = false;
      cookbook.upcoming = cached.filter((r) => r.upcoming);
      cookbook.favorites = cached.filter((r) => r.favorite);
      cookbook.fromCache = true;
      cookbook.error = null;
    } else {
      // Online but the fetch failed (transient). Surface the error and
      // leave the cache regime - we're authoritative again, an error
      // beats silently showing a stale cached subset.
      cookbook.fromCache = false;
      cookbook.error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    cookbook.loading = false;
  }
}

/**
 * Append the next page of the "All recipes" list. No-op when a page is
 * already in flight or the list is drained, so the sidebar sentinel
 * can fire it freely on every intersection without guarding. A failed
 * page is swallowed onto `error` and leaves `hasMore` intact so the
 * next scroll retries rather than stranding the user mid-list.
 */
export async function loadMoreRecipes(supabase: SupabaseService): Promise<void> {
  if (cookbook.loadingMore || !cookbook.hasMore) return;
  cookbook.loadingMore = true;
  try {
    const page = await supabase.listRecipesPage({
      offset: cookbook.offset,
      pageSize: DEFAULT_LIST_PAGE_SIZE,
      sort: cookbook.sort,
      selectedTopics: cookbook.selectedTopics,
    });
    cookbook.recipes = [...cookbook.recipes, ...page.rows];
    cookbook.offset += page.rows.length;
    cookbook.hasMore = page.hasMore;
    cookbook.error = null;
  } catch (err) {
    cookbook.error = err instanceof Error ? err.message : String(err);
  } finally {
    cookbook.loadingMore = false;
  }
}

/**
 * Refresh the per-user recipe topic vocabulary from
 * `list_user_recipe_topics`. Called by `loadRecipes` after every
 * successful load, and exposed for the sidebar's onMount path to
 * prime the dropdown before the first load resolves. Best-effort:
 * a failure leaves the existing vocabulary in place rather than
 * blanking it.
 */
export async function refreshRecipesTopicsVocabulary(
  supabase: SupabaseService
): Promise<void> {
  try {
    cookbook.topicsVocabulary = await supabase.listUserRecipeTopics();
  } catch {
    // swallow - see comment above
  }
}

/**
 * Load (or reload) the photos linked to a single recipe. Writes the
 * result into `cookbook.photos[recipeId]`. Marks the slot as `null`
 * during the fetch so detail-pane render code can show a placeholder
 * for the strip; resolves to `[]` for recipes with no photos.
 *
 * Called from the Cookbook detail-pane $effect on recipe-id change,
 * and again from the COOKBOOK_CHANGE_EVENT handler so a tool-driven
 * `recipe_photos_attach` mid-conversation refreshes the strip without
 * the user navigating away.
 */
export async function loadRecipePhotos(
  supabase: SupabaseService,
  recipeId: string
): Promise<void> {
  cookbook.photos[recipeId] = null;
  try {
    cookbook.photos[recipeId] = await supabase.listRecipePhotos(recipeId);
  } catch {
    // Surface as an empty strip rather than an error banner - a photo
    // load failure is non-fatal for the recipe view, and the user can
    // re-open to retry. Keeping the slot truthy (empty array) prevents
    // a permanent "loading..." state on transient failures.
    cookbook.photos[recipeId] = [];
  }
}
