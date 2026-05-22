/**
 * Shared reactive state for the Venice billing usage pane. Populated
 * lazily - the first time the user opens Settings -> Usage in this
 * session, the pane fires `refreshUsage` and rows land in the
 * reactive `usage` store. Subsequent opens within
 * {@link USAGE_STALE_MS} reuse the cache; older opens trigger a
 * fresh fetch.
 *
 * Scope: the store caches the DEFAULT rolling-7-day window only. The
 * window slides as the day rolls over because we recompute the date
 * bounds on every fetch against the current `Date.now()`. User-picked
 * custom date ranges in Settings.svelte stay a local, uncached fetch
 * and do not touch this module.
 *
 * Lifecycle: nothing runs at app boot - the cache stays empty until
 * the user lands on the Usage pane. `state.svelte.ts::lock()` calls
 * `resetUsage()` so rows tied to the previous API key don't leak
 * across an unlock-lock-unlock to a different config.
 *
 * No localStorage. Billing data stays in memory only - a full page
 * reload always costs one fetch when the pane is eventually opened.
 */
import { VeniceClient, VeniceError, USAGE_MAX_PAGES, type UsageRow } from './venice';
import { createLogger } from './logger.svelte';

const log = createLogger('usage');

/**
 * Threshold for the Settings-pane staleness check. If the pane opens
 * and the cached data is older than this, the pane kicks off a
 * refresh so the user never reads numbers from a fetch this old.
 */
export const USAGE_STALE_MS = 15 * 60 * 1000;

/** Width of the default rolling window reported by the pane. */
const DEFAULT_RANGE_DAYS = 7;

interface UsageState {
  data: UsageRow[] | null;
  /** `Date.now()` of the last successful fetch. Null until the first load lands. */
  lastFetchedAt: number | null;
  loading: boolean;
  error: string | null;
  /**
   * True when the last fetch came back exactly at the page x per-page
   * ceiling, which almost certainly means the user's window hit the
   * {@link USAGE_MAX_PAGES} safety cap. The Usage pane surfaces this
   * as a footer hint so a truncated response isn't silently shown as
   * the full picture.
   */
  truncated: boolean;
  /**
   * Page count reported by Venice on the most recent in-flight or
   * completed fetch. Zero until the first page lands. Drives the
   * Usage pane's progress indicator alongside {@link pagesLoaded}.
   */
  pagesTotal: number;
  /**
   * Number of pages that have arrived for the current fetch. Resets
   * to zero on every {@link refreshUsage} entry so a stale total from
   * the previous fetch can't read as "already finished" while the new
   * one is still pulling page 1.
   */
  pagesLoaded: number;
}

export const usage = $state<UsageState>({
  data: null,
  lastFetchedAt: null,
  loading: false,
  error: null,
  truncated: false,
  pagesTotal: 0,
  pagesLoaded: 0,
});

/**
 * True when there is no cached data, or when the cache is older than
 * {@link USAGE_STALE_MS}. Called by the Usage pane on mount to decide
 * whether to show the cached view or kick off a refresh.
 */
export function isUsageStale(): boolean {
  if (usage.lastFetchedAt === null) return true;
  return Date.now() - usage.lastFetchedAt > USAGE_STALE_MS;
}

/**
 * Compute the default rolling-7-day range as a pair of ISO 8601
 * timestamps. Venice treats `endDate` as exclusive, so the upper bound
 * is the NEXT midnight after today - matching the transform the pane
 * does on its user-facing date pickers.
 */
function defaultRangeIso(): { startDate: string; endDate: string } {
  const now = new Date();
  const endDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  );
  const startDay = new Date(endDay);
  startDay.setUTCDate(startDay.getUTCDate() - (DEFAULT_RANGE_DAYS + 1));
  return {
    startDate: startDay.toISOString(),
    endDate: endDay.toISOString(),
  };
}

/**
 * Fetch the default rolling-7-day window and populate the store.
 * Called from the Settings pane's on-open effect and from the
 * Refresh button when the date pickers match the defaults. Safe to
 * call concurrently - a second call while one is in flight simply
 * overwrites with the newer result; `usage.loading` tracks only the
 * most recent caller.
 *
 * Errors are captured into `usage.error` and logged; prior
 * `usage.data` is preserved so a flaky fetch doesn't wipe the display.
 */
export async function refreshUsage(venice: VeniceClient): Promise<void> {
  usage.loading = true;
  usage.error = null;
  // Reset progress so the UI doesn't paint a stale "5/5 done" state
  // while the new fetch is still on page 1.
  usage.pagesLoaded = 0;
  usage.pagesTotal = 0;
  try {
    const { startDate, endDate } = defaultRangeIso();
    const rows = await venice.fetchUsage({
      startDate,
      endDate,
      onProgress: ({ page, totalPages }) => {
        usage.pagesLoaded = page;
        usage.pagesTotal = totalPages;
      },
    });
    usage.data = rows;
    usage.lastFetchedAt = Date.now();
    // Best-effort cap detection: if the response came back exactly at
    // the page x per-page ceiling, we almost certainly hit the safety
    // limit. Not perfect (a user with exactly the cap's worth of rows
    // would also trip it) but close enough for a "your data may be
    // truncated" hint - never shown when we're confidently under the
    // cap.
    usage.truncated = rows.length >= USAGE_MAX_PAGES * 500;
  } catch (err) {
    const message =
      err instanceof VeniceError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    usage.error = message;
    log.warn('refreshUsage failed', { message });
  } finally {
    usage.loading = false;
  }
}

/**
 * Wipe the cached data. Called from `state.svelte.ts::lock()` so a
 * subsequent unlock with a different API key starts from a clean
 * slate rather than surfacing the prior user's billing rows.
 */
export function resetUsage(): void {
  usage.data = null;
  usage.lastFetchedAt = null;
  usage.loading = false;
  usage.error = null;
  usage.truncated = false;
  usage.pagesLoaded = 0;
  usage.pagesTotal = 0;
  log.info('resetUsage');
}
