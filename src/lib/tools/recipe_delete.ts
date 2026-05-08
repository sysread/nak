/**
 * Hard-delete a recipe by id. Returns `{deleted: true}` on success. RLS
 * on the recipes table means this silently no-ops for ids that belong
 * to another user — the LLM can't probe for existence that way.
 *
 * Cookbook deletes are user-directed and unambiguous ("forget the
 * carbonara recipe I saved last week"), so no soft-delete equivalent.
 * Same reasoning as `memory_delete` vs `memory_invalidate`.
 */
import type { ToolDef } from './types';
// See recipe_save.ts — plain-.ts import, not the rune-using store.
import { notifyCookbookChanged } from '../cookbook-events';
import { recipeDeleteSchema } from './recipe_delete.schema';

export const recipeDelete: ToolDef = {
  ...recipeDeleteSchema,
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');
    await ctx.supabase.deleteRecipe(id);
    notifyCookbookChanged();
    return { deleted: true };
  },
};
