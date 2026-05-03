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

export const recipePhotosRemove: ToolDef = {
  name: 'recipe_photos_remove',
  description:
    'Remove one or more photos from a recipe by photo id (the `id` ' +
    'field on each entry of the recipe\'s `photos` array - call ' +
    '`recipe_get` first to find them). Every id must currently be ' +
    'on the recipe; an unknown id fails the whole call rather than ' +
    'silently skipping. `change_message` is REQUIRED and lands in ' +
    'the recipe history. Returns {recipe_id, photos: [{id, ' +
    'position, label}, ...]} - the post-removal full ordered set, ' +
    'with the surviving photos\' captions preserved.',
  shortDescription: "remove photos from a recipe by id",
  parameters: {
    type: 'object',
    properties: {
      recipe_id: {
        type: 'string',
        description: 'UUID of the recipe to remove photos from.',
      },
      photo_ids: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
        description:
          'Photo ids to remove. Each id must currently be on the ' +
          'recipe (use recipe_get to find them).',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          "One-line note describing what's being removed and why. " +
          "Stored in the recipe's version history. Examples: " +
          '"Removed the blurry first attempt", "Dropped the ' +
          'redundant overhead shot".',
      },
    },
    required: ['recipe_id', 'photo_ids', 'change_message'],
    additionalProperties: false,
  },
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
