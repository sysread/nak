/**
 * Shared reactive state for the Venice image-EDIT-model catalog. The
 * edit-tool twin of image-models-catalog.svelte.ts, kept separate because
 * the two fetch different /models slices (?type=inpaint vs ?type=image)
 * into different row shapes (EditCatalogModel adds the privacy tier).
 *
 * Same lazy-on-open / in-memory-only / reset-on-lock contract as the
 * generation catalog; see that file for the rationale on each. The only
 * consumer is the Settings edit-model picker - nothing in the chat send
 * path reads this. The server resolves the chosen model id from
 * profiles.settings at edit time, so the catalog only has to be present
 * while the user is actively choosing.
 */
import { VeniceError } from './venice';
import type { EditCatalogModel } from './models/edit-image-catalog';
import { createLogger } from './logger.svelte';

const log = createLogger('edit-image-models-catalog');

/**
 * Staleness threshold for the on-open refresh. Matches the other catalogs'
 * 15-minute window - Venice rotates models over minutes-to-days, and this
 * keeps a long Settings session from hammering the endpoint.
 */
export const EDIT_IMAGE_CATALOG_STALE_MS = 15 * 60 * 1000;

interface EditCatalogState {
  data: EditCatalogModel[] | null;
  /** `Date.now()` of the last successful fetch. Null until the first load lands. */
  lastFetchedAt: number | null;
  loading: boolean;
  error: string | null;
}

export const editImageCatalog = $state<EditCatalogState>({
  data: null,
  lastFetchedAt: null,
  loading: false,
  error: null,
});

/**
 * True when there is no cached data, or when the cache is older than
 * {@link EDIT_IMAGE_CATALOG_STALE_MS}.
 */
export function isEditImageCatalogStale(): boolean {
  if (editImageCatalog.lastFetchedAt === null) return true;
  return Date.now() - editImageCatalog.lastFetchedAt > EDIT_IMAGE_CATALOG_STALE_MS;
}

/**
 * Whether the on-open effect should kick off an automatic refresh: cache
 * is stale, nothing is in flight, and the last attempt did not error. The
 * error guard mirrors the other stores' - a failed auto-load stops here
 * and surfaces the error rather than re-firing into a retry storm; the
 * manual Retry button clears `error` to try again.
 */
export function shouldAutoRefreshEditImageCatalog(): boolean {
  return !editImageCatalog.loading && editImageCatalog.error === null && isEditImageCatalogStale();
}

/**
 * The slice of SupabaseService the store depends on. Narrow on purpose so
 * the store doesn't couple to the whole service and the test can pass a
 * bare stub.
 */
interface EditCatalogFetcher {
  fetchEditModels(): Promise<EditCatalogModel[]>;
}

/**
 * Fetch the live edit catalog and populate the store. Safe to call
 * concurrently - a later call overwrites with the newer result. Errors
 * are captured into `editImageCatalog.error` and logged; prior data is
 * preserved so a flaky fetch doesn't wipe an already-shown list.
 */
export async function refreshEditImageCatalog(source: EditCatalogFetcher): Promise<void> {
  editImageCatalog.loading = true;
  editImageCatalog.error = null;
  try {
    editImageCatalog.data = await source.fetchEditModels();
    editImageCatalog.lastFetchedAt = Date.now();
  } catch (err) {
    const message =
      err instanceof VeniceError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    editImageCatalog.error = message;
    log.warn('refreshEditImageCatalog failed', { message });
  } finally {
    editImageCatalog.loading = false;
  }
}

/**
 * Wipe the cached edit catalog. Called from `state.svelte.ts::lock()`
 * alongside the other catalog resets so a subsequent unlock with a
 * different API key starts clean rather than showing the prior key's
 * catalog.
 */
export function resetEditImageCatalog(): void {
  editImageCatalog.data = null;
  editImageCatalog.lastFetchedAt = null;
  editImageCatalog.loading = false;
  editImageCatalog.error = null;
  log.info('resetEditImageCatalog');
}
