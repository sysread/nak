// recipe_get (function-side port)
//
// Fetch one recipe's full Cooklang source plus current photo metadata
// (ids + positions + labels - no image bytes). Returns {found: false}
// for unknown or non-owned ids. Wire schema lives in
// src/lib/tools/recipe_get.schema.ts.
//
// Auth: b-strict. recipes.user_id direct ownership filter.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { readRecipePhotoMeta } from './_recipe_helpers.ts';

export const recipeGet: ToolDef = {
  name: 'recipe_get',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');

    // RLS OFF: filter by userId. user_id eq + id eq matches browser
    // RLS behavior; miss-vs-not-owned reads the same to a probe.
    const { data: recipe, error: recipeErr } = await ctx.adminClient
      .from('recipes')
      .select(
        'id, title, source, source_url, cooklang, rating, upcoming, favorite, topics, created_at, updated_at',
      )
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .maybeSingle();
    if (recipeErr) throw new Error(`getRecipe failed: ${recipeErr.message}`);
    if (!recipe) return { found: false };

    // Newest recipe_version row carries the current photo set; the
    // shared helper owns that join (recipe_update reads it back the
    // same way). Ownership was validated by the select above.
    const photos = await readRecipePhotoMeta(ctx.adminClient, id);

    return {
      found: true,
      recipe: {
        ...recipe,
        photos,
      },
    };
  },
};

registerTool(recipeGet);
