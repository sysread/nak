/**
 * Shared reactive state for the Venice text-model catalog. Populated
 * lazily - the first time the user opens Settings -> AI in this session,
 * the pane fires `refreshCatalog` and the model list lands in the
 * reactive `catalog` store. Subsequent opens within
 * {@link CATALOG_STALE_MS} reuse the cache; older opens trigger a fresh
 * fetch.
 *
 * Mirrors usage-store.svelte.ts deliberately: same lazy-on-open, same
 * in-memory-only cache, same lock() reset. The only consumer is the
 * Settings model picker - nothing in the chat send path reads this,
 * because the per-tier capability snapshot in profiles.settings.tierModels
 * carries everything resolution needs synchronously. So the catalog only
 * has to be present while the user is actively choosing a model.
 *
 * No localStorage. The catalog changes (Venice rotates models), so a
 * full reload always costs one fetch when the AI pane is next opened.
 */
import { VeniceError } from './venice';
import type { CatalogModel } from './models/catalog';
import { createLogger } from './logger.svelte';

const log = createLogger('models-catalog');

/**
 * Staleness threshold for the on-open refresh. The catalog changes on
 * Venice's side over minutes-to-days; 15 minutes matches the Usage pane's
 * window and keeps a long Settings session from hammering the endpoint.
 */
export const CATALOG_STALE_MS = 15 * 60 * 1000;

interface CatalogState {
  data: CatalogModel[] | null;
  /** `Date.now()` of the last successful fetch. Null until the first load lands. */
  lastFetchedAt: number | null;
  loading: boolean;
  error: string | null;
}

export const catalog = $state<CatalogState>({
  data: null,
  lastFetchedAt: null,
  loading: false,
  error: null,
});

/**
 * True when there is no cached data, or when the cache is older than
 * {@link CATALOG_STALE_MS}.
 */
export function isCatalogStale(): boolean {
  if (catalog.lastFetchedAt === null) return true;
  return Date.now() - catalog.lastFetchedAt > CATALOG_STALE_MS;
}

/**
 * Whether the on-open effect should kick off an automatic refresh: cache
 * is stale, nothing is in flight, and the last attempt did not error.
 *
 * The error guard mirrors the Usage store's: a failed fetch leaves
 * `lastFetchedAt` null so `isCatalogStale()` stays true; without this
 * guard a persistently failing auto-load would re-fire the instant
 * `loading` flips back to false, a tight retry storm. A failed auto-load
 * stops here and surfaces the error; the manual Retry button clears
 * `error` to try again.
 */
export function shouldAutoRefreshCatalog(): boolean {
  return !catalog.loading && catalog.error === null && isCatalogStale();
}

/**
 * The slice of SupabaseService the store depends on. Narrow on purpose so
 * the store doesn't couple to the whole service and the test can pass a
 * bare stub.
 */
interface CatalogFetcher {
  fetchModels(): Promise<CatalogModel[]>;
}

/**
 * Fetch the live catalog and populate the store. Safe to call
 * concurrently - a later call overwrites with the newer result. Errors
 * are captured into `catalog.error` and logged; prior `catalog.data` is
 * preserved so a flaky fetch doesn't wipe an already-shown list.
 */
export async function refreshCatalog(source: CatalogFetcher): Promise<void> {
  catalog.loading = true;
  catalog.error = null;
  try {
    catalog.data = await source.fetchModels();
    catalog.lastFetchedAt = Date.now();
  } catch (err) {
    const message =
      err instanceof VeniceError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    catalog.error = message;
    log.warn('refreshCatalog failed', { message });
  } finally {
    catalog.loading = false;
  }
}

/**
 * Wipe the cached catalog. Called from `state.svelte.ts::lock()` so a
 * subsequent unlock with a different API key starts clean rather than
 * showing the prior key's catalog.
 */
export function resetCatalog(): void {
  catalog.data = null;
  catalog.lastFetchedAt = null;
  catalog.loading = false;
  catalog.error = null;
  log.info('resetCatalog');
}
