/**
 * Unit coverage for the wiki-list UI primitives. Pure functions
 * - no runes, no DOM - tested via plain vitest. The companion
 * `src/components/WikiList.svelte` composes these with its own
 * debounced `$effect` and the markup.
 */
import { describe, it, expect } from 'vitest';
import {
  SEARCH_DEBOUNCE_MS,
  emptyMessage,
  scannerLabel,
} from '../src/lib/ui/wiki-list';

describe('SEARCH_DEBOUNCE_MS', () => {
  it('matches the cross-drawer 200ms convention', () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(200);
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
