/**
 * Coverage for the Samskara browse store's dispatch logic. The store is
 * a module-level $state singleton plus exported async functions that
 * take a SupabaseService and mutate it; tests drive those functions
 * against a mock service and assert on the singleton, the same way
 * exchange-store.test.ts drives its store.
 *
 * Focus is the branching the primitives tests don't reach: the
 * browse / search / hide-similar regime dispatch, the loadMore no-op
 * guards, and the vector+text search merge-dedup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  samskaraBrowseStore,
  refreshSamskaraView,
  loadMoreSamskaras,
} from '../src/lib/samskara-browse-store.svelte';
import { CORPUS_LIST_LIMIT } from '../src/lib/ui/samskara-browse';
import type { SamskaraCorpusRow, SupabaseService } from '../src/lib/supabase';

function row(id: string): SamskaraCorpusRow {
  return {
    id,
    tier: 1,
    prediction: `pred ${id}`,
    innerVoice: null,
    valence: 0,
    confidence: 0.5,
    health: 1,
    fireCount: 0,
    confirmCount: 0,
    disconfirmCount: 0,
    lastFiredAt: null,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

// Reset the singleton between tests - it persists across the module.
function resetStore(): void {
  samskaraBrowseStore.results = [];
  samskaraBrowseStore.clusterMap = new Map();
  samskaraBrowseStore.query = '';
  samskaraBrowseStore.tier = null;
  samskaraBrowseStore.sort = 'recent';
  samskaraBrowseStore.hideSimilar = false;
  samskaraBrowseStore.hideSimilarThreshold = 0.85;
  samskaraBrowseStore.offset = 0;
  samskaraBrowseStore.hasMore = false;
  samskaraBrowseStore.loading = false;
  samskaraBrowseStore.loadingMore = false;
  samskaraBrowseStore.loaded = false;
  samskaraBrowseStore.error = null;
}

function fakeSupabase(overrides: Partial<SupabaseService> = {}): SupabaseService {
  return {
    listSamskarasPage: vi.fn(async () => ({ rows: [], hasMore: false })),
    searchSamskarasByEmbedding: vi.fn(async () => []),
    searchSamskarasByText: vi.fn(async () => []),
    samskaraClusterCorpus: vi.fn(async () => new Map()),
    embed: vi.fn(async () => ({ data: [{ embedding: [0.1, 0.2] as number[] }] })),
    ...overrides,
  } as unknown as SupabaseService;
}

beforeEach(resetStore);

describe('refreshSamskaraView - browse regime', () => {
  it('loads the first page, keeps pagination, leaves the cluster map empty', async () => {
    const listSamskarasPage = vi.fn(async () => ({ rows: [row('a'), row('b')], hasMore: true }));
    const sb = fakeSupabase({ listSamskarasPage } as unknown as Partial<SupabaseService>);
    await refreshSamskaraView(sb);
    expect(listSamskarasPage).toHaveBeenCalledWith({
      offset: 0,
      pageSize: CORPUS_LIST_LIMIT,
      tier: null,
      sort: 'recent',
    });
    expect(samskaraBrowseStore.results.map((r) => r.id)).toEqual(['a', 'b']);
    expect(samskaraBrowseStore.offset).toBe(2);
    expect(samskaraBrowseStore.hasMore).toBe(true);
    expect(samskaraBrowseStore.clusterMap.size).toBe(0);
    expect(samskaraBrowseStore.loaded).toBe(true);
    expect(samskaraBrowseStore.error).toBeNull();
  });

  it('threads the active tier and sort into the query', async () => {
    samskaraBrowseStore.tier = 2;
    samskaraBrowseStore.sort = 'strongest';
    const listSamskarasPage = vi.fn(async () => ({ rows: [], hasMore: false }));
    await refreshSamskaraView(fakeSupabase({ listSamskarasPage } as unknown as Partial<SupabaseService>));
    expect(listSamskarasPage).toHaveBeenCalledWith({
      offset: 0,
      pageSize: CORPUS_LIST_LIMIT,
      tier: 2,
      sort: 'strongest',
    });
  });

  it('clears a stale cluster map when the slider is off', async () => {
    samskaraBrowseStore.clusterMap = new Map([['x', { seq: 1, size: 3 }]]);
    await refreshSamskaraView(fakeSupabase());
    expect(samskaraBrowseStore.clusterMap.size).toBe(0);
  });

  it('records the error and still marks loaded when the list query throws', async () => {
    const sb = fakeSupabase({
      listSamskarasPage: vi.fn(async () => {
        throw new Error('network');
      }),
    } as unknown as Partial<SupabaseService>);
    await refreshSamskaraView(sb);
    expect(samskaraBrowseStore.error).toBe('network');
    expect(samskaraBrowseStore.loaded).toBe(true);
  });
});

describe('refreshSamskaraView - search regime', () => {
  it('merges vector hits then text hits, deduped, with pagination closed', async () => {
    samskaraBrowseStore.query = 'terse';
    const byEmbedding = vi.fn(async () => [row('a'), row('b')]);
    const byText = vi.fn(async () => [row('b'), row('c')]); // b is a duplicate
    const sb = fakeSupabase({
      searchSamskarasByEmbedding: byEmbedding,
      searchSamskarasByText: byText,
    } as unknown as Partial<SupabaseService>);
    await refreshSamskaraView(sb);
    expect(byEmbedding).toHaveBeenCalled();
    expect(byText).toHaveBeenCalled();
    // Vector-first, dedup by id.
    expect(samskaraBrowseStore.results.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(samskaraBrowseStore.hasMore).toBe(false);
    expect(samskaraBrowseStore.offset).toBe(3);
  });

  it('falls back to text search when the query embed fails', async () => {
    samskaraBrowseStore.query = 'foo';
    const byEmbedding = vi.fn(async () => [row('v')]);
    const byText = vi.fn(async () => [row('t')]);
    const sb = fakeSupabase({
      embed: vi.fn(async () => {
        throw new Error('no shared key');
      }),
      searchSamskarasByEmbedding: byEmbedding,
      searchSamskarasByText: byText,
    } as unknown as Partial<SupabaseService>);
    await refreshSamskaraView(sb);
    // Vector path is skipped entirely on embed failure.
    expect(byEmbedding).not.toHaveBeenCalled();
    expect(byText).toHaveBeenCalled();
    expect(samskaraBrowseStore.results.map((r) => r.id)).toEqual(['t']);
  });
});

describe('refreshSamskaraView - hide-similar regime', () => {
  it('loads the whole corpus and fetches the cluster map at the current threshold', async () => {
    samskaraBrowseStore.hideSimilar = true;
    samskaraBrowseStore.hideSimilarThreshold = 0.8;
    samskaraBrowseStore.tier = 1;
    const listSamskarasPage = vi.fn(async () => ({ rows: [row('a')], hasMore: false }));
    const cluster = new Map([['a', { seq: 1, size: 1 }]]);
    const samskaraClusterCorpus = vi.fn(async () => cluster);
    const sb = fakeSupabase({
      listSamskarasPage,
      samskaraClusterCorpus,
    } as unknown as Partial<SupabaseService>);
    await refreshSamskaraView(sb);
    // Load-all (no pagination) and cluster at the chosen tier+threshold.
    expect(listSamskarasPage).toHaveBeenCalledWith({
      offset: 0,
      pageSize: CORPUS_LIST_LIMIT * 20,
      tier: 1,
      sort: 'recent',
    });
    expect(samskaraClusterCorpus).toHaveBeenCalledWith(0.8, 1);
    expect(samskaraBrowseStore.clusterMap).toBe(cluster);
    expect(samskaraBrowseStore.hasMore).toBe(false);
  });

  it('keeps the list intact with an empty map when clustering fails', async () => {
    samskaraBrowseStore.hideSimilar = true;
    const sb = fakeSupabase({
      listSamskarasPage: vi.fn(async () => ({ rows: [row('a')], hasMore: false })),
      samskaraClusterCorpus: vi.fn(async () => {
        throw new Error('boom');
      }),
    } as unknown as Partial<SupabaseService>);
    await refreshSamskaraView(sb);
    expect(samskaraBrowseStore.results.map((r) => r.id)).toEqual(['a']);
    expect(samskaraBrowseStore.clusterMap.size).toBe(0);
    // A cluster failure degrades to no-collapse, not a panel error.
    expect(samskaraBrowseStore.error).toBeNull();
  });
});

describe('loadMoreSamskaras', () => {
  it('appends the next page and advances the offset in the browse regime', async () => {
    samskaraBrowseStore.hasMore = true;
    samskaraBrowseStore.offset = 2;
    samskaraBrowseStore.results = [row('a'), row('b')];
    const listSamskarasPage = vi.fn(async () => ({ rows: [row('c')], hasMore: false }));
    const sb = fakeSupabase({ listSamskarasPage } as unknown as Partial<SupabaseService>);
    await loadMoreSamskaras(sb);
    expect(listSamskarasPage).toHaveBeenCalledWith({
      offset: 2,
      pageSize: CORPUS_LIST_LIMIT,
      tier: null,
      sort: 'recent',
    });
    expect(samskaraBrowseStore.results.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(samskaraBrowseStore.offset).toBe(3);
    expect(samskaraBrowseStore.hasMore).toBe(false);
  });

  it('is a no-op when there is nothing more to load', async () => {
    samskaraBrowseStore.hasMore = false;
    const listSamskarasPage = vi.fn(async () => ({ rows: [row('x')], hasMore: true }));
    await loadMoreSamskaras(fakeSupabase({ listSamskarasPage } as unknown as Partial<SupabaseService>));
    expect(listSamskarasPage).not.toHaveBeenCalled();
  });

  it('is a no-op during an active search (search results are not paged)', async () => {
    samskaraBrowseStore.hasMore = true;
    samskaraBrowseStore.query = 'foo';
    const listSamskarasPage = vi.fn(async () => ({ rows: [], hasMore: false }));
    await loadMoreSamskaras(fakeSupabase({ listSamskarasPage } as unknown as Partial<SupabaseService>));
    expect(listSamskarasPage).not.toHaveBeenCalled();
  });

  it('is a no-op in hide-similar mode (the whole corpus is already loaded)', async () => {
    samskaraBrowseStore.hasMore = true;
    samskaraBrowseStore.hideSimilar = true;
    const listSamskarasPage = vi.fn(async () => ({ rows: [], hasMore: false }));
    await loadMoreSamskaras(fakeSupabase({ listSamskarasPage } as unknown as Partial<SupabaseService>));
    expect(listSamskarasPage).not.toHaveBeenCalled();
  });
});
