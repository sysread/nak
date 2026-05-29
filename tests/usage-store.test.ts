/**
 * Unit coverage for the Usage pane's on-demand cache. The store
 * exposes a reactive state object (data, lastFetchedAt, loading,
 * error, truncated, pagesLoaded, pagesTotal) and three entry points
 * (refreshUsage, isUsageStale, resetUsage). We exercise each through
 * a stubbed usage source (the shape of app.supabase.fetchUsage) so the
 * logic stays decoupled from the real billing endpoint and the clock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VeniceError } from '../src/lib/venice';
import type { UsageRequestOptions, UsageRow } from '../src/lib/usage';
import {
  usage,
  isUsageStale,
  shouldAutoRefreshUsage,
  refreshUsage,
  resetUsage,
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

// A stub of the slice of SupabaseService that refreshUsage consumes - just the
// usage fetch. refreshUsage always calls it with an options object, so the impl
// receives the same opts (startDate/endDate/onProgress) the real path would.
function mockSource(impl: (opts: UsageRequestOptions) => Promise<UsageRow[]>) {
  return { fetchUsage: vi.fn(impl) };
}

beforeEach(() => {
  // Every test gets a clean store so state from a previous test can't
  // bleed across. resetUsage wipes every field back to its init value.
  resetUsage();
});

afterEach(() => {
  resetUsage();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('refreshUsage', () => {
  it('populates usage.data and sets lastFetchedAt on success', async () => {
    const before = Date.now();
    const source = mockSource(async () => [sampleRow()]);
    await refreshUsage(source);
    expect(usage.data).toEqual([sampleRow()]);
    expect(usage.error).toBeNull();
    expect(usage.loading).toBe(false);
    expect(usage.lastFetchedAt).not.toBeNull();
    expect(usage.lastFetchedAt!).toBeGreaterThanOrEqual(before);
  });

  it('passes a rolling-7-day window to fetchUsage as ISO timestamps', async () => {
    const fetchUsage = vi.fn(async (_opts: UsageRequestOptions) => [] as UsageRow[]);
    await refreshUsage({ fetchUsage });
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
    const okSource = mockSource(async () => [sampleRow({ sku: 'keep-me' })]);
    await refreshUsage(okSource);
    expect(usage.data).toEqual([sampleRow({ sku: 'keep-me' })]);

    const failSource = mockSource(async () => {
      throw new VeniceError('boom', 'network');
    });
    await refreshUsage(failSource);
    // Prior data is intentionally not wiped - a transient fetch failure
    // shouldn't blank the pane if a previous fetch has data to show.
    expect(usage.data).toEqual([sampleRow({ sku: 'keep-me' })]);
    expect(usage.error).toBe('boom');
    expect(usage.loading).toBe(false);
  });

  it('marks truncated when rows hit the page cap', async () => {
    // The cap is USAGE_MAX_PAGES (20) x 500 = 10_000. Fabricating
    // that many rows in-test is wasteful; instead stub the source
    // to return exactly the cap count of minimal rows.
    const CAP = 20 * 500;
    const rows = Array.from({ length: CAP }, () => sampleRow());
    const source = mockSource(async () => rows);
    await refreshUsage(source);
    expect(usage.truncated).toBe(true);
  });

  it('clears the truncated flag when a later fetch comes back under the cap', async () => {
    const CAP = 20 * 500;
    const bigRows = Array.from({ length: CAP }, () => sampleRow());
    await refreshUsage(mockSource(async () => bigRows));
    expect(usage.truncated).toBe(true);
    await refreshUsage(mockSource(async () => [sampleRow()]));
    expect(usage.truncated).toBe(false);
  });

  it('plumbs pagesLoaded / pagesTotal from the fetchUsage onProgress callback', async () => {
    // The store's progress fields are what the Settings pane reads to
    // render the determinate "Loading… N/M" indicator. Drive the
    // stub's onProgress hook the same way collectUsagePages does in
    // production and assert the final pair lands in the store.
    // Reset-to-zero on entry is covered by the next test.
    const source = mockSource(async (opts) => {
      opts.onProgress?.({ page: 1, totalPages: 3 });
      opts.onProgress?.({ page: 2, totalPages: 3 });
      opts.onProgress?.({ page: 3, totalPages: 3 });
      return [sampleRow()];
    });
    await refreshUsage(source);
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
    const populate = mockSource(async (opts) => {
      opts.onProgress?.({ page: 5, totalPages: 5 });
      return [sampleRow()];
    });
    await refreshUsage(populate);
    expect(usage.pagesLoaded).toBe(5);

    let observedDuringFetch = { pagesLoaded: -1, pagesTotal: -1 };
    const observe = mockSource(async () => {
      observedDuringFetch = {
        pagesLoaded: usage.pagesLoaded,
        pagesTotal: usage.pagesTotal,
      };
      return [sampleRow()];
    });
    await refreshUsage(observe);
    expect(observedDuringFetch).toEqual({ pagesLoaded: 0, pagesTotal: 0 });
  });
});

describe('isUsageStale', () => {
  it('returns true when there has been no successful fetch yet', () => {
    // beforeEach resetUsage() reset lastFetchedAt to null.
    expect(usage.lastFetchedAt).toBeNull();
    expect(isUsageStale()).toBe(true);
  });

  it('returns false immediately after a successful fetch', async () => {
    await refreshUsage(mockSource(async () => [sampleRow()]));
    expect(isUsageStale()).toBe(false);
  });

  it('flips to true once the cache crosses USAGE_STALE_MS', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T12:00:00Z'));
    await refreshUsage(mockSource(async () => [sampleRow()]));
    expect(isUsageStale()).toBe(false);
    // One millisecond past the threshold is enough.
    vi.setSystemTime(new Date(Date.now() + USAGE_STALE_MS + 1));
    expect(isUsageStale()).toBe(true);
  });
});

describe('shouldAutoRefreshUsage', () => {
  it('is true on a cold store (stale, no error, not loading)', () => {
    expect(shouldAutoRefreshUsage()).toBe(true);
  });

  it('is false after a successful fetch (cache is fresh)', async () => {
    await refreshUsage(mockSource(async () => [sampleRow()]));
    expect(shouldAutoRefreshUsage()).toBe(false);
  });

  it('is false after a failed fetch, so the on-open effect cannot retry-storm', async () => {
    // Regression guard for the runaway loop the milestone-2 browser vet found:
    // a failed auto-load leaves lastFetchedAt null (so isUsageStale() stays
    // true). Without the error guard the Settings on-open effect would re-fire
    // the instant `loading` flips back to false - a tight retry storm against
    // the usage endpoint. The error guard makes the failed attempt terminal
    // until the user manually refreshes.
    await refreshUsage(
      mockSource(async () => {
        throw new VeniceError('boom', 'http', 502);
      })
    );
    expect(usage.error).not.toBeNull();
    expect(isUsageStale()).toBe(true); // still "stale" - the failed fetch set no timestamp
    expect(shouldAutoRefreshUsage()).toBe(false);
  });

  it('is false while a fetch is in flight', async () => {
    let duringFetch = true;
    await refreshUsage(
      mockSource(async () => {
        duringFetch = shouldAutoRefreshUsage();
        return [sampleRow()];
      })
    );
    expect(duringFetch).toBe(false); // usage.loading was true mid-fetch
  });
});

describe('resetUsage', () => {
  it('wipes the cache so rows from a prior API key do not leak across lock/unlock', async () => {
    await refreshUsage(mockSource(async () => [sampleRow({ sku: 'prior-key' })]));
    expect(usage.data).not.toBeNull();
    expect(usage.lastFetchedAt).not.toBeNull();

    resetUsage();

    expect(usage.data).toBeNull();
    expect(usage.lastFetchedAt).toBeNull();
    expect(usage.error).toBeNull();
    expect(usage.truncated).toBe(false);
    expect(usage.pagesLoaded).toBe(0);
    expect(usage.pagesTotal).toBe(0);
  });
});
