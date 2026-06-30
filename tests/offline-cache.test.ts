/**
 * Offline-cache coverage. Two layers:
 *   1. The pure reconcile core (planReconcile / dedupeById) and the
 *      message primitive - no IndexedDB needed.
 *   2. Integration against a fake IndexedDB: the marked-set reconcile
 *      (add / refresh / evict), the load-bearing "never evict on a
 *      failed fetch" invariant, and the offline read-through.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  __test,
  syncOfflineCache,
  getArticleCached,
  getRecipeCached,
  getCachedArticles,
  getCachedRecipes,
  offlineStatus,
} from '../src/lib/offline-sync.svelte';
import { getAllCached, getCached } from '../src/lib/offline-cache';
import { missingRecordMessage } from '../src/lib/ui/offline-status';
import type { Recipe, SupabaseService, WikiArticle } from '../src/lib/supabase';

const { planReconcile, dedupeById } = __test;

function article(id: string, updated_at: string, favorite = true): WikiArticle {
  return {
    id,
    title: `Article ${id}`,
    content: `Body ${id} @ ${updated_at}`,
    favorite,
    created_at: '2026-01-01T00:00:00Z',
    updated_at,
  };
}

function recipe(id: string, updated_at: string): Recipe {
  return {
    id,
    title: `Recipe ${id}`,
    source: null,
    source_url: null,
    cooklang: `Cook ${id}`,
    rating: null,
    upcoming: false,
    favorite: true,
    topics: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at,
  };
}

/**
 * Minimal SupabaseService stand-in exposing only the methods the
 * offline layer reaches. `throws` flips every fetch to reject, modeling
 * an offline / transient-error device.
 */
function fakeSupabase(opts: {
  favArticles?: WikiArticle[];
  favRecipes?: Recipe[];
  upcomingRecipes?: Recipe[];
  byId?: Record<string, WikiArticle | Recipe | null>;
  throws?: boolean;
}): SupabaseService {
  const reject = (): never => {
    throw new Error('network down');
  };
  return {
    listFavoriteWikiArticles: async () =>
      opts.throws ? reject() : (opts.favArticles ?? []),
    listFavoriteRecipes: async () =>
      opts.throws ? reject() : (opts.favRecipes ?? []),
    listUpcomingRecipes: async () =>
      opts.throws ? reject() : (opts.upcomingRecipes ?? []),
    getWikiArticleById: async (id: string) =>
      opts.throws ? reject() : ((opts.byId?.[id] as WikiArticle | null) ?? null),
    getRecipe: async (id: string) =>
      opts.throws ? reject() : ((opts.byId?.[id] as Recipe | null) ?? null),
  } as unknown as SupabaseService;
}

beforeEach(async () => {
  // Fresh DB per test so cached state from a prior case can't leak.
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('nak-offline-cache');
    req.onsuccess = (): void => resolve();
    req.onerror = (): void => resolve();
    req.onblocked = (): void => resolve();
  });
  offlineStatus.online = true;
});

describe('planReconcile', () => {
  it('puts new rows, refreshes changed ones, leaves equal ones, evicts gone ones', () => {
    const cached = [
      { id: 'keep', updatedAt: '2026-06-01T00:00:00Z' },
      { id: 'changed', updatedAt: '2026-06-01T00:00:00Z' },
      { id: 'gone', updatedAt: '2026-06-01T00:00:00Z' },
    ];
    const rows = [
      article('keep', '2026-06-01T00:00:00Z'), // unchanged updated_at
      article('changed', '2026-06-09T00:00:00Z'), // newer -> re-cache
      article('new', '2026-06-09T00:00:00Z'), // not cached -> cache
    ];
    const plan = planReconcile(cached, rows);
    expect(plan.put.map((r) => r.id).sort()).toEqual(['changed', 'new']);
    expect(plan.deleteIds).toEqual(['gone']);
  });

  it('treats a bookmark toggle (same updated_at) as no change', () => {
    const cached = [{ id: 'a', updatedAt: '2026-06-01T00:00:00Z' }];
    // Re-favorited row: favorite flips but updated_at is unchanged.
    const rows = [article('a', '2026-06-01T00:00:00Z', true)];
    expect(planReconcile(cached, rows).put).toEqual([]);
  });
});

