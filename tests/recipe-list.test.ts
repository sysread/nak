/**
 * Unit coverage for the recipe-list UI primitives. Pure functions
 * - no runes, no DOM, no reactive state - tested via plain vitest.
 *
 * The companion `src/components/RecipeList.svelte` is the only
 * caller that wires these into Svelte reactivity (the `query` /
 * `sortMode` runes, the debounced `$effect` that orchestrates the
 * embed-then-search round trip, the AbortController that
 * supersedes stale calls). A port to another framework would re-
 * use this module untouched.
 */
import { describe, it, expect } from 'vitest';
import type { Recipe } from '../src/lib/supabase';
import { UNTAGGED_TOPIC_SENTINEL } from '../src/lib/supabase';
import {
  RECIPE_SEARCH_LIMIT,
  SEARCH_DEBOUNCE_MS,
  computeListView,
  isSearching,
  matchesTopicFilter,
  pickFavoriteRecipes,
  pickUpcomingRecipes,
  pickVisibleRecipes,
} from '../src/lib/ui/recipe-list';

function makeRecipe(id: string, overrides: Partial<Recipe> = {}): Recipe {
  return {
    id,
    title: `Recipe ${id}`,
    source: null,
    source_url: null,
    cooklang: '',
    rating: null,
    upcoming: false,
    favorite: false,
    topics: [],
    created_at: '2026-05-19T12:00:00Z',
    updated_at: '2026-05-19T12:00:00Z',
    ...overrides,
  };
}

describe('constants', () => {
  it('exposes the debounce window and search-limit knobs', () => {
    // These are tunables a port would carry across; assert their
    // shape so a fork that changes them surfaces the change here.
    expect(SEARCH_DEBOUNCE_MS).toBe(200);
    expect(RECIPE_SEARCH_LIMIT).toBe(50);
  });
});

describe('isSearching', () => {
  it('is false for an empty string', () => {
    expect(isSearching('')).toBe(false);
  });

  it('is false for whitespace-only input', () => {
    // The trim is load-bearing - a stray space from a previous
    // search should not keep the UI in search mode.
    expect(isSearching('   ')).toBe(false);
  });

  it('is true for any non-whitespace content', () => {
    expect(isSearching('chocolate')).toBe(true);
    expect(isSearching('  cake  ')).toBe(true);
  });
});

