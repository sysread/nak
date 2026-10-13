/**
 * Unit coverage for the pure recipe-export Markdown/ZIP builders. The
 * download wrappers (DOM + object URLs) are browser-only and not tested
 * here; these cover the string/byte assembly the wrappers hand off.
 * Mirrors tests/wiki-export.test.ts; the recipe record's front matter
 * additionally carries the outcome line (the one column the wiki twin
 * lacks).
 */
import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import type { Recipe, RecipeRecord } from '../src/lib/supabase';
import {
  buildRecipeMarkdown,
  buildRecipeRecordMarkdown,
  buildRecipeRecordZip,
  recipeSlug,
} from '../src/lib/recipe-records-export';

function makeRecord(over: Partial<RecipeRecord> = {}): RecipeRecord {
  return {
    id: 'rec-1234abcd-0000-0000-0000-000000000000',
    user_id: 'user-1',
    recipe_id: 'r1',
    date: '2026-10-04',
    content: 'Baked a loaf',
    tags: [],
    outcome: null,
    source_conversation_id: null,
    created_at: '2026-10-04T00:00:00Z',
    updated_at: '2026-10-04T00:00:00Z',
    ...over,
  };
}

function makeRecipe(over: Partial<Recipe> = {}): Recipe {
  return {
    id: 'r1',
    title: 'Sourdough',
    source: null,
    source_url: null,
    cooklang: 'Bake the @loaf{}.',
    rating: null,
    upcoming: false,
    favorite: false,
    topics: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-10-04T00:00:00Z',
    ...over,
  };
}

describe('buildRecipeRecordMarkdown', () => {
  it('prepends date + tags + outcome front matter', () => {
    const md = buildRecipeRecordMarkdown(
      makeRecord({ tags: ['rye', 'hydration'], outcome: 'failure' })
    );
    expect(md).toContain('date: 2026-10-04');
    expect(md).toContain('tags: [rye, hydration]');
    expect(md).toContain('outcome: failure');
    expect(md).toContain('Baked a loaf');
  });

  it('omits the tags / outcome lines when unset (unclassified)', () => {
    const md = buildRecipeRecordMarkdown(makeRecord({ tags: [], outcome: null }));
    expect(md).not.toContain('tags:');
    expect(md).not.toContain('outcome:');
    expect(md).toContain('date: 2026-10-04');
  });
});

describe('buildRecipeMarkdown', () => {
  it('renders the recipe with an H1 title', () => {
    expect(buildRecipeMarkdown(makeRecipe())).toMatch(/^# Sourdough/);
  });

  it('carries the source line when set', () => {
    const md = buildRecipeMarkdown(makeRecipe({ source: 'NYT', source_url: 'https://x' }));
    expect(md).toContain('Source: [NYT](https://x)');
  });
});

describe('recipeSlug', () => {
  it('slugs the title, falling back to the id tail', () => {
    expect(recipeSlug(makeRecipe({ title: 'Sourdough Project!' }))).toBe('sourdough-project');
    // A title that slugs to empty falls back to the id tail so the
    // zip name is never bare.
    expect(recipeSlug(makeRecipe({ title: '???' }))).toBe('r1');
  });
});

describe('buildRecipeRecordZip', () => {
  it('packs recipe.md plus one file per record under records/', () => {
    const zip = buildRecipeRecordZip(makeRecipe(), [
      makeRecord({ id: 'a', date: '2026-10-04', content: 'First bake' }),
      makeRecord({ id: 'b', date: '2026-10-05', content: 'Second bake' }),
    ]);
    const entries = unzipSync(zip);
    const names = Object.keys(entries).sort();
    expect(names).toContain('recipe.md');
    expect(names.filter((n) => n.startsWith('records/')).length).toBe(2);
    expect(strFromU8(entries['recipe.md'])).toContain('Sourdough');
  });

  it('disambiguates colliding record filenames so none are dropped', () => {
    // Same date + identical-slugging content would collide on one name;
    // the dedup appends a numeric suffix starting at -2.
    const zip = buildRecipeRecordZip(makeRecipe(), [
      makeRecord({ id: 'a', date: '2026-10-04', content: 'Bake' }),
      makeRecord({ id: 'b', date: '2026-10-04', content: 'Bake' }),
    ]);
    const recordFiles = Object.keys(unzipSync(zip)).filter((n) => n.startsWith('records/'));
    expect(recordFiles.length).toBe(2);
    expect(new Set(recordFiles).size).toBe(2);
    expect(recordFiles.some((n) => n.includes('-2.md'))).toBe(true);
  });
});
