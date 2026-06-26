/**
 * Unit coverage for the AI pane's on-demand image-model-catalog cache.
 * Mirrors models-catalog.test.ts (the text twin): same reactive state and
 * entry points, exercised through a stubbed fetcher (the shape of
 * app.supabase.fetchImageModels) so the logic stays decoupled from the
 * real /models endpoint and the clock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VeniceError } from '../src/lib/venice';
import type { ImageCatalogModel } from '../src/lib/models/image-catalog';
import {
  imageCatalog,
  isImageCatalogStale,
  shouldAutoRefreshImageCatalog,
  refreshImageCatalog,
  resetImageCatalog,
  IMAGE_CATALOG_STALE_MS,
} from '../src/lib/image-models-catalog.svelte';

function sampleModel(overrides: Partial<ImageCatalogModel> = {}): ImageCatalogModel {
  return {
    id: 'venice-sd35',
    name: 'Venice SD3.5',
    usdPerImage: 0.01,
    beta: false,
    deprecated: false,
    ...overrides,
  };
}

function mockSource(impl: () => Promise<ImageCatalogModel[]>) {
  return { fetchImageModels: vi.fn(impl) };
}

beforeEach(() => {
  resetImageCatalog();
});

afterEach(() => {
  resetImageCatalog();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('refreshImageCatalog', () => {
  it('populates data and sets lastFetchedAt on success', async () => {
    const before = Date.now();
    await refreshImageCatalog(mockSource(async () => [sampleModel()]));
    expect(imageCatalog.data).toEqual([sampleModel()]);
    expect(imageCatalog.error).toBeNull();
    expect(imageCatalog.loading).toBe(false);
    expect(imageCatalog.lastFetchedAt!).toBeGreaterThanOrEqual(before);
  });

  it('preserves prior data and surfaces error on failure', async () => {
    await refreshImageCatalog(mockSource(async () => [sampleModel({ id: 'keep' })]));
    await refreshImageCatalog(
      mockSource(async () => {
        throw new VeniceError('boom', 'network');
      })
    );
    expect(imageCatalog.data).toEqual([sampleModel({ id: 'keep' })]);
    expect(imageCatalog.error).toBe('boom');
    expect(imageCatalog.loading).toBe(false);
  });
});

describe('isImageCatalogStale', () => {
  it('is true with no successful fetch yet', () => {
    expect(imageCatalog.lastFetchedAt).toBeNull();
    expect(isImageCatalogStale()).toBe(true);
  });

  it('flips to true once the cache crosses IMAGE_CATALOG_STALE_MS', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T12:00:00Z'));
    await refreshImageCatalog(mockSource(async () => [sampleModel()]));
    expect(isImageCatalogStale()).toBe(false);
    vi.setSystemTime(new Date(Date.now() + IMAGE_CATALOG_STALE_MS + 1));
    expect(isImageCatalogStale()).toBe(true);
  });
});

describe('shouldAutoRefreshImageCatalog', () => {
  it('is true on a cold store', () => {
    expect(shouldAutoRefreshImageCatalog()).toBe(true);
  });

  it('is false after a failed fetch, so the on-open effect cannot retry-storm', async () => {
    await refreshImageCatalog(
      mockSource(async () => {
        throw new VeniceError('boom', 'http', 502);
      })
    );
    expect(imageCatalog.error).not.toBeNull();
    expect(isImageCatalogStale()).toBe(true);
    expect(shouldAutoRefreshImageCatalog()).toBe(false);
  });

  it('is false while a fetch is in flight', async () => {
    let duringFetch = true;
    await refreshImageCatalog(
      mockSource(async () => {
        duringFetch = shouldAutoRefreshImageCatalog();
        return [sampleModel()];
      })
    );
    expect(duringFetch).toBe(false);
  });
});

describe('resetImageCatalog', () => {
  it('wipes the cache so a prior key catalog does not leak across lock/unlock', async () => {
    await refreshImageCatalog(mockSource(async () => [sampleModel()]));
    resetImageCatalog();
    expect(imageCatalog.data).toBeNull();
    expect(imageCatalog.lastFetchedAt).toBeNull();
    expect(imageCatalog.error).toBeNull();
    expect(imageCatalog.loading).toBe(false);
  });
});
