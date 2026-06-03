// recipe_delete (function-side port)
//
// Hard-delete a recipe by id. Wire schema lives in
// src/lib/tools/recipe_delete.schema.ts.
//
// No RPC needed - just a DELETE with explicit user_id filter. The
// CASCADE on recipes.id takes care of recipe_versions /
// recipe_version_images / topic links.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

export const recipeDelete: ToolDef = {
  name: 'recipe_delete',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');

    // RLS OFF: filter by userId. Silent no-op on a non-owned id -
    // matches RLS behavior on the browser path.
    const { error } = await ctx.adminClient
      .from('recipes')
      .delete()
      .eq('id', id)
      .eq('user_id', ctx.userId);
    if (error) throw new Error(`deleteRecipe failed: ${error.message}`);

    return { deleted: true };
  },
};

registerTool(recipeDelete);
