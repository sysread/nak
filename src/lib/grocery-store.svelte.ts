/**
 * Shared reactive state for the grocery list. The drawer's Groceries
 * tab (GroceryList.svelte) and the Cookbook detail pane's ingredient
 * checkboxes both mutate grocery state, so it lives in a
 * module-level rune (mirroring `cookbook-store.svelte.ts`) and every
 * writer refreshes through `loadGroceries`.
 *
 * Refresh cadence: the sidebar calls `loadGroceries()` on mount and
 * after any local mutation; the grocery realtime relay in Chat.svelte
 * fires the `nak:grocery:changed` event (see grocery-events.ts) when
 * a server-originated write lands - a Cookbook checkbox click, the
 * recipe-edit invalidation trigger's delete, or another device. The
 * browser's OWN writes echo back through the relay too (it has no
 * self-write suppression), so a burst of check-off taps means several
 * echo reloads racing the settle-reload - `loadGroceries`' generation
 * guard makes that storm safe: start order wins, not resolve order.
 *
 * The check-off flow itself is OPTIMISTIC (toggleGroceryProductOnList
 * below): the row moves the instant it is tapped, the write fires
 * per-row and concurrently, and ONE settle-reload runs when the last
 * write lands - instead of a full three-query reload per tap, which
 * is what let a stale resolve-order snapshot un-do a check-off.
 *
 * The current list (products with an open entry) is fetched whole -
 * an active shopping trip is small; the acquired history is a
 * recency window because it accumulates purchases forever.
 * `loadMoreAcquired` extends the window; `loadGroceries` resets it
 * to the first page.
 */
import type {
  GroceryProductView,
  GrocerySection,
  SupabaseService,
} from './supabase';
import { autoFileProducts } from './grocery-section-agent';
import { emitGroceryChange } from './grocery-events';
import {
  ACQUIRED_PAGE_SIZE,
  applyOptimisticPurchase,
  applyOptimisticRevival,
  reconcilePendingToggles,
} from './ui/grocery-list';

/**
 * Bound for every loadGroceries query batch and every toggle write.
 * Without it, a request that black-holes on flaky wifi would pin
 * `loading` (the sidebar's mount gate reads it) or leave a row's
 * pending spinner running forever. Exported so the store tests can
 * drive the timeout without fake timers - `AbortSignal.timeout` is
 * not interceptable by vitest's clock.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

interface GroceryState {
  /** User-ordered sections. The "Other" pseudo-section is not here. */
  sections: GrocerySection[];
  /** Complete current shopping list (open entries), newest first. */
  onList: GroceryProductView[];
  /** Recency window of the purchase history (off-list, bought before). */
  acquired: GroceryProductView[];
  /** False once the acquired history has been paged to the end. */
  acquiredHasMore: boolean;
  /** True while a loadMoreAcquired page is in flight. */
  loadingMore: boolean;
  loading: boolean;
  /** True once the first load has resolved (drives the lazy-load gates). */
  loaded: boolean;
  /** Last error from a load attempt. Cleared on the next successful load. */
  error: string | null;
  /**
   * Last failure of an optimistic toggle WRITE. Cleared by the next
   * successful toggle - deliberately NOT by a successful load: the
   * failure path fires a resync load, and a load-side clear would
   * flash the error away before the shopper can read it.
   */
  writeError: string | null;
  /**
   * Product ids whose purchase/revival write is in flight, mapped to
   * the optimistic on_list direction (the direction is what the
   * post-load reconcile needs to re-assert the right move). Their rows
   * render the busy spinner on the panel. Lives here (not
   * per-component) for the same reason `classifying` does: the store's
   * arrays are shared, so the in-flight bookkeeping rides with them.
   * Reassigned, never mutated, so effects react. The drawer's un-plan
   * toggle consults it too, so no surface can stack a second write on
   * a row whose first write is still in flight.
   */
  pendingToggles: ReadonlyMap<string, boolean>;
  /**
   * Product ids whose auto-sectioning call is in flight - their rows
   * render a "choosing a section" spinner on both list surfaces.
   * Lives here (not per-component) because the add can originate in
   * the sidebar while the row renders in the panel. Reassigned, never
   * mutated, so effects react.
   */
  classifying: ReadonlySet<string>;
}

