/**
 * Offline list fallback: when the device is offline, the wiki and
 * cookbook sidebar loaders serve the IndexedDB mirror instead of an
 * empty list, so the saved favorites/upcoming set stays browsable with
 * no network. Online failures (transient Supabase blips) are left as an
 * error rather than dropping into the cache regime.
 *
 * Exercised against a fake IndexedDB warmed via putCached, with a
 * SupabaseService stub whose list methods reject (modeling a device
 * that can't reach the server) and navigator.onLine forced.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { putCached } from '../src/lib/offline-cache';
import { offlineStatus } from '../src/lib/offline-sync.svelte';
import {
  loadWikiFirstPage,
  wikiStore,
} from '../src/lib/wiki-store.svelte';
import { loadRecipes, cookbook } from '../src/lib/cookbook-store.svelte';
import type { Recipe, SupabaseService, WikiArticle } from '../src/lib/supabase';

function article(id: string): WikiArticle {
  return {
    id,
    title: `Article ${id}`,
    content: `Body ${id}`,
    favorite: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function recipe(
  id: string,
  flags: { favorite?: boolean; upcoming?: boolean } = {},
): Recipe {
  return {
    id,
    title: `Recipe ${id}`,
    source: null,
    source_url: null,
    cooklang: `Cook ${id}`,
    rating: null,
    upcoming: flags.upcoming ?? false,
    favorite: flags.favorite ?? false,
    topics: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

/** Stub whose every list method rejects - an unreachable server. */
const offlineSupabase = (): SupabaseService =>
  ({
    listWikiArticlesPage: async () => {
      throw new Error('network down');
    },
    listFavoriteWikiArticles: async () => {
      throw new Error('network down');
    },
    listRecipesPage: async () => {
      throw new Error('network down');
    },
    listUpcomingRecipes: async () => {
      throw new Error('network down');
    },
    listFavoriteRecipes: async () => {
      throw new Error('network down');
    },
    listUserRecipeTopics: async () => {
      throw new Error('network down');
    },
  }) as unknown as SupabaseService;

/**
 * Stub whose list methods never settle - airplane mode, where the fetch
 * hangs on a connection timeout instead of rejecting promptly. A loader
 * that awaits this would stall forever; the offline path must not.
 */
const hangingSupabase = (): SupabaseService =>
  ({
    listWikiArticlesPage: () => new Promise<never>(() => {}),
    listFavoriteWikiArticles: () => new Promise<never>(() => {}),
    listRecipesPage: () => new Promise<never>(() => {}),
    listUpcomingRecipes: () => new Promise<never>(() => {}),
    listFavoriteRecipes: () => new Promise<never>(() => {}),
    listUserRecipeTopics: () => new Promise<never>(() => {}),
  }) as unknown as SupabaseService;

function setOnline(value: boolean): void {
  offlineStatus.online = value;
}

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('nak-offline-cache');
    req.onsuccess = (): void => resolve();
    req.onerror = (): void => resolve();
    req.onblocked = (): void => resolve();
  });
  setOnline(true);
});

afterEach(() => {
  setOnline(true);
});

describe('wiki list offline fallback', () => {
  it('serves the cached favorites (title ASC) and enters the cache regime', async () => {
    const now = Date.now();
    await putCached('articles', { id: 'b', row: article('b'), cachedAt: now });
    await putCached('articles', { id: 'a', row: article('a'), cachedAt: now });
    setOnline(false);

    await loadWikiFirstPage(offlineSupabase());

    expect(wikiStore.fromCache).toBe(true);
    expect(wikiStore.error).toBeNull();
    expect(wikiStore.results).toEqual([]);
    expect(wikiStore.hasMore).toBe(false);
    expect(wikiStore.favorites.map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('online fetch failure stays an error, not the cache regime', async () => {
    await putCached('articles', { id: 'a', row: article('a'), cachedAt: Date.now() });
    setOnline(true);

    await loadWikiFirstPage(offlineSupabase());

    expect(wikiStore.fromCache).toBe(false);
    expect(wikiStore.error).not.toBeNull();
  });

  it('offline: serves cache without awaiting a network that never settles', async () => {
    // The regression: airplane mode, where the fetch hangs rather than
    // rejecting. A loader that awaited it would never resolve this test.
    await putCached('articles', { id: 'a', row: article('a'), cachedAt: Date.now() });
    setOnline(false);

    await loadWikiFirstPage(hangingSupabase());

    expect(wikiStore.fromCache).toBe(true);
    expect(wikiStore.favorites.map((a) => a.id)).toEqual(['a']);
  });
});

describe('cookbook list offline fallback', () => {
  it('re-buckets the cached union into Upcoming / Favorites by flag', async () => {
    const now = Date.now();
    await putCached('recipes', {
      id: 'fav',
      row: recipe('fav', { favorite: true }),
      cachedAt: now,
    });
    await putCached('recipes', {
      id: 'up',
      row: recipe('up', { upcoming: true }),
      cachedAt: now,
    });
    await putCached('recipes', {
      id: 'both',
      row: recipe('both', { favorite: true, upcoming: true }),
      cachedAt: now,
    });
    setOnline(false);

    await loadRecipes(offlineSupabase());

    expect(cookbook.fromCache).toBe(true);
    expect(cookbook.error).toBeNull();
    expect(cookbook.recipes).toEqual([]);
    // A recipe flagged both rides in both buckets, mirroring online.
    expect(cookbook.favorites.map((r) => r.id).sort()).toEqual(['both', 'fav']);
    expect(cookbook.upcoming.map((r) => r.id).sort()).toEqual(['both', 'up']);
  });

  it('online fetch failure stays an error, not the cache regime', async () => {
    await putCached('recipes', {
      id: 'fav',
      row: recipe('fav', { favorite: true }),
      cachedAt: Date.now(),
    });
    setOnline(true);

    await loadRecipes(offlineSupabase());

    expect(cookbook.fromCache).toBe(false);
    expect(cookbook.error).not.toBeNull();
  });

  it('offline: serves cache without awaiting a network that never settles', async () => {
    await putCached('recipes', {
      id: 'fav',
      row: recipe('fav', { favorite: true }),
      cachedAt: Date.now(),
    });
    setOnline(false);

    await loadRecipes(hangingSupabase());

    expect(cookbook.fromCache).toBe(true);
    expect(cookbook.favorites.map((r) => r.id)).toEqual(['fav']);
  });
});
