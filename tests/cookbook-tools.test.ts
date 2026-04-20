/**
 * Unit coverage for the five recipe_* tools. Focuses on:
 *
 *   - registration in the main chat TOOLS list (gated, not always-on);
 *   - the validation edges that the JSON Schema alone wouldn't catch
 *     (oversize cooklang, blank title, missing id);
 *   - the tool → Supabase call shape (right method, right args).
 *
 * The Supabase layer is stubbed with a minimal object — RLS is a
 * Supabase concern, not the tool's, and we already trust the
 * integration shape from the memory tools.
 */
import { describe, it, expect, vi } from 'vitest';
import { TOOLS, type ToolContext } from '../src/lib/tools';
import { recipeSave } from '../src/lib/tools/recipe_save';
import { recipeList } from '../src/lib/tools/recipe_list';
import { recipeGet } from '../src/lib/tools/recipe_get';
import { recipeUpdate } from '../src/lib/tools/recipe_update';
import { recipeDelete } from '../src/lib/tools/recipe_delete';
import type { SupabaseService, Recipe } from '../src/lib/supabase';
import type { VeniceClient } from '../src/lib/venice';
import { MAX_RECIPE_COOKLANG_CHARS } from '../src/lib/cooklang';

function sampleRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'r-1',
    title: 'Test Recipe',
    source: null,
    source_url: null,
    cooklang: 'Stir @flour{200%g} into a bowl.',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function ctxFor(svc: Partial<SupabaseService>): ToolContext {
  return {
    supabase: svc as SupabaseService,
    venice: {} as VeniceClient,
    userId: 'u-1',
    threadId: 't-1',
    signal: new AbortController().signal,
  };
}

describe('recipe tools — registry', () => {
  it('all five recipe tools are in the main TOOLS list', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain('recipe_save');
    expect(names).toContain('recipe_list');
    expect(names).toContain('recipe_get');
    expect(names).toContain('recipe_update');
    expect(names).toContain('recipe_delete');
  });
});

describe('recipe_save', () => {
  it('calls createRecipe with trimmed title and source fields', async () => {
    const createRecipe = vi.fn().mockResolvedValue(sampleRecipe());
    const result = await recipeSave.execute(
      {
        title: '  Test Recipe  ',
        cooklang: 'Stir @flour{200%g}.',
        source: '  NYT  ',
        source_url: ' https://example.com ',
      },
      ctxFor({ createRecipe } as unknown as Partial<SupabaseService>)
    );
    expect(createRecipe).toHaveBeenCalledWith(
      'Test Recipe',
      'Stir @flour{200%g}.',
      'NYT',
      'https://example.com'
    );
    expect(result).toEqual({
      id: 'r-1',
      title: 'Test Recipe',
      updated_at: '2024-01-01T00:00:00Z',
    });
  });

  it('passes null source / source_url when omitted', async () => {
    const createRecipe = vi.fn().mockResolvedValue(sampleRecipe());
    await recipeSave.execute(
      { title: 'T', cooklang: 'X' },
      ctxFor({ createRecipe } as unknown as Partial<SupabaseService>)
    );
    expect(createRecipe).toHaveBeenCalledWith('T', 'X', null, null);
  });

  it('rejects blank title', async () => {
    await expect(
      recipeSave.execute(
        { title: '   ', cooklang: 'X' },
        ctxFor({ createRecipe: vi.fn() } as unknown as Partial<SupabaseService>)
      )
    ).rejects.toThrow(/title is required/);
  });

  it('rejects oversize cooklang', async () => {
    const createRecipe = vi.fn();
    const oversize = 'x'.repeat(MAX_RECIPE_COOKLANG_CHARS + 1);
    await expect(
      recipeSave.execute(
        { title: 'T', cooklang: oversize },
        ctxFor({ createRecipe } as unknown as Partial<SupabaseService>)
      )
    ).rejects.toThrow(/exceeds/);
    expect(createRecipe).not.toHaveBeenCalled();
  });
});