export const grocery = $state<GroceryState>({
  sections: [],
  onList: [],
  acquired: [],
  acquiredHasMore: false,
  loadingMore: false,
  loading: false,
  loaded: false,
  error: null,
  writeError: null,
  pendingToggles: new Map(),
  classifying: new Set(),
});

/**
 * Fire-and-forget auto-sectioning with row feedback: marks the
 * products as classifying (their rows spin), runs the ONE
 * classification call, unmarks, and nudges every grocery surface
 * when a filing landed. Both manual add paths (the panel's and the
 * sidebar's "(Auto)" actions) funnel through here; the Cookbook
 * bridge keeps its own name-keyed variant because its spinner
 * targets rendered checkbox DOM, not store rows. Never throws
 * (autoFileProducts fails closed).
 */
export async function autoFileProductsTracked(
  supabase: SupabaseService,
  products: ReadonlyArray<{ id: string; name: string }>
): Promise<void> {
  const ids = products.map((p) => p.id);
  grocery.classifying = new Set([...grocery.classifying, ...ids]);
  try {
    const filed = await autoFileProducts(supabase, products);
    if (filed) emitGroceryChange();
  } finally {
    const next = new Set(grocery.classifying);
    for (const id of ids) next.delete(id);
    grocery.classifying = next;
  }
}

/**
 * Monotonic generation for loadGroceries. A call whose token is no
 * longer the latest discards its results, its error, and its
 * loading/loaded writes (including in the finally) - start order
 * wins over resolve order, which is what stops a load that STARTED
 * before a write committed from overwriting the store with a stale
 * snapshot when it RESOLVES late. Same pattern as artifacts-store's
 * loadToken.
 */
let loadToken = 0;

/**
 * One seed at a time. The seed path is reachable from EVERY
 * loadGroceries call that observes zero sections, and realtime
 * echoes fan each grocery write out to more loads - without this
 * guard, an external wipe of the sections table turns "observe
 * empty -> seed -> 10 insert echoes -> more loads" into a
 * self-sustaining reload storm (observed live during QA cleanup:
 * 201 concurrent seed batches and 2010 section rows until the
 * browser's connection pool gave out). Concurrent callers skip
 * seeding and converge on the one in-flight batch's rows.
 */
let seedInFlight = false;

/**
 * Reload everything: sections, the whole current list, and the first
 * page of the acquired history. Seeds the canned starter sections on
 * a brand-new account (zero section rows) before the first read so
 * the section picker is never empty on day one. Safe to call
 * concurrently - the generation guard above keeps the latest-started
 * load as the only writer. After a successful load, any optimistic
 * rows for writes still in flight are re-asserted (a raced load
 * briefly un-does them; reconcile puts them back until the write's
 * own settle-reload replaces them with truth).
 */
