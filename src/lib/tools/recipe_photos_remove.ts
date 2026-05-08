/**
 * Remove specific photos from a recipe by id. The id list must
 * reference photos currently linked to the recipe (i.e. photos that
 * appear in `recipe_get`'s `photos` array). Unknown ids fail loudly
 * server-side, naming the offenders, so the LLM can re-issue the
 * call against fresh state rather than guessing.
 *
 * Use `recipe_get` to discover photo ids before calling this tool -
 * the `photos: [{id, position}, ...]` field on the recipe is the
 * source of those ids.
 */
import type { ToolDef } from './types';
// See recipe_save.ts - plain-.ts import, not the rune-using store.
import { notifyCookbookChanged } from '../cookbook-events';
import { recipePhotosRemoveSchema } from './recipe_photos_remove.schema';

export const recipePhotosRemove: ToolDef = {
  ...recipePhotosRemoveSchema,
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
    const photos = await ctx.supabase.removeRecipePhotos(
      recipeId,
      photoIds,
      changeMessage
    );
    notifyCookbookChanged();
    return { recipe_id: recipeId, photos };
  },
};
