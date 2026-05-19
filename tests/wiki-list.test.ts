/**
 * Unit coverage for the wiki-list UI primitives. Pure functions
 * - no runes, no DOM - tested via plain vitest. The companion
 * `src/components/WikiList.svelte` composes these with its own
 * debounced `$effect` and the markup.
 */
import { describe, it, expect } from 'vitest';
import type { WikiArticle } from '../src/lib/supabase';
import {
  SEARCH_DEBOUNCE_MS,
  emptyMessage,
  pickSortedArticles,
  scannerLabel,
} from '../src/lib/ui/wiki-list';

function makeArticle(
  id: string,
  title: string,
  overrides: Partial<WikiArticle> = {}
): WikiArticle {
  return {
    id,
    title,
    content: '',
    user_id: 'u1',
    created_at: '2026-05-19T12:00:00Z',
    updated_at: '2026-05-19T12:00:00Z',
    ...overrides,
  } as WikiArticle;
}

describe('SEARCH_DEBOUNCE_MS', () => {
  it('matches the cross-drawer 200ms convention', () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(200);
  });
});

describe('pickSortedArticles', () => {
  it('sorts alphabetically by title (case-insensitive) on empty query', () => {
    // The wiki is meant to be browsed by topic, not by edit
    // time - the alphabetic sort is the contract that
    // distinguishes this listing from the recency-biased
    // conversation drawer.
    const a = makeArticle('a', 'Espresso');
    const b = makeArticle('b', 'apple pie');
    const c = makeArticle('c', 'Banana bread');
    const out = pickSortedArticles({ articles: [a, b, c], query: '' });
    expect(out.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('treats whitespace-only queries as the empty case', () => {
    const a = makeArticle('a', 'Zebra');
    const b = makeArticle('b', 'Apple');
    const out = pickSortedArticles({ articles: [a, b], query: '   ' });
    expect(out.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('passes server order through verbatim during an active search', () => {
    // The semantic-search RPC returns hits in ascending cosine
    // distance; the primitive must not re-sort that ordering
    // alphabetically just because some titles compare lower.
    const top = makeArticle('top', 'Zucchini');
    const mid = makeArticle('mid', 'Apricot');
    const bot = makeArticle('bot', 'Banana');
    const out = pickSortedArticles({
      articles: [top, mid, bot],
      query: 'green vegetables',
    });
    expect(out.map((x) => x.id)).toEqual(['top', 'mid', 'bot']);
  });

  it('does not mutate the input array', () => {
    const a = makeArticle('a', 'Zebra');
    const b = makeArticle('b', 'Apple');
    const input = [a, b];
    pickSortedArticles({ articles: input, query: '' });
    expect(input.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('returns an empty array for an empty input', () => {
    expect(pickSortedArticles({ articles: [], query: '' })).toEqual([]);
    expect(pickSortedArticles({ articles: [], query: 'x' })).toEqual([]);
  });
});

describe('scannerLabel', () => {
  it('says "Searching wiki" for an active query', () => {
    expect(scannerLabel('apple')).toBe('Searching wiki');
  });

  it('says "Loading wiki" for the empty-query refresh', () => {
    expect(scannerLabel('')).toBe('Loading wiki');
  });

  it('treats whitespace-only queries as the empty case', () => {
    expect(scannerLabel('   ')).toBe('Loading wiki');
  });
});

describe('emptyMessage', () => {
  it('says "no matches" when a search returned nothing', () => {
    expect(emptyMessage('apple')).toBe('No matches.');
  });

  it('says "no wiki articles yet" with the explainer when the query is empty', () => {
    expect(emptyMessage('')).toBe(
      'No wiki articles yet. The background agent writes them as you chat, or you can add your own.'
    );
  });
});
