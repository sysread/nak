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

export const recipeDelete: ToolDef = {
  name: 'recipe_delete',
  description:
    'Delete a recipe by id. Use recipe_list first to find the id. Returns ' +
    '{deleted: true}.',
  shortDescription: 'remove a saved recipe',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the recipe to delete.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');
    await ctx.supabase.deleteRecipe(id);
    notifyCookbookChanged();
    return { deleted: true };
  },
};
