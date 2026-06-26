/**
 * Unit coverage for the Usage pane's on-demand cache. The store
 * exposes a reactive state object (data, lastFetchedAt, loading,
 * error) and three entry points (refreshUsage, isUsageStale,
 * resetUsage). We exercise each through a stubbed usage source (the
 * shape of app.supabase.fetchUsage) so the logic stays decoupled from
 * the real analytics endpoint and the clock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VeniceError } from '../src/lib/venice';
import type { UsageRequestOptions, UsageModelBucket } from '../src/lib/usage';
import {
  usage,
  isUsageStale,
  shouldAutoRefreshUsage,
  refreshUsage,
  resetUsage,
  USAGE_STALE_MS,
} from '../src/lib/usage-store.svelte';

function sampleBucket(overrides: Partial<UsageModelBucket> = {}): UsageModelBucket {
  return {
    modelName: 'GLM 5.1',
    tokens: 50_000,
    usd: 0.4,
    diem: 0,
    ...overrides,
  };
}

// A stub of the slice of SupabaseService that refreshUsage consumes - just the
// usage fetch. refreshUsage always calls it with an options object, so the impl
// receives the same opts (startDate/endDate) the real path would.
function mockSource(impl: (opts: UsageRequestOptions) => Promise<UsageModelBucket[]>) {
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
    const source = mockSource(async () => [sampleBucket()]);
    await refreshUsage(source);
    expect(usage.data).toEqual([sampleBucket()]);
    expect(usage.error).toBeNull();
    expect(usage.loading).toBe(false);
    expect(usage.lastFetchedAt).not.toBeNull();
    expect(usage.lastFetchedAt!).toBeGreaterThanOrEqual(before);
  });

  it('passes a rolling-7-day window to fetchUsage as YYYY-MM-DD dates', async () => {
    const fetchUsage = vi.fn(async (_opts: UsageRequestOptions) => [] as UsageModelBucket[]);
    await refreshUsage({ fetchUsage });
    expect(fetchUsage).toHaveBeenCalledOnce();
    const arg = fetchUsage.mock.calls[0][0];
    if (!arg) throw new Error('fetchUsage was called without options');
    // Both bounds are date-only YYYY-MM-DD strings (the analytics endpoint
    // reads them as an inclusive range; no time component).
    expect(arg.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(arg.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const spanMs =
      new Date(`${arg.endDate}T00:00:00Z`).getTime() -
      new Date(`${arg.startDate}T00:00:00Z`).getTime();
    const days = spanMs / (24 * 60 * 60 * 1000);
    // Seven days between the bounds; inclusive of both endpoints that is
    // the rolling 8-day window (today plus the week behind it) the pane's
    // avg-per-day divisor also assumes.
    expect(days).toBe(7);
  });

  it('preserves prior usage.data and surfaces error on failure', async () => {
    const okSource = mockSource(async () => [sampleBucket({ modelName: 'keep-me' })]);
    await refreshUsage(okSource);
    expect(usage.data).toEqual([sampleBucket({ modelName: 'keep-me' })]);

    const failSource = mockSource(async () => {
      throw new VeniceError('boom', 'network');
    });
    await refreshUsage(failSource);
    // Prior data is intentionally not wiped - a transient fetch failure
    // shouldn't blank the pane if a previous fetch has data to show.
    expect(usage.data).toEqual([sampleBucket({ modelName: 'keep-me' })]);
    expect(usage.error).toBe('boom');
    expect(usage.loading).toBe(false);
  });
});

describe('isUsageStale', () => {
  it('returns true when there has been no successful fetch yet', () => {
    // beforeEach resetUsage() reset lastFetchedAt to null.
    expect(usage.lastFetchedAt).toBeNull();
    expect(isUsageStale()).toBe(true);
  });

  it('returns false immediately after a successful fetch', async () => {
    await refreshUsage(mockSource(async () => [sampleBucket()]));
    expect(isUsageStale()).toBe(false);
  });

  it('flips to true once the cache crosses USAGE_STALE_MS', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T12:00:00Z'));
    await refreshUsage(mockSource(async () => [sampleBucket()]));
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
    await refreshUsage(mockSource(async () => [sampleBucket()]));
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
        return [sampleBucket()];
      })
    );
    expect(duringFetch).toBe(false); // usage.loading was true mid-fetch
  });
});

describe('resetUsage', () => {
  it('wipes the cache so rows from a prior API key do not leak across lock/unlock', async () => {
    await refreshUsage(mockSource(async () => [sampleBucket({ modelName: 'prior-key' })]));
    expect(usage.data).not.toBeNull();
    expect(usage.lastFetchedAt).not.toBeNull();

    resetUsage();

    expect(usage.data).toBeNull();
    expect(usage.lastFetchedAt).toBeNull();
    expect(usage.error).toBeNull();
    expect(usage.loading).toBe(false);
  });
});
