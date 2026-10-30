/**
 * Coverage for the skills store's query drivers. The store is a
 * module-level $state singleton plus exported async functions that
 * take a SupabaseService and mutate it; tests drive those functions
 * against a mock service and assert on the singleton, the same way
 * samskara-browse-store.test.ts drives its store.
 *
 * Focus is the branching the panel wiring doesn't reach: the
 * first-page dedupe, the supersede-token discipline (a late response
 * from a superseded flight must be discarded), and the
 * depth-preserving bus refresh.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  skillsStore,
  loadSkillsFirstPage,
  loadMoreSkills,
  refreshSkillsListing,
  runSkillsSearch,
} from '../src/lib/skills-store.svelte';
import {
  DEFAULT_LIST_PAGE_SIZE,
  type SkillSummary,
  type SupabaseService,
} from '../src/lib/supabase';

type Page = { rows: SkillSummary[]; hasMore: boolean };

function row(id: string): SkillSummary {
  return {
    id,
    name: `skill ${id}`,
    description: 'when to use it',
    updated_at: '2026-10-29T00:00:00Z',
    last_author: 'user',
  };
}

// Reset the singleton between tests - it persists across the module.
function resetStore(): void {
  skillsStore.results = [];
  skillsStore.loading = false;
  skillsStore.loaded = false;
  skillsStore.error = null;
  skillsStore.query = '';
  skillsStore.offset = 0;
  skillsStore.hasMore = false;
  skillsStore.loadingMore = false;
}

// A manually-resolved promise so a test can hold one flight open,
// supersede it, and resolve it late.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// The mock methods only need the shapes the store reads; cast
// through unknown like the samskara store tests do.
function fakeSupabase(overrides: Record<string, unknown> = {}): SupabaseService {
  return {
    listSkillsPage: vi.fn(async (): Promise<Page> => ({ rows: [], hasMore: false })),
    searchSkills: vi.fn(async (): Promise<SkillSummary[]> => []),
    ...overrides,
  } as unknown as SupabaseService;
}

beforeEach(resetStore);

describe('loadSkillsFirstPage', () => {
  it('loads page one, resets the window, and marks the store loaded', async () => {
    const listSkillsPage = vi.fn(
      async (): Promise<Page> => ({ rows: [row('a'), row('b')], hasMore: true }),
    );
    await loadSkillsFirstPage(fakeSupabase({ listSkillsPage }));
    expect(listSkillsPage).toHaveBeenCalledWith({
      offset: 0,
      pageSize: DEFAULT_LIST_PAGE_SIZE,
    });
    expect(skillsStore.results.map((r) => r.id)).toEqual(['a', 'b']);
    expect(skillsStore.offset).toBe(2);
    expect(skillsStore.hasMore).toBe(true);
    expect(skillsStore.loaded).toBe(true);
    expect(skillsStore.error).toBeNull();
  });

  it('dedupes a second call while a first-page load is already in flight', async () => {
    // Tab mount fires the first load from both the shell's kick and
    // the sidebar's debounced effect; the second call must not burn
    // a duplicate query.
    const gate = deferred<Page>();
    const listSkillsPage = vi.fn(() => gate.promise);
    const sb = fakeSupabase({ listSkillsPage });
    const first = loadSkillsFirstPage(sb);
    const second = loadSkillsFirstPage(sb);
    expect(listSkillsPage).toHaveBeenCalledTimes(1);
    gate.resolve({ rows: [row('a')], hasMore: false });
    await Promise.all([first, second]);
    expect(skillsStore.results.map((r) => r.id)).toEqual(['a']);
  });

  it('still supersedes an in-flight search when the query clears (no false dedupe)', async () => {
    // The dedupe keys on the in-flight flight's kind: a search in
    // flight when the query clears must be aborted and replaced by
    // the browse load, not mistaken for one.
    skillsStore.query = 'lasagna';
    const searchGate = deferred<SkillSummary[]>();
    const search = runSkillsSearch(
      fakeSupabase({ searchSkills: vi.fn(() => searchGate.promise) }),
    );
    skillsStore.query = '';
    await loadSkillsFirstPage(
      fakeSupabase({
        listSkillsPage: vi.fn(async (): Promise<Page> => ({ rows: [row('a')], hasMore: false })),
      }),
    );
    // The stale search resolves late and must not clobber the browse list.
    searchGate.resolve([row('stale')]);
    await search;
    expect(skillsStore.results.map((r) => r.id)).toEqual(['a']);
  });

  it('discards a late browse load superseded by a search', async () => {
    // The token discipline covers browse flights too: without it, a
    // first-page load resolving after the user typed a query would
    // clobber the search hits.
    const browseGate = deferred<Page>();
    const browse = loadSkillsFirstPage(
      fakeSupabase({ listSkillsPage: vi.fn(() => browseGate.promise) }),
    );
    skillsStore.query = 'lasagna';
    await runSkillsSearch(
      fakeSupabase({ searchSkills: vi.fn(async () => [row('hit')]) }),
    );
    expect(skillsStore.results.map((r) => r.id)).toEqual(['hit']);
    browseGate.resolve({ rows: [row('stale')], hasMore: true });
    await browse;
    expect(skillsStore.results.map((r) => r.id)).toEqual(['hit']);
  });
});

describe('loadMoreSkills', () => {
  it('appends the next page and advances the offset', async () => {
    skillsStore.results = [row('a'), row('b')];
    skillsStore.offset = 2;
    skillsStore.hasMore = true;
    const listSkillsPage = vi.fn(
      async (): Promise<Page> => ({ rows: [row('c')], hasMore: false }),
    );
    await loadMoreSkills(fakeSupabase({ listSkillsPage }));
    expect(listSkillsPage).toHaveBeenCalledWith({
      offset: 2,
      pageSize: DEFAULT_LIST_PAGE_SIZE,
    });
    expect(skillsStore.results.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(skillsStore.offset).toBe(3);
    expect(skillsStore.hasMore).toBe(false);
    expect(skillsStore.loadingMore).toBe(false);
  });

  it('is a no-op while a search is active (search results are not paged)', async () => {
    skillsStore.hasMore = true;
    skillsStore.query = 'lasagna';
    const listSkillsPage = vi.fn();
    await loadMoreSkills(fakeSupabase({ listSkillsPage }));
    expect(listSkillsPage).not.toHaveBeenCalled();
  });
});

describe('runSkillsSearch - supersede discipline', () => {
  it('discards a late stale search response superseded by a newer search', async () => {
    skillsStore.query = 'lasagna';
    const slowGate = deferred<SkillSummary[]>();
    const slow = runSkillsSearch(
      fakeSupabase({ searchSkills: vi.fn(() => slowGate.promise) }),
    );
    await runSkillsSearch(
      fakeSupabase({ searchSkills: vi.fn(async () => [row('fresh')]) }),
    );
    slowGate.resolve([row('stale')]);
    await slow;
    expect(skillsStore.results.map((r) => r.id)).toEqual(['fresh']);
  });
});

describe('refreshSkillsListing', () => {
  it('preserves scrolled depth in one query, the probe row driving hasMore', async () => {
    skillsStore.results = Array.from({ length: 100 }, (_, i) => row(`s${i}`));
    skillsStore.offset = 100;
    skillsStore.hasMore = true;
    const listSkillsPage = vi.fn(
      async (): Promise<Page> => ({
        rows: Array.from({ length: 100 }, (_, i) => row(`fresh${i}`)),
        hasMore: true,
      }),
    );
    await refreshSkillsListing(fakeSupabase({ listSkillsPage }));
    // One query covering the whole loaded window: offset 0, pageSize
    // = the current depth.
    expect(listSkillsPage).toHaveBeenCalledWith({ offset: 0, pageSize: 100 });
    expect(skillsStore.results).toHaveLength(100);
    expect(skillsStore.results[0]!.id).toBe('fresh0');
    expect(skillsStore.offset).toBe(100);
    expect(skillsStore.hasMore).toBe(true);
  });

  it('shrinks the window when rows were deleted elsewhere', async () => {
    skillsStore.results = Array.from({ length: 100 }, (_, i) => row(`s${i}`));
    skillsStore.offset = 100;
    skillsStore.hasMore = true;
    const listSkillsPage = vi.fn(
      async (): Promise<Page> => ({
        rows: Array.from({ length: 80 }, (_, i) => row(`kept${i}`)),
        hasMore: false,
      }),
    );
    await refreshSkillsListing(fakeSupabase({ listSkillsPage }));
    expect(listSkillsPage).toHaveBeenCalledWith({ offset: 0, pageSize: 100 });
    expect(skillsStore.results).toHaveLength(80);
    expect(skillsStore.offset).toBe(80);
    expect(skillsStore.hasMore).toBe(false);
  });

  it('falls back to one browse page when nothing has been scrolled', async () => {
    const listSkillsPage = vi.fn(
      async (): Promise<Page> => ({ rows: [row('a')], hasMore: false }),
    );
    await refreshSkillsListing(fakeSupabase({ listSkillsPage }));
    expect(listSkillsPage).toHaveBeenCalledWith({
      offset: 0,
      pageSize: DEFAULT_LIST_PAGE_SIZE,
    });
  });

  it('is a no-op in the search regime (the panel re-runs the search instead)', async () => {
    skillsStore.query = 'lasagna';
    const listSkillsPage = vi.fn();
    await refreshSkillsListing(fakeSupabase({ listSkillsPage }));
    expect(listSkillsPage).not.toHaveBeenCalled();
  });
});
