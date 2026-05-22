/**
 * Unit coverage for the Usage pane's background poller + cache. The
 * store exposes four state fields (data, lastFetchedAt, loading,
 * error, truncated) and three lifecycle entry points (refreshUsage,
 * startUsagePolling, stopUsagePolling). We exercise each through a
 * stubbed VeniceClient so the logic stays decoupled from the real
 * billing endpoint and from the page clock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VeniceClient, UsageRow } from '../src/lib/venice';
import { VeniceError } from '../src/lib/venice';
import {
  usage,
  isUsageStale,
  refreshUsage,
  startUsagePolling,
  stopUsagePolling,
  USAGE_POLL_MS,
  USAGE_STALE_MS,
} from '../src/lib/usage-store.svelte';

function sampleRow(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    timestamp: '2026-04-01T00:00:00Z',
    sku: 'llm-output-mtokens-example',
    pricePerUnitUsd: 0.001,
    units: 1,
    amount: 0.01,
    currency: 'USD',
    notes: '',
    inferenceDetails: null,
    ...overrides,
  };
}

function mockVenice(impl: () => Promise<UsageRow[]>): VeniceClient {
  return { fetchUsage: vi.fn(impl) } as unknown as VeniceClient;
}

beforeEach(() => {
  // Every test gets a clean store + a stopped poller so state from a
  // previous test can't bleed across. stopUsagePolling is idempotent
  // (no-op when not running) and resets the rune fields to their init
  // values as a side effect - exactly the reset the tests want.
  stopUsagePolling();
});

afterEach(() => {
  stopUsagePolling();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('refreshUsage', () => {
  it('populates usage.data and sets lastFetchedAt on success', async () => {
    const before = Date.now();
    const venice = mockVenice(async () => [sampleRow()]);
    await refreshUsage(venice);
    expect(usage.data).toEqual([sampleRow()]);
    expect(usage.error).toBeNull();
    expect(usage.loading).toBe(false);
    expect(usage.lastFetchedAt).not.toBeNull();
    expect(usage.lastFetchedAt!).toBeGreaterThanOrEqual(before);
  });

  it('passes a rolling-7-day window to fetchUsage as ISO timestamps', async () => {
    const fetchUsage = vi.fn<VeniceClient['fetchUsage']>(async () => []);
    const venice = { fetchUsage } as unknown as VeniceClient;
    await refreshUsage(venice);
    expect(fetchUsage).toHaveBeenCalledOnce();
    const arg = fetchUsage.mock.calls[0][0];
    if (!arg) throw new Error('fetchUsage was called without options');
    // Both bounds are ISO 8601 strings (Z-suffixed UTC).
    expect(arg.startDate).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    expect(arg.endDate).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    const spanMs =
      new Date(arg.endDate!).getTime() - new Date(arg.startDate!).getTime();
    const days = spanMs / (24 * 60 * 60 * 1000);
    // Eight days covers the rolling-7-day view: today (partial) +
    // seven full days behind. The store computes `endDate` as the
    // midnight AFTER today (exclusive upper bound), and `startDate`
    // as eight days before that, so the window always contains the
    // user's past week's traffic without edge-effects at the day
    // boundary.
    expect(days).toBe(8);
  });

  it('preserves prior usage.data and surfaces error on failure', async () => {
    const okVenice = mockVenice(async () => [sampleRow({ sku: 'keep-me' })]);
    await refreshUsage(okVenice);
    expect(usage.data).toEqual([sampleRow({ sku: 'keep-me' })]);

    const failVenice = mockVenice(async () => {
      throw new VeniceError('boom', 'network');
    });
    await refreshUsage(failVenice);
    // Prior data is intentionally not wiped - a transient poll failure
    // shouldn't blank the pane if a previous poll has data to show.
    expect(usage.data).toEqual([sampleRow({ sku: 'keep-me' })]);
    expect(usage.error).toBe('boom');
    expect(usage.loading).toBe(false);
  });

  it('marks truncated when rows hit the page cap', async () => {
    // The cap is USAGE_MAX_PAGES (20) x 500 = 10_000. Fabricating
    // that many rows in-test is wasteful; instead stub fetchUsage
    // to return exactly the cap count of minimal rows.
    const CAP = 20 * 500;
    const rows = Array.from({ length: CAP }, () => sampleRow());
    const venice = mockVenice(async () => rows);
    await refreshUsage(venice);
    expect(usage.truncated).toBe(true);
  });

  it('clears the truncated flag when a later fetch comes back under the cap', async () => {
    const CAP = 20 * 500;
    const bigRows = Array.from({ length: CAP }, () => sampleRow());
    await refreshUsage(mockVenice(async () => bigRows));
    expect(usage.truncated).toBe(true);
    await refreshUsage(mockVenice(async () => [sampleRow()]));
    expect(usage.truncated).toBe(false);
  });

  it('plumbs pagesLoaded / pagesTotal from the fetchUsage onProgress callback', async () => {
    // The store's progress fields are what the Settings pane reads to
    // render the determinate "Loading… N/M" indicator. Drive the
    // mock's onProgress hook the same way VeniceClient.fetchUsage
    // does in production and assert the final pair lands in the
    // store. Reset-to-zero on entry is covered by the next test.
    const venice = {
      fetchUsage: vi.fn(async (opts: { onProgress?: (info: { page: number; totalPages: number }) => void }) => {
        opts.onProgress?.({ page: 1, totalPages: 3 });
        opts.onProgress?.({ page: 2, totalPages: 3 });
        opts.onProgress?.({ page: 3, totalPages: 3 });
        return [sampleRow()];
      }),
    } as unknown as VeniceClient;
    await refreshUsage(venice);
    expect(usage.pagesLoaded).toBe(3);
    expect(usage.pagesTotal).toBe(3);
  });

  it('resets pagesLoaded / pagesTotal at the start of every refresh', async () => {
    // A second refresh that fails on the first network round-trip
    // would otherwise leave the previous fetch's "5/5" pair in
    // place, which a determinate progress bar would paint as
    // "already done." The store resets both fields on entry so a
    // mid-flight reader sees fresh zeros until the new fetch
    // reports its first page.
    const populate = {
      fetchUsage: vi.fn(async (opts: { onProgress?: (info: { page: number; totalPages: number }) => void }) => {
        opts.onProgress?.({ page: 5, totalPages: 5 });
        return [sampleRow()];
      }),
    } as unknown as VeniceClient;
    await refreshUsage(populate);
    expect(usage.pagesLoaded).toBe(5);

    let observedDuringFetch = { pagesLoaded: -1, pagesTotal: -1 };
    const observe = {
      fetchUsage: vi.fn(async (_opts: unknown) => {
        observedDuringFetch = {
          pagesLoaded: usage.pagesLoaded,
          pagesTotal: usage.pagesTotal,
        };
        return [sampleRow()];
      }),
    } as unknown as VeniceClient;
    await refreshUsage(observe);
    expect(observedDuringFetch).toEqual({ pagesLoaded: 0, pagesTotal: 0 });
  });
});

describe('isUsageStale', () => {
  it('returns true when there has been no successful fetch yet', () => {
    // beforeEach stopUsagePolling() reset lastFetchedAt to null.
    expect(usage.lastFetchedAt).toBeNull();
    expect(isUsageStale()).toBe(true);
  });

  it('returns false immediately after a successful fetch', async () => {
    await refreshUsage(mockVenice(async () => [sampleRow()]));
    expect(isUsageStale()).toBe(false);
  });

  it('flips to true once the cache crosses USAGE_STALE_MS', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T12:00:00Z'));
    await refreshUsage(mockVenice(async () => [sampleRow()]));
    expect(isUsageStale()).toBe(false);
    // One millisecond past the threshold is enough.
    vi.setSystemTime(new Date(Date.now() + USAGE_STALE_MS + 1));
    expect(isUsageStale()).toBe(true);
  });
});

describe('startUsagePolling / stopUsagePolling', () => {
  it('fires an immediate refresh on start and then every USAGE_POLL_MS', async () => {
    vi.useFakeTimers();
    const fetchUsage = vi.fn(async () => [sampleRow()] as UsageRow[]);
    const venice = { fetchUsage } as unknown as VeniceClient;
    startUsagePolling(venice);
    // Flush microtasks queued by the immediate `void refreshUsage(...)`.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    // Advance to the next tick; the interval should fire one more
    // refresh.
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });

  it('second startUsagePolling call is a no-op while already running', async () => {
    vi.useFakeTimers();
    const fetchUsage = vi.fn(async () => [] as UsageRow[]);
    const venice = { fetchUsage } as unknown as VeniceClient;
    startUsagePolling(venice);
    await vi.advanceTimersByTimeAsync(0);
    // Second call shouldn't re-fire the immediate refresh or install
    // a parallel interval.
    startUsagePolling(venice);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });

  it('stopUsagePolling clears the interval and wipes the cache', async () => {
    vi.useFakeTimers();
    const fetchUsage = vi.fn(async () => [sampleRow()] as UsageRow[]);
    const venice = { fetchUsage } as unknown as VeniceClient;
    startUsagePolling(venice);
    await vi.advanceTimersByTimeAsync(0);
    expect(usage.data).toEqual([sampleRow()]);

    stopUsagePolling();
    // Cache is scrubbed so rows from the previous API key don't leak
    // into an unlock-with-different-config.
    expect(usage.data).toBeNull();
    expect(usage.lastFetchedAt).toBeNull();
    expect(usage.error).toBeNull();
    expect(usage.truncated).toBe(false);

    // Interval is torn down: advancing the clock must not fire
    // another fetchUsage.
    fetchUsage.mockClear();
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS * 3);
    expect(fetchUsage).not.toHaveBeenCalled();
  });

  it('restart after stop works cleanly', async () => {
    vi.useFakeTimers();
    const fetchUsage = vi.fn(async () => [] as UsageRow[]);
    const venice = { fetchUsage } as unknown as VeniceClient;
    startUsagePolling(venice);
    await vi.advanceTimersByTimeAsync(0);
    stopUsagePolling();
    startUsagePolling(venice);
    await vi.advanceTimersByTimeAsync(0);
    // Two "immediate" fetches, one per start() call.
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });
});