describe('dedupeById', () => {
  it('unions lists keeping the first occurrence of each id', () => {
    const fav = [recipe('a', 't'), recipe('b', 't')];
    const upcoming = [recipe('b', 't'), recipe('c', 't')];
    expect(dedupeById(fav, upcoming).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('missingRecordMessage', () => {
  it('prioritizes loading, then offline, then not-found', () => {
    expect(missingRecordMessage({ fetching: true, online: false, noun: 'article' })).toBe(
      'Loading article…',
    );
    expect(
      missingRecordMessage({ fetching: false, online: false, noun: 'article' }),
    ).toContain("isn't saved for offline use");
    expect(
      missingRecordMessage({ fetching: false, online: true, noun: 'recipe' }),
    ).toContain("couldn't be found");
  });
});

describe('syncOfflineCache', () => {
  it('mirrors the marked set into the cache and reports ok', async () => {
    const res = await syncOfflineCache(
      fakeSupabase({
        favArticles: [article('a1', 't1')],
        favRecipes: [recipe('r1', 't1')],
        upcomingRecipes: [recipe('r2', 't1')],
      }),
    );
    expect(res.ok).toBe(true);
    const articles = await getAllCached<WikiArticle>('articles');
    const recipes = await getAllCached<Recipe>('recipes');
    expect(articles.map((e) => e.id)).toEqual(['a1']);
    expect(recipes.map((e) => e.id).sort()).toEqual(['r1', 'r2']);
  });

  it('evicts rows that left the marked set', async () => {
    await syncOfflineCache(fakeSupabase({ favArticles: [article('a1', 't1'), article('a2', 't1')] }));
    // a2 un-favorited: a later authoritative sync drops it.
    await syncOfflineCache(fakeSupabase({ favArticles: [article('a1', 't1')] }));
    const articles = await getAllCached<WikiArticle>('articles');
    expect(articles.map((e) => e.id)).toEqual(['a1']);
  });

  it('NEVER evicts when the fetch fails (offline) - the cache survives', async () => {
    await syncOfflineCache(fakeSupabase({ favArticles: [article('a1', 't1')] }));
    // Device goes offline: the authoritative fetch throws.
    const res = await syncOfflineCache(fakeSupabase({ throws: true }));
    expect(res.ok).toBe(false);
    // The saved copy must still be there - this is the whole point of
    // distinguishing "can't reach remote" from "remote changed".
    const articles = await getAllCached<WikiArticle>('articles');
    expect(articles.map((e) => e.id)).toEqual(['a1']);
  });
});

describe('read-through resolvers', () => {
  it('online: fetches and refreshes the cache', async () => {
    const sup = fakeSupabase({ byId: { a1: article('a1', 't1') } });
    const res = await getArticleCached(sup, 'a1');
    expect(res.fromCache).toBe(false);
    expect(res.row?.id).toBe('a1');
    expect(await getCached<WikiArticle>('articles', 'a1')).not.toBeNull();
  });

  it('offline: serves the cached copy', async () => {
    // Prime the cache while "online".
    await getArticleCached(fakeSupabase({ byId: { a1: article('a1', 't1') } }), 'a1');
    offlineStatus.online = false;
    // Offline supabase would throw if called; the resolver must not call it.
    const res = await getArticleCached(fakeSupabase({ throws: true }), 'a1');
    expect(res.fromCache).toBe(true);
    expect(res.row?.id).toBe('a1');
  });

  it('online network error: falls back to the cached copy', async () => {
    await getRecipeCached(fakeSupabase({ byId: { r1: recipe('r1', 't1') } }), 'r1');
    // Still flagged online, but the fetch throws (transient) - resolver
    // should fall through to the cache rather than surfacing null.
    const res = await getRecipeCached(fakeSupabase({ throws: true }), 'r1');
    expect(res.fromCache).toBe(true);
    expect(res.row?.id).toBe('r1');
  });

  it('online authoritative null: clears any stale cache and reports a miss', async () => {
    await getArticleCached(fakeSupabase({ byId: { a1: article('a1', 't1') } }), 'a1');
    // Article deleted server-side: getWikiArticleById now returns null.
    const res = await getArticleCached(fakeSupabase({ byId: { a1: null } }), 'a1');
    expect(res.row).toBeNull();
    expect(await getCached<WikiArticle>('articles', 'a1')).toBeNull();
  });
});

describe('offline list readers', () => {
  it('getCachedArticles returns the mirrored set title ASC', async () => {
    await syncOfflineCache(
      fakeSupabase({
        // article(id).title === `Article ${id}`, so id order == title order.
        favArticles: [article('c', 't1'), article('a', 't1'), article('b', 't1')],
      }),
    );
    expect((await getCachedArticles()).map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });

  it('getCachedRecipes returns the favorited-or-upcoming union, updated_at desc', async () => {
    await syncOfflineCache(
      fakeSupabase({
        favRecipes: [recipe('old', '2026-01-01T00:00:00Z')],
        upcomingRecipes: [recipe('new', '2026-09-01T00:00:00Z')],
      }),
    );
    // Newest first, and the favorite + upcoming buckets are unioned.
    expect((await getCachedRecipes()).map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('both readers are empty when nothing has been mirrored', async () => {
    expect(await getCachedArticles()).toEqual([]);
    expect(await getCachedRecipes()).toEqual([]);
  });
});
