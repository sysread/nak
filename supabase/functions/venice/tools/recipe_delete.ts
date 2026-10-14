// recipe_delete (function-side port)
//
// Hard-delete a recipe by id. Wire schema lives in
// src/lib/tools/recipe_delete.schema.ts. Returns {deleted: true} on
// success; {deleted: false, reason} when nothing matched (already
// deleted, never existed, or not owned).
//
// No RPC needed - just a DELETE with explicit user_id filter. The
// CASCADE on recipes.id takes care of recipe_versions /
// recipe_version_images / recipe_records / topic links.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

export const recipeDelete: ToolDef = {
  name: 'recipe_delete',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');

    // RLS OFF: filter by userId. .select('id') makes a zero-row match
    // detectable so the result can distinguish "deleted" from
    // "nothing matched" (see memory_delete.ts for the same change).
    const { data, error } = await ctx.adminClient
      .from('recipes')
      .delete()
      .eq('id', id)
      .eq('user_id', ctx.userId)
      .select('id');
    if (error) throw new Error(`deleteRecipe failed: ${error.message}`);
    const deleted = Array.isArray(data) && data.length > 0;
    if (!deleted) {
      return {
        deleted: false,
        reason: 'No recipe with that id - already deleted, never existed, or not yours.',
      };
    }

    return { deleted: true };
  },
};

registerTool(recipeDelete);
