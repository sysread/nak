/**
 * Set the display order of a recipe's photos. The `photo_ids` array
 * MUST be a permutation of the recipe's current photo set: every
 * existing id present, no extras, no duplicates. The schema enforces
 * this server-side - we don't try to merge a partial reorder with the
 * existing set, because "what does an absent id mean?" has no
 * defensible default and the LLM would hallucinate one.
 *
 * Use `recipe_get` to discover the current photo set before calling.
 */
import type { ToolDef } from './types';
// See recipe_save.ts - plain-.ts import, not the rune-using store.
import { notifyCookbookChanged } from '../cookbook-events';
import { recipePhotosReorderSchema } from './recipe_photos_reorder.schema';

export const recipePhotosReorder: ToolDef = {
  ...recipePhotosReorderSchema,
  async execute(args, ctx) {
    const recipeId = typeof args.recipe_id === 'string' ? args.recipe_id : '';
    if (!recipeId) throw new Error('recipe_id is required');
    const photoIds = Array.isArray(args.photo_ids)
      ? args.photo_ids.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : [];
    if (photoIds.length === 0) {
      throw new Error('photo_ids must contain at least one entry');
    }
    const changeMessage =
      typeof args.change_message === 'string' ? args.change_message.trim() : '';
    if (!changeMessage) {
      throw new Error('change_message is required');
    }
    const photos = await ctx.supabase.reorderRecipePhotos(
      recipeId,
      photoIds,
      changeMessage
    );
    notifyCookbookChanged();
    return { recipe_id: recipeId, photos };
  },
};
