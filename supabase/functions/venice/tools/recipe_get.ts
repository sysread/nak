// recipe_get (function-side port)
//
// Fetch one recipe's full Cooklang source plus current photo metadata
// (ids + positions + labels - no image bytes). Returns {found: false}
// for unknown or non-owned ids. Wire schema lives in
// src/lib/tools/recipe_get.schema.ts.
//
// Auth: b-strict. recipes.user_id direct ownership filter.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

interface RecipePhotoMeta {
  id: string;
  position: number;
  label: string | null;
}

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

    // Newest recipe_version row carries the current photo set. The
    // browser-side wrapper joins recipe_version_images in one round;
    // mirror the join here. RLS-OFF rationale: recipe ownership was
    // already validated above, and recipe_versions inherits ownership
    // through recipe_id, so an unscoped lookup by recipe_id is safe.
    const { data: versionRow, error: versionErr } = await ctx.adminClient
      .from('recipe_versions')
      .select('id, recipe_version_images(position, image_id, label)')
      .eq('recipe_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (versionErr) throw new Error(`listRecipePhotoMeta failed: ${versionErr.message}`);

    let photos: RecipePhotoMeta[] = [];
    if (versionRow) {
      type LinkRow = { position: number; image_id: string; label: string | null };
      const links = (versionRow as { recipe_version_images?: LinkRow[] | null })
        .recipe_version_images;
      if (Array.isArray(links)) {
        photos = links
          .map((l) => ({
            id: l.image_id,
            position: l.position,
            label: l.label ?? null,
          }))
          .sort((a, b) => a.position - b.position);
      }
    }

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
