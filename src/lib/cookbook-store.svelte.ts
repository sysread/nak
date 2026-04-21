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
 * `cookbook-events.ts` — the `recipe_*` tools need to signal
 * changes, and the tool registry gets bundled into the reflection
 * Web Worker, which crashes with `$state is not defined` if it
 * pulls a rune-using module into the worker bundle. We re-export
 * both here so existing UI imports from `$lib/cookbook-store.svelte`
 * keep resolving.
 */
import type { Recipe, SupabaseService } from './supabase';
export {
  COOKBOOK_CHANGE_EVENT,
  notifyCookbookChanged,
} from './cookbook-events';

interface CookbookState {
  recipes: Recipe[];
  loading: boolean;
  /** Last error from a load attempt. Cleared on the next successful load. */
  error: string | null;
}

export const cookbook = $state<CookbookState>({
  recipes: [],
  loading: false,
  error: null,
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
  } catch (err) {
    cookbook.error = err instanceof Error ? err.message : String(err);
  } finally {
    cookbook.loading = false;
  }
}
