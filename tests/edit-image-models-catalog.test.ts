/**
 * Unit coverage for the AI pane's on-demand edit-model-catalog cache.
 * Mirrors image-models-catalog.test.ts (the generation twin): same
 * reactive state and entry points, exercised through a stubbed fetcher
 * (the shape of app.supabase.fetchEditModels).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VeniceError } from '../src/lib/venice';
import type { EditCatalogModel } from '../src/lib/models/edit-image-catalog';
import {
  editImageCatalog,
  isEditImageCatalogStale,
  shouldAutoRefreshEditImageCatalog,
  refreshEditImageCatalog,
  resetEditImageCatalog,
  EDIT_IMAGE_CATALOG_STALE_MS,
} from '../src/lib/edit-image-models-catalog.svelte';

function sampleModel(overrides: Partial<EditCatalogModel> = {}): EditCatalogModel {
  return {
    id: 'firered-image-edit',
    name: 'FireRed Image Edit',
    usdPerEdit: 0.04,
    privacy: 'private',
    beta: false,
    deprecated: false,
    ...overrides,
  };
}

function mockSource(impl: () => Promise<EditCatalogModel[]>) {
  return { fetchEditModels: vi.fn(impl) };
}

beforeEach(() => {
  resetEditImageCatalog();
});

afterEach(() => {
  resetEditImageCatalog();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('refreshEditImageCatalog', () => {
  it('populates data and sets lastFetchedAt on success', async () => {
    const before = Date.now();
    await refreshEditImageCatalog(mockSource(async () => [sampleModel()]));
    expect(editImageCatalog.data).toEqual([sampleModel()]);
    expect(editImageCatalog.error).toBeNull();
    expect(editImageCatalog.loading).toBe(false);
    expect(editImageCatalog.lastFetchedAt!).toBeGreaterThanOrEqual(before);
  });

  it('preserves prior data and surfaces error on failure', async () => {
    await refreshEditImageCatalog(mockSource(async () => [sampleModel({ id: 'keep' })]));
    await refreshEditImageCatalog(
      mockSource(async () => {
        throw new VeniceError('boom', 'network');
      })
    );
    expect(editImageCatalog.data).toEqual([sampleModel({ id: 'keep' })]);
    expect(editImageCatalog.error).toBe('boom');
    expect(editImageCatalog.loading).toBe(false);
  });
});

describe('staleness and auto-refresh', () => {
  it('reports stale until a fetch lands, then fresh inside the window', async () => {
    vi.useFakeTimers();
    expect(isEditImageCatalogStale()).toBe(true);
    await refreshEditImageCatalog(mockSource(async () => [sampleModel()]));
    expect(isEditImageCatalogStale()).toBe(false);
    vi.advanceTimersByTime(EDIT_IMAGE_CATALOG_STALE_MS + 1);
    expect(isEditImageCatalogStale()).toBe(true);
  });

  it('suppresses auto-refresh after an error until the error clears', async () => {
    await refreshEditImageCatalog(
      mockSource(async () => {
        throw new VeniceError('down', 'network');
      })
    );
    expect(shouldAutoRefreshEditImageCatalog()).toBe(false);
    // A manual retry clears the error first.
    editImageCatalog.error = null;
    expect(shouldAutoRefreshEditImageCatalog()).toBe(true);
  });

  it('never auto-refreshes while a fetch is in flight', () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    void refreshEditImageCatalog(mockSource(() => gate.then(() => [sampleModel()])));
    expect(shouldAutoRefreshEditImageCatalog()).toBe(false);
    release();
    return gate;
  });
});

describe('resetEditImageCatalog', () => {
  it('wipes data and error state', async () => {
    await refreshEditImageCatalog(mockSource(async () => [sampleModel()]));
    resetEditImageCatalog();
    expect(editImageCatalog.data).toBeNull();
    expect(editImageCatalog.lastFetchedAt).toBeNull();
    expect(editImageCatalog.error).toBeNull();
    expect(editImageCatalog.loading).toBe(false);
  });
});
