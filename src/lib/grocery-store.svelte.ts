/**
 * Shared reactive state for the grocery list. The drawer's Groceries
 * tab (GroceryList.svelte) and the Cookbook detail pane's ingredient
 * checkboxes both mutate grocery items, so the list state lives in a
 * module-level rune (mirroring `cookbook-store.svelte.ts`) and every
 * writer refreshes through `loadGroceries`.
 *
 * Refresh cadence: the sidebar calls `loadGroceries()` on mount and
 * after any local mutation; the grocery realtime relay in Chat.svelte
 * fires the `nak:grocery:changed` event (see grocery-events.ts) when a
 * server-originated write lands - a Cookbook checkbox click, the
 * recipe-edit invalidation trigger's bulk delete, or another device.
 *
 * The needed list is fetched whole (an active shopping trip is small);
 * the acquired history is a recency window because it accumulates one
 * row per item per trip, forever. `loadMoreAcquired` extends the
 * window; `loadGroceries` resets it to the first page.
 */
import type {
  GroceryItemView,
  GrocerySection,
  SupabaseService,
} from './supabase';
import { ACQUIRED_PAGE_SIZE } from './ui/grocery-list';

interface GroceryState {
  /** User-ordered sections. The "Other" pseudo-section is not here. */
  sections: GrocerySection[];
  /** Complete active shopping list (needed = true), newest first. */
  needed: GroceryItemView[];
  /** Recency window of the acquired history (needed = false). */
  acquired: GroceryItemView[];
  /** False once the acquired history has been paged to the end. */
  acquiredHasMore: boolean;
  /** True while a loadMoreAcquired page is in flight. */
  loadingMore: boolean;
  loading: boolean;
  /** True once the first load has resolved (drives the lazy-load gates). */
  loaded: boolean;
  /** Last error from a load attempt. Cleared on the next successful load. */
  error: string | null;
}

export const grocery = $state<GroceryState>({
  sections: [],
  needed: [],
  acquired: [],
  acquiredHasMore: false,
  loadingMore: false,
  loading: false,
  loaded: false,
  error: null,
});

/**
 * Reload everything: sections, the whole needed list, and the first
 * page of the acquired history. Seeds the canned starter sections on
 * a brand-new account (zero section rows) before the first read so
 * the section picker is never empty on day one. Safe to call
 * concurrently - a later result overwrites.
 */
export async function loadGroceries(supabase: SupabaseService): Promise<void> {
  grocery.loading = true;
  try {
    let sections = await supabase.listGrocerySections();
    if (sections.length === 0) {
      await supabase.seedGrocerySectionsIfEmpty();
      sections = await supabase.listGrocerySections();
    }
    const [needed, acquiredPage] = await Promise.all([
      supabase.listNeededGroceryItems(),
      supabase.listAcquiredGroceryItemsPage({
        offset: 0,
        pageSize: ACQUIRED_PAGE_SIZE,
      }),
    ]);
    grocery.sections = sections;
    grocery.needed = needed;
    grocery.acquired = acquiredPage.rows;
    grocery.acquiredHasMore = acquiredPage.hasMore;
    grocery.error = null;
    grocery.loaded = true;
  } catch (err) {
    grocery.error = err instanceof Error ? err.message : String(err);
  } finally {
    grocery.loading = false;
  }
}

/**
 * Extend the acquired-history window by one page. No-op while a page
 * is in flight or when the history is drained, so the "show more"
 * control can fire it without guarding.
 */
export async function loadMoreAcquired(supabase: SupabaseService): Promise<void> {
  if (grocery.loadingMore || !grocery.acquiredHasMore) return;
  grocery.loadingMore = true;
  try {
    const page = await supabase.listAcquiredGroceryItemsPage({
      offset: grocery.acquired.length,
      pageSize: ACQUIRED_PAGE_SIZE,
    });
    grocery.acquired = [...grocery.acquired, ...page.rows];
    grocery.acquiredHasMore = page.hasMore;
    grocery.error = null;
  } catch (err) {
    grocery.error = err instanceof Error ? err.message : String(err);
  } finally {
    grocery.loadingMore = false;
  }
}