export async function loadGroceries(supabase: SupabaseService): Promise<void> {
  const token = ++loadToken;
  grocery.loading = true;
  try {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let sections = await supabase.listGrocerySections({ signal });
    if (sections.length === 0 && !seedInFlight) {
      seedInFlight = true;
      try {
        await supabase.seedGrocerySectionsIfEmpty();
        sections = await supabase.listGrocerySections({ signal });
      } finally {
        seedInFlight = false;
      }
    }
    const [onList, acquiredPage] = await Promise.all([
      supabase.listOnListGroceryProducts({ signal }),
      supabase.listAcquiredGroceryProductsPage({
        offset: 0,
        pageSize: ACQUIRED_PAGE_SIZE,
        signal,
      }),
    ]);
    if (token !== loadToken) return;
    grocery.sections = sections;
    grocery.onList = onList;
    grocery.acquired = acquiredPage.rows;
    grocery.acquiredHasMore = acquiredPage.hasMore;
    grocery.error = null;
    grocery.loaded = true;
    const reconciled = reconcilePendingToggles(
      onList,
      acquiredPage.rows,
      grocery.pendingToggles,
      new Date().toISOString()
    );
    grocery.onList = reconciled.onList;
    grocery.acquired = reconciled.acquired;
  } catch (err) {
    if (token === loadToken) {
      grocery.error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    if (token === loadToken) grocery.loading = false;
  }
}

/**
 * The panel's check-off verb, optimistic end to end:
 *
 *  1. ignore a tap on a row whose write is already in flight - the
 *     shopper re-tapping a saving row is impatient, not deciding to
 *     un-buy it, and a stacked opposite write would junk the
 *     purchase log;
 *  2. move the row optimistically (purchase stamps acquired_at now,
 *     which routes it into the In-cart split mid-trip; both
 *     directions null entry_id - the real entry does not exist yet,
 *     and a stale id would mis-target the editor's quantity save);
 *  3. fire the write under the shared timeout (per-row and
 *     independent - concurrent taps never serialize);
 *  4. on success, drop the pending mark and - only when the pending
 *     map EMPTIED - run one settle-reload that picks up every landed
 *     write;
 *  5. on failure, revert the optimistic move, surface the error in
 *     `writeError` (until the next successful toggle), and resync
 *     with a reload to repair any drift.
 */
export async function toggleGroceryProductOnList(
  supabase: SupabaseService,
  item: GroceryProductView,
  on: boolean
): Promise<void> {
  if (grocery.pendingToggles.has(item.id)) return;
  const moved = on
    ? applyOptimisticRevival(grocery.onList, grocery.acquired, item.id)
    : applyOptimisticPurchase(grocery.onList, grocery.acquired, item.id, new Date().toISOString());
  grocery.onList = moved.onList;
  grocery.acquired = moved.acquired;
  const nextPending = new Map(grocery.pendingToggles).set(item.id, on);
  grocery.pendingToggles = nextPending;
  try {
    await supabase.setProductOnList(
      item.id,
      on,
      undefined,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    );
    const settled = new Map(grocery.pendingToggles);
    settled.delete(item.id);
    grocery.pendingToggles = settled;
    grocery.writeError = null;
    if (settled.size === 0) await loadGroceries(supabase);
  } catch (err) {
    const settled = new Map(grocery.pendingToggles);
    settled.delete(item.id);
    grocery.pendingToggles = settled;
    grocery.writeError = err instanceof Error ? err.message : String(err);
    // Revert. The primitives no-op on disagreement, so this is safe
    // even if a racing reload already replaced the arrays - and if
    // the server actually committed before the client timed out, the
    // resync reload below brings the truth back (a brief
    // snap-back-then-return flash, accepted).
    const back = on
      ? applyOptimisticPurchase(grocery.onList, grocery.acquired, item.id, new Date().toISOString())
      : applyOptimisticRevival(grocery.onList, grocery.acquired, item.id);
    grocery.onList = back.onList;
    grocery.acquired = back.acquired;
    await loadGroceries(supabase);
  }
}

/**
 * Extend the acquired-history window by one page. No-op while a page
 * is in flight, when the history is drained, or while an optimistic
 * toggle is pending: the cursor is `grocery.acquired.length`, which
 * optimistic rows inflate (the next page would skip a real row) or
 * deflate (it would re-append an already-loaded row - duplicate keys
 * in the keyed each). The pending window is sub-second, so blocking
 * is cheaper than a truth-cursor.
 */
export async function loadMoreAcquired(supabase: SupabaseService): Promise<void> {
  if (grocery.loadingMore || !grocery.acquiredHasMore) return;
  if (grocery.pendingToggles.size > 0) return;
  grocery.loadingMore = true;
  try {
    const page = await supabase.listAcquiredGroceryProductsPage({
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
