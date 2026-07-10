/**
 * Unit coverage for the AI pane's on-demand model-catalog cache. Mirrors
 * usage-store.test.ts: the store exposes a reactive state object (data,
 * lastFetchedAt, loading, error) and entry points (refreshCatalog,
 * isCatalogStale, shouldAutoRefreshCatalog, resetCatalog). Exercised
 * through a stubbed fetcher (the shape of app.supabase.fetchModels) so the
 * logic stays decoupled from the real /models endpoint and the clock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VeniceError } from '../src/lib/venice';
import type { CatalogModel } from '../src/lib/models/catalog';
import {
  catalog,
  isCatalogStale,
  shouldAutoRefreshCatalog,
  refreshCatalog,
  resetCatalog,
  CATALOG_STALE_MS,
} from '../src/lib/models-catalog.svelte';

function sampleModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: 'glm-5-1',
    name: 'GLM 5.1',
    contextWindow: 200_000,
    supportsVision: true,
    supportsReasoning: true,
    supportsFunctionCalling: true,
    supportsResponseFormat: true,
    inputUsdPerM: 0.3,
    outputUsdPerM: 1.2,
    deprecated: false,
    privacy: null,
    supportsE2EE: false,
    ...overrides,
  };
}

function mockSource(impl: () => Promise<CatalogModel[]>) {
  return { fetchModels: vi.fn(impl) };
}

beforeEach(() => {
  resetCatalog();
});

afterEach(() => {
  resetCatalog();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('refreshCatalog', () => {
  it('populates catalog.data and sets lastFetchedAt on success', async () => {
    const before = Date.now();
    await refreshCatalog(mockSource(async () => [sampleModel()]));
    expect(catalog.data).toEqual([sampleModel()]);
    expect(catalog.error).toBeNull();
    expect(catalog.loading).toBe(false);
    expect(catalog.lastFetchedAt!).toBeGreaterThanOrEqual(before);
  });

  it('preserves prior data and surfaces error on failure', async () => {
    await refreshCatalog(mockSource(async () => [sampleModel({ id: 'keep' })]));
    await refreshCatalog(
      mockSource(async () => {
        throw new VeniceError('boom', 'network');
      })
    );
    expect(catalog.data).toEqual([sampleModel({ id: 'keep' })]);
    expect(catalog.error).toBe('boom');
    expect(catalog.loading).toBe(false);
  });
});

describe('isCatalogStale', () => {
  it('is true with no successful fetch yet', () => {
    expect(catalog.lastFetchedAt).toBeNull();
    expect(isCatalogStale()).toBe(true);
  });

  it('flips to true once the cache crosses CATALOG_STALE_MS', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T12:00:00Z'));
    await refreshCatalog(mockSource(async () => [sampleModel()]));
    expect(isCatalogStale()).toBe(false);
    vi.setSystemTime(new Date(Date.now() + CATALOG_STALE_MS + 1));
    expect(isCatalogStale()).toBe(true);
  });
});

describe('shouldAutoRefreshCatalog', () => {
  it('is true on a cold store', () => {
    expect(shouldAutoRefreshCatalog()).toBe(true);
  });

  it('is false after a failed fetch, so the on-open effect cannot retry-storm', async () => {
    await refreshCatalog(
      mockSource(async () => {
        throw new VeniceError('boom', 'http', 502);
      })
    );
    expect(catalog.error).not.toBeNull();
    expect(isCatalogStale()).toBe(true);
    expect(shouldAutoRefreshCatalog()).toBe(false);
  });

  it('is false while a fetch is in flight', async () => {
    let duringFetch = true;
    await refreshCatalog(
      mockSource(async () => {
        duringFetch = shouldAutoRefreshCatalog();
        return [sampleModel()];
      })
    );
    expect(duringFetch).toBe(false);
  });
});

describe('resetCatalog', () => {
  it('wipes the cache so a prior key catalog does not leak across lock/unlock', async () => {
    await refreshCatalog(mockSource(async () => [sampleModel()]));
    resetCatalog();
    expect(catalog.data).toBeNull();
    expect(catalog.lastFetchedAt).toBeNull();
    expect(catalog.error).toBeNull();
    expect(catalog.loading).toBe(false);
  });
});
