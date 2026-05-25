/**
 * Unit coverage for the cookbook detail-pane UI primitives. Pure
 * functions - no runes, no DOM - tested via plain vitest. The
 * companion `src/screens/Cookbook.svelte` wires these into its
 * detail-header markup.
 */
import { describe, it, expect } from 'vitest';
import type { Recipe } from '../src/lib/supabase';
import { recipeSourceLine } from '../src/lib/ui/recipe-detail';

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'r1',
    title: 'Recipe',
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

describe('recipeSourceLine', () => {
  it('omits the line when neither name nor url is present', () => {
    expect(recipeSourceLine(makeRecipe())).toEqual({ kind: 'none' });
  });

  it('renders plain text when only a source name is present', () => {
    expect(recipeSourceLine(makeRecipe({ source: 'Grandma' }))).toEqual({
      kind: 'text',
      text: 'Grandma',
    });
  });

  it('labels the link with the source name when both are present', () => {
    expect(
      recipeSourceLine(
        makeRecipe({ source: 'NYT Cooking', source_url: 'https://x.test/r' })
      )
    ).toEqual({ kind: 'link', label: 'NYT Cooking', url: 'https://x.test/r' });
  });

  it('falls back to "Source" when a url has no accompanying name', () => {
    expect(
      recipeSourceLine(makeRecipe({ source_url: 'https://x.test/r' }))
    ).toEqual({ kind: 'link', label: 'Source', url: 'https://x.test/r' });
  });

  it('treats a whitespace-only name as absent so the label is never blank', () => {
    expect(
      recipeSourceLine(makeRecipe({ source: '   ', source_url: 'https://x.test/r' }))
    ).toEqual({ kind: 'link', label: 'Source', url: 'https://x.test/r' });
  });

  it('trims surrounding whitespace off the url and label', () => {
    expect(
      recipeSourceLine(
        makeRecipe({ source: '  Bon Appetit  ', source_url: '  https://x.test/r  ' })
      )
    ).toEqual({ kind: 'link', label: 'Bon Appetit', url: 'https://x.test/r' });
  });
});
