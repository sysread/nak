/**
 * Shared reactive state for the Venice image-model catalog. The image-
 * generation twin of models-catalog.svelte.ts (text), kept separate
 * because the two carry different row shapes and the picker fetches them
 * independently: this one loads the first time the user opens Settings ->
 * AI in a session, alongside the text catalog.
 *
 * Same lazy-on-open / in-memory-only / reset-on-lock contract as the text
 * store; see that file for the rationale on each. The only consumer is
 * the Settings image-model picker - nothing in the chat send path reads
 * this. The server resolves the chosen model id from profiles.settings at
 * generation time, so the catalog only has to be present while the user
 * is actively choosing.
 */
import { VeniceError } from './venice';
import type { ImageCatalogModel } from './models/image-catalog';
import { createLogger } from './logger.svelte';

const log = createLogger('image-models-catalog');

/**
 * Staleness threshold for the on-open refresh. Matches the text catalog's
 * 15-minute window - Venice rotates models over minutes-to-days, and this
 * keeps a long Settings session from hammering the endpoint.
 */
export const IMAGE_CATALOG_STALE_MS = 15 * 60 * 1000;

interface ImageCatalogState {
  data: ImageCatalogModel[] | null;
  /** `Date.now()` of the last successful fetch. Null until the first load lands. */
  lastFetchedAt: number | null;
  loading: boolean;
  error: string | null;
}

export const imageCatalog = $state<ImageCatalogState>({
  data: null,
  lastFetchedAt: null,
  loading: false,
  error: null,
});

/**
 * True when there is no cached data, or when the cache is older than
 * {@link IMAGE_CATALOG_STALE_MS}.
 */
export function isImageCatalogStale(): boolean {
  if (imageCatalog.lastFetchedAt === null) return true;
  return Date.now() - imageCatalog.lastFetchedAt > IMAGE_CATALOG_STALE_MS;
}

/**
 * Whether the on-open effect should kick off an automatic refresh: cache
 * is stale, nothing is in flight, and the last attempt did not error. The
 * error guard mirrors the text store's - a failed auto-load stops here and
 * surfaces the error rather than re-firing into a retry storm; the manual
 * Retry button clears `error` to try again.
 */
export function shouldAutoRefreshImageCatalog(): boolean {
  return !imageCatalog.loading && imageCatalog.error === null && isImageCatalogStale();
}

/**
 * The slice of SupabaseService the store depends on. Narrow on purpose so
 * the store doesn't couple to the whole service and the test can pass a
 * bare stub.
 */
interface ImageCatalogFetcher {
  fetchImageModels(): Promise<ImageCatalogModel[]>;
}

/**
 * Fetch the live image catalog and populate the store. Safe to call
 * concurrently - a later call overwrites with the newer result. Errors
 * are captured into `imageCatalog.error` and logged; prior data is
 * preserved so a flaky fetch doesn't wipe an already-shown list.
 */
export async function refreshImageCatalog(source: ImageCatalogFetcher): Promise<void> {
  imageCatalog.loading = true;
  imageCatalog.error = null;
  try {
    imageCatalog.data = await source.fetchImageModels();
    imageCatalog.lastFetchedAt = Date.now();
  } catch (err) {
    const message =
      err instanceof VeniceError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    imageCatalog.error = message;
    log.warn('refreshImageCatalog failed', { message });
  } finally {
    imageCatalog.loading = false;
  }
}

/**
 * Wipe the cached image catalog. Called from `state.svelte.ts::lock()`
 * alongside resetCatalog so a subsequent unlock with a different API key
 * starts clean rather than showing the prior key's catalog.
 */
export function resetImageCatalog(): void {
  imageCatalog.data = null;
  imageCatalog.lastFetchedAt = null;
  imageCatalog.loading = false;
  imageCatalog.error = null;
  log.info('resetImageCatalog');
}
