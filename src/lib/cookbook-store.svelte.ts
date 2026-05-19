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
 * any local mutation. The tool-layer dispatches `COOKBOOK_CHANGE_EVENT`
 * on `window` after any successful `recipe_*` tool call, so a model-
 * driven save updates the drawer list the next animation frame even
 * when the user never leaves the chat canvas. The event is the only
 * bridge from the tools layer to the UI; no direct import the other
 * way.
 *
 * The event name and dispatcher live in the plain-`.ts` sibling
 * `cookbook-events.ts` - the `recipe_*` tools need to signal
 * changes, and the tool registry gets bundled into the reflection
 * Web Worker, which crashes with `$state is not defined` if it
 * pulls a rune-using module into the worker bundle. UI imports
 * `onCookbookChange` / `notifyCookbookChanged` from the events
 * module directly.
 */
import type { Recipe, RecipePhoto, SupabaseService } from './supabase';

interface CookbookState {
  recipes: Recipe[];
  loading: boolean;
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
   * UNTAGGED_TOPIC_SENTINEL when the user selected "untagged" in
   * the dropdown. The RecipeList sidebar narrows both the bucket
   * list and the search results by this selection - applied client-
   * side because the recipe set is bounded (~200 rows loaded into
   * `recipes`) and server-side filtering would add scope for no
   * perf win.
   */
  selectedTopics: string[];
  /**
   * Per-user topic vocabulary - the flat sorted list returned by
   * `list_user_recipe_topics`. Drives the TopicsFilter dropdown
   * options. Refreshed on every successful `loadRecipes` so a
   * newly-minted topic from the background worker shows up in the
   * dropdown the next time the list reloads (which fires on tool
   * mutations, modal opens, and tab switches).
   */
  topicsVocabulary: string[];
}

export const cookbook = $state<CookbookState>({
  recipes: [],
  loading: false,
  error: null,
  photos: {},
  selectedTopics: [],
  topicsVocabulary: [],
});

/**
 * Refresh `cookbook.recipes` from Supabase. Safe to call concurrently —
 * a second call while the first is in flight just overwrites with the
 * newer result. We don't debounce because refresh triggers (modal
 * open, tool completion) are already low-frequency.
 */
export async function loadRecipes(supabase: SupabaseService): Promise<void> {
  cookbook.loading = true;
  try {
    // No query, generous limit — a personal cookbook sits well under
    // 200 rows in practice. If someone grows past that, we'll paginate.
    const rows = await supabase.listRecipes('', 200);
    cookbook.recipes = rows;
    cookbook.error = null;
    // Piggy-back a vocabulary refresh so a newly-minted topic from
    // the background worker shows up in the dropdown the next time
    // the list reloads. Best-effort: a failure leaves the prior
    // vocabulary in place rather than blanking it - the dropdown
    // stays usable across a transient Supabase blip.
    void refreshRecipesTopicsVocabulary(supabase);
  } catch (err) {
    cookbook.error = err instanceof Error ? err.message : String(err);
  } finally {
    cookbook.loading = false;
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
