/**
 * Unit coverage for the recipe-list UI primitives. Pure functions
 * - no runes, no DOM, no reactive state - tested via plain vitest.
 *
 * The companion `src/components/RecipeList.svelte` is the only
 * caller that wires these into Svelte reactivity (the `query` rune,
 * the debounced `$effect` that orchestrates the embed-then-search
 * round trip, the AbortController that supersedes stale calls, and
 * the infinite-scroll sentinel that pages the browse list). A port
 * to another framework would re-use this module untouched.
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
    // Relevance ranking comes pre-sorted by the supabase RPC; the
    // primitive must preserve that order verbatim.
    const a = makeRecipe('a', { rating: 1 });
    const b = makeRecipe('b', { rating: 5 });
    const c = makeRecipe('c', { rating: 3 });
    const out = pickVisibleRecipes({
      searching: true,
      searchResults: [a, b, c],
      storeRecipes: [c, b, a],
      selectedTopics: [],
    });
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('narrows search results by the active topic filter, preserving relevance order', () => {
    // Search hits come back capped and unfiltered by topic (the
    // search RPC takes no topic argument), so the filter is applied
    // here client-side AFTER the server ranked them.
    const a = makeRecipe('a', { topics: ['italian'] });
    const b = makeRecipe('b', { topics: ['mexican'] });
    const c = makeRecipe('c', { topics: ['italian'] });
    const out = pickVisibleRecipes({
      searching: true,
      searchResults: [a, b, c],
      storeRecipes: [],
      selectedTopics: ['italian'],
    });
    expect(out.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('renders the browse page window verbatim (server already sorted + topic-filtered)', () => {
    // The store holds the paginated, server-ordered window; the
    // primitive must not re-sort or re-filter it - that would
    // disagree with the server's page boundaries mid-scroll.
    const a = makeRecipe('a', { topics: ['mexican'] });
    const b = makeRecipe('b', { topics: ['italian'] });
    const out = pickVisibleRecipes({
      searching: false,
      searchResults: [],
      storeRecipes: [a, b],
      // A non-empty selection must NOT re-filter the browse window -
      // the server already applied it before slicing the page.
      selectedTopics: ['italian'],
    });
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('does not mutate the input store array', () => {
    const a = makeRecipe('a');
    const b = makeRecipe('b');
    const store = [a, b];
    const out = pickVisibleRecipes({
      searching: false,
      searchResults: [],
      storeRecipes: store,
      selectedTopics: [],
    });
    out.reverse();
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

  it('stays a list when the All-list is empty but buckets carry rows (offline regime)', () => {
    // Offline the paginated "All recipes" list is empty (visibleCount
    // 0), but the cached Upcoming / Favorites buckets are the saved set
    // - the listing must render, not collapse to the empty state.
    expect(
      computeListView(args({ visibleCount: 0, storeCount: 0, bucketCount: 4 }))
    ).toEqual({ kind: 'list' });
  });

  it('still reports empty when both the list and the buckets are empty', () => {
    expect(
      computeListView(args({ visibleCount: 0, storeCount: 0, bucketCount: 0 }))
    ).toEqual({ kind: 'empty', reason: 'no-recipes-yet' });
  });
});
