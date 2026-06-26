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
 * the user lands on the Usage pane. `resetForSignOut()` in
 * state.svelte.ts calls `resetUsage()` so rows tied to the previous
 * Venice key don't leak across a sign-out / sign-in-as-someone-else
 * into a project with a different key.
 *
 * No localStorage. Billing data stays in memory only - a full page
 * reload always costs one fetch when the pane is eventually opened.
 */
import { VeniceError } from './venice';
import type { UsageRequestOptions, UsageModelBucket } from './usage';
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
  data: UsageModelBucket[] | null;
  /** `Date.now()` of the last successful fetch. Null until the first load lands. */
  lastFetchedAt: number | null;
  loading: boolean;
  error: string | null;
}

export const usage = $state<UsageState>({
  data: null,
  lastFetchedAt: null,
  loading: false,
  error: null,
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
 * Whether the on-open effect should kick off an automatic refresh: cache is
 * stale, nothing is in flight, and the last attempt did not error.
 *
 * The error guard is load-bearing. A failed fetch leaves `lastFetchedAt` null,
 * so `isUsageStale()` stays true; without this guard, a persistently failing
 * auto-load (no/expired shared key, Venice down, offline, rate-limited)
 * re-qualifies the instant `loading` flips back to false and the effect
 * re-fires - a tight retry storm hammering the usage endpoint. A failed
 * auto-load therefore stops here and surfaces the error; the manual Refresh
 * button is how the user retries (it clears `error` on entry).
 */
export function shouldAutoRefreshUsage(): boolean {
  return !usage.loading && usage.error === null && isUsageStale();
}

/**
 * Compute the default rolling window as a pair of `YYYY-MM-DD` dates that the
 * analytics endpoint reads as an inclusive range. The bounds match the Usage
 * pane's date pickers - today as the upper bound, `DEFAULT_RANGE_DAYS` days back
 * as the lower - so the cached default view and a manual refresh of the
 * unchanged pickers request the same window. Inclusive of both endpoints, that
 * is `DEFAULT_RANGE_DAYS + 1` calendar days (today plus the week behind it),
 * which is also the divisor the pane's avg-per-day pill uses.
 */
function defaultRangeYmd(): { startDate: string; endDate: string } {
  const now = new Date();
  const end = new Date(now);
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - DEFAULT_RANGE_DAYS);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

/**
 * The slice of SupabaseService that refreshUsage depends on: the usage fetch.
 * Narrow on purpose so the store does not couple to the whole service (and so
 * the test can pass a bare stub).
 */
interface UsageFetcher {
  fetchUsage(opts: UsageRequestOptions): Promise<UsageModelBucket[]>;
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
export async function refreshUsage(source: UsageFetcher): Promise<void> {
  usage.loading = true;
  usage.error = null;
  try {
    const { startDate, endDate } = defaultRangeYmd();
    const buckets = await source.fetchUsage({ startDate, endDate });
    usage.data = buckets;
    usage.lastFetchedAt = Date.now();
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
 * Wipe the cached data. Called from `resetForSignOut()` in
 * state.svelte.ts so a subsequent sign-in to a project with a
 * different Venice key starts from a clean slate rather than
 * surfacing the prior user's billing rows.
 */
export function resetUsage(): void {
  usage.data = null;
  usage.lastFetchedAt = null;
  usage.loading = false;
  usage.error = null;
  log.info('resetUsage');
}
