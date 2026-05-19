/**
 * Unit coverage for the memory-list UI primitives. Pure
 * functions - no runes, no DOM - tested via plain vitest.
 *
 * The companion `src/components/MemoryList.svelte` is the only
 * caller that wires these into Svelte reactivity (the debounced
 * `$effect` that re-runs `runMemoriesSearch`, the `onMount`
 * topic-vocabulary prime, the topic-filter mount). Topic
 * filtering itself runs server-side via the supabase
 * topics-filter clause, so unlike the recipe primitives this
 * module carries no client-side topic predicate.
 */
import { describe, it, expect } from 'vitest';
import {
  SEARCH_DEBOUNCE_MS,
  emptyMessage,
} from '../src/lib/ui/memories-list';

describe('SEARCH_DEBOUNCE_MS', () => {
  it('matches the cross-drawer 200ms convention', () => {
    // Pinned so a fork that changes one of the drawer-tab
    // debounces surfaces here - we want typing-burst latency
    // to read uniformly across the chats / memories / recipes
    // / wiki tabs.
    expect(SEARCH_DEBOUNCE_MS).toBe(200);
  });
});

describe('emptyMessage', () => {
  it('says "no matches" when a search returned nothing', () => {
    expect(emptyMessage('dishwasher')).toBe('No matches.');
  });

  it('says "no memories yet" with the explainer when the query is empty', () => {
    expect(emptyMessage('')).toBe(
      'No memories yet. They accumulate as you chat.'
    );
  });

  it('treats whitespace-only queries as the empty case', () => {
    // A stray space from a previous search should not flip the
    // empty-state to "No matches." - the search predicate's trim
    // means there's no actual filter active.
    expect(emptyMessage('   ')).toBe(
      'No memories yet. They accumulate as you chat.'
    );
  });
});