describe('pickVisibleRecipes', () => {
  it('returns server-order results when searching', () => {
    // Relevance ranking comes pre-sorted by the supabase RPC;
    // the primitive must preserve that order verbatim, including
    // skipping any local sortMode the user has selected.
    const a = makeRecipe('a', { rating: 1 });
    const b = makeRecipe('b', { rating: 5 });
    const c = makeRecipe('c', { rating: 3 });
    const out = pickVisibleRecipes({
      searching: true,
      searchResults: [a, b, c],
      storeRecipes: [c, b, a],
      sortMode: 'rating',
      selectedTopics: [],
    });
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('falls back to store order when not searching and sort is updated', () => {
    const a = makeRecipe('a');
    const b = makeRecipe('b');
    const out = pickVisibleRecipes({
      searching: false,
      searchResults: [],
      storeRecipes: [a, b],
      sortMode: 'updated',
      selectedTopics: [],
    });
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('sorts by rating desc with the null-rank/recency tie-break', () => {
    const unrated = makeRecipe('unrated', {
      rating: null,
      updated_at: '2026-05-19T15:00:00Z',
    });
    const r1 = makeRecipe('r1', {
      rating: 1,
      updated_at: '2026-05-19T10:00:00Z',
    });
    const r5_old = makeRecipe('r5_old', {
      rating: 5,
      updated_at: '2026-05-01T00:00:00Z',
    });
    const r5_new = makeRecipe('r5_new', {
      rating: 5,
      updated_at: '2026-05-19T11:00:00Z',
    });
    const out = pickVisibleRecipes({
      searching: false,
      searchResults: [],
      storeRecipes: [unrated, r1, r5_old, r5_new],
      sortMode: 'rating',
      selectedTopics: [],
    });
    // 5-star recent first, then 5-star old (tie broken by recency),
    // then 1-star, then unrated last (null rank below the lowest
    // real rating).
    expect(out.map((r) => r.id)).toEqual(['r5_new', 'r5_old', 'r1', 'unrated']);
  });

  it('does not mutate the input store array', () => {
    const a = makeRecipe('a', { rating: 1 });
    const b = makeRecipe('b', { rating: 5 });
    const store = [a, b];
    pickVisibleRecipes({
      searching: false,
      searchResults: [],
      storeRecipes: store,
      sortMode: 'rating',
      selectedTopics: [],
    });
    expect(store.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('pickUpcomingRecipes', () => {
  it('filters by upcoming and sorts by updated_at desc', () => {
    const a = makeRecipe('a', {
      upcoming: true,
      updated_at: '2026-05-19T10:00:00Z',
    });
    const b = makeRecipe('b', {
      upcoming: false,
      updated_at: '2026-05-19T11:00:00Z',
    });
    const c = makeRecipe('c', {
      upcoming: true,
      updated_at: '2026-05-19T12:00:00Z',
    });
    const out = pickUpcomingRecipes([a, b, c], false, []);
    expect(out.map((r) => r.id)).toEqual(['c', 'a']);
  });

  it('returns an empty array when searching', () => {
    // The relevance ranking owns the order during a search; a
    // bucket above it would visually fight the result list.
    const a = makeRecipe('a', { upcoming: true });
    expect(pickUpcomingRecipes([a], true, [])).toEqual([]);
  });

  it('returns an empty array when no recipe is flagged upcoming', () => {
    const a = makeRecipe('a', { upcoming: false });
    expect(pickUpcomingRecipes([a], false, [])).toEqual([]);
  });

  it('narrows by the active topic filter', () => {
    const a = makeRecipe('a', { upcoming: true, topics: ['italian'] });
    const b = makeRecipe('b', { upcoming: true, topics: ['mexican'] });
    const out = pickUpcomingRecipes([a, b], false, ['italian']);
    expect(out.map((r) => r.id)).toEqual(['a']);
  });
});

describe('pickFavoriteRecipes', () => {
  it('filters by favorite and sorts by updated_at desc', () => {
    const a = makeRecipe('a', {
      favorite: true,
      updated_at: '2026-05-19T10:00:00Z',
    });
    const b = makeRecipe('b', {
      favorite: false,
      updated_at: '2026-05-19T11:00:00Z',
    });
    const c = makeRecipe('c', {
      favorite: true,
      updated_at: '2026-05-19T12:00:00Z',
    });
    const out = pickFavoriteRecipes([a, b, c], false, []);
    expect(out.map((r) => r.id)).toEqual(['c', 'a']);
  });

  it('returns an empty array when searching', () => {
    const a = makeRecipe('a', { favorite: true });
    expect(pickFavoriteRecipes([a], true, [])).toEqual([]);
  });

  it('a recipe flagged both upcoming and favorite appears in both buckets', () => {
    // Duplication is intentional - the user gets to see the row
    // in every section it qualifies for; the main listing also
    // still shows it in its natural slot.
    const both = makeRecipe('both', { upcoming: true, favorite: true });
    expect(pickUpcomingRecipes([both], false, [])).toHaveLength(1);
    expect(pickFavoriteRecipes([both], false, [])).toHaveLength(1);
  });

  it('narrows by the active topic filter', () => {
    const a = makeRecipe('a', { favorite: true, topics: ['italian'] });
    const b = makeRecipe('b', { favorite: true, topics: ['mexican'] });
    const out = pickFavoriteRecipes([a, b], false, ['italian']);
    expect(out.map((r) => r.id)).toEqual(['a']);
  });
});

describe('matchesTopicFilter', () => {
  it('returns true when the selection is empty (no filter active)', () => {
    const r = makeRecipe('a', { topics: [] });
    expect(matchesTopicFilter(r, [])).toBe(true);
  });

  it('matches by topic overlap (OR semantics)', () => {
    const r = makeRecipe('a', { topics: ['italian', 'pasta'] });
    expect(matchesTopicFilter(r, ['italian'])).toBe(true);
    expect(matchesTopicFilter(r, ['pasta'])).toBe(true);
    expect(matchesTopicFilter(r, ['italian', 'mexican'])).toBe(true);
  });

  it('rejects rows with no overlap', () => {
    const r = makeRecipe('a', { topics: ['italian'] });
    expect(matchesTopicFilter(r, ['mexican'])).toBe(false);
  });

  it('the (untagged) sentinel matches rows with no topics column', () => {
    const untagged = makeRecipe('u', { topics: [] });
    const tagged = makeRecipe('t', { topics: ['italian'] });
    expect(matchesTopicFilter(untagged, [UNTAGGED_TOPIC_SENTINEL])).toBe(true);
    expect(matchesTopicFilter(tagged, [UNTAGGED_TOPIC_SENTINEL])).toBe(false);
  });

  it('the (untagged) sentinel combines with real topics via OR', () => {
    // Selecting "(untagged) + italian" should show both empty-tags
    // recipes AND italian recipes.
    const untagged = makeRecipe('u', { topics: [] });
    const italian = makeRecipe('i', { topics: ['italian'] });
    const mexican = makeRecipe('m', { topics: ['mexican'] });
    const sel = [UNTAGGED_TOPIC_SENTINEL, 'italian'];
    expect(matchesTopicFilter(untagged, sel)).toBe(true);
    expect(matchesTopicFilter(italian, sel)).toBe(true);
    expect(matchesTopicFilter(mexican, sel)).toBe(false);
  });
});

describe('computeListView', () => {
  function args(over: Partial<Parameters<typeof computeListView>[0]> = {}) {
    return {
      searching: false,
      searchBusy: false,
      searchError: null,
      storeLoading: false,
      storeCount: 0,
      visibleCount: 0,
      ...over,
    };
  }

  it('returns scanner-search during a search with a request in flight', () => {
    expect(
      computeListView(args({ searching: true, searchBusy: true }))
    ).toEqual({ kind: 'scanner-search' });
  });

  it('returns error during a search when a failure landed', () => {
    expect(
      computeListView(
        args({ searching: true, searchError: 'rate limited' })
      )
    ).toEqual({ kind: 'error', message: 'rate limited' });
  });

  it('busy outranks error - the in-flight request is the freshest signal', () => {
    // If a prior request errored but a new one is already in
    // flight, surface the scanner rather than a stale error.
    expect(
      computeListView(
        args({ searching: true, searchBusy: true, searchError: 'stale' })
      )
    ).toEqual({ kind: 'scanner-search' });
  });

  it('returns scanner-loading during a cold start with no recipes yet', () => {
    expect(
      computeListView(args({ storeLoading: true, storeCount: 0 }))
    ).toEqual({ kind: 'scanner-loading' });
  });

  it('does not show the loading scanner when the store has cached recipes', () => {
    // A background refresh on an already-populated store should
    // not hide the existing rows.
    expect(
      computeListView(
        args({ storeLoading: true, storeCount: 3, visibleCount: 3 })
      )
    ).toEqual({ kind: 'list' });
  });

  it('returns empty with no-matches when a search returns nothing', () => {
    expect(
      computeListView(
        args({ searching: true, visibleCount: 0 })
      )
    ).toEqual({ kind: 'empty', reason: 'no-matches' });
  });

  it('returns empty with no-recipes-yet when the cold-start store is empty', () => {
    expect(computeListView(args({ visibleCount: 0, storeCount: 0 }))).toEqual({
      kind: 'empty',
      reason: 'no-recipes-yet',
    });
  });

  it('returns list when there are recipes to show', () => {
    expect(
      computeListView(args({ visibleCount: 5, storeCount: 5 }))
    ).toEqual({ kind: 'list' });
  });
});