describe('recipe_list', () => {
  it('returns a slim projection without the cooklang blob', async () => {
    const listRecipes = vi
      .fn()
      .mockResolvedValue([sampleRecipe({ id: 'r-1' }), sampleRecipe({ id: 'r-2' })]);
    const out = (await recipeList.execute(
      { query: '' },
      ctxFor({ listRecipes } as unknown as Partial<SupabaseService>)
    )) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(2);
    for (const row of out) {
      expect(row).not.toHaveProperty('cooklang');
      expect(row).toHaveProperty('id');
      expect(row).toHaveProperty('title');
    }
  });

  it('passes through the query filter and clamps limit', async () => {
    const listRecipes = vi.fn().mockResolvedValue([]);
    await recipeList.execute(
      { query: 'pasta', limit: 9999 },
      ctxFor({ listRecipes } as unknown as Partial<SupabaseService>)
    );
    // 9999 is above MAX_LIMIT (200) and should be clamped.
    const [q, limit] = listRecipes.mock.calls[0]!;
    expect(q).toBe('pasta');
    expect(limit).toBeLessThanOrEqual(200);
  });
});

describe('recipe_get', () => {
  it('returns {found: true, recipe} on hit', async () => {
    const getRecipe = vi.fn().mockResolvedValue(sampleRecipe());
    const out = await recipeGet.execute(
      { id: 'r-1' },
      ctxFor({ getRecipe } as unknown as Partial<SupabaseService>)
    );
    expect(out).toEqual({ found: true, recipe: sampleRecipe() });
  });

  it('returns {found: false} when the id is unknown', async () => {
    const getRecipe = vi.fn().mockResolvedValue(null);
    const out = await recipeGet.execute(
      { id: 'r-nope' },
      ctxFor({ getRecipe } as unknown as Partial<SupabaseService>)
    );
    expect(out).toEqual({ found: false });
  });
});

describe('recipe_update', () => {
  it('calls updateRecipe with only the fields present in the patch', async () => {
    const updateRecipe = vi.fn().mockResolvedValue(sampleRecipe());
    await recipeUpdate.execute(
      { id: 'r-1', title: 'New' },
      ctxFor({ updateRecipe } as unknown as Partial<SupabaseService>)
    );
    const [id, patch] = updateRecipe.mock.calls[0]!;
    expect(id).toBe('r-1');
    expect(patch).toEqual({ title: 'New' });
  });

  it('passes explicit null for source to clear it', async () => {
    const updateRecipe = vi.fn().mockResolvedValue(sampleRecipe());
    await recipeUpdate.execute(
      { id: 'r-1', source: null },
      ctxFor({ updateRecipe } as unknown as Partial<SupabaseService>)
    );
    const [, patch] = updateRecipe.mock.calls[0]!;
    expect(patch).toEqual({ source: null });
  });

  it('rejects an empty patch', async () => {
    const updateRecipe = vi.fn();
    await expect(
      recipeUpdate.execute(
        { id: 'r-1' },
        ctxFor({ updateRecipe } as unknown as Partial<SupabaseService>)
      )
    ).rejects.toThrow(/at least one of/);
    expect(updateRecipe).not.toHaveBeenCalled();
  });

  it('rejects oversize cooklang on update', async () => {
    const updateRecipe = vi.fn();
    const oversize = 'x'.repeat(MAX_RECIPE_COOKLANG_CHARS + 1);
    await expect(
      recipeUpdate.execute(
        { id: 'r-1', cooklang: oversize },
        ctxFor({ updateRecipe } as unknown as Partial<SupabaseService>)
      )
    ).rejects.toThrow(/exceeds/);
    expect(updateRecipe).not.toHaveBeenCalled();
  });
});

describe('recipe_delete', () => {
  it('calls deleteRecipe and returns {deleted: true}', async () => {
    const deleteRecipe = vi.fn().mockResolvedValue(undefined);
    const out = await recipeDelete.execute(
      { id: 'r-1' },
      ctxFor({ deleteRecipe } as unknown as Partial<SupabaseService>)
    );
    expect(deleteRecipe).toHaveBeenCalledWith('r-1');
    expect(out).toEqual({ deleted: true });
  });

  it('rejects missing id', async () => {
    const deleteRecipe = vi.fn();
    await expect(
      recipeDelete.execute(
        {},
        ctxFor({ deleteRecipe } as unknown as Partial<SupabaseService>)
      )
    ).rejects.toThrow(/id is required/);
    expect(deleteRecipe).not.toHaveBeenCalled();
  });
});
