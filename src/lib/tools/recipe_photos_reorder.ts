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

export const recipePhotosReorder: ToolDef = {
  name: 'recipe_photos_reorder',
  description:
    "Set a recipe's photo display order. `photo_ids` is the new " +
    'ordering and MUST be exactly the recipe\'s current photo set ' +
    "(every id present, no missing ones, no extras, no duplicates). " +
    'Call `recipe_get` first to read the current `photos` array, ' +
    'then pass the same ids back in the desired order. To add or ' +
    'remove photos, use `recipe_photos_attach` or ' +
    '`recipe_photos_remove` - this tool only reorders. ' +
    '`change_message` is REQUIRED and lands in the recipe history. ' +
    'Returns {recipe_id, photos: [{id, position}, ...]} - the new ' +
    'ordering with positions renumbered from 0.',
  shortDescription: 'reorder a recipe’s photos',
  parameters: {
    type: 'object',
    properties: {
      recipe_id: {
        type: 'string',
        description: 'UUID of the recipe whose photos to reorder.',
      },
      photo_ids: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
        description:
          'New ordering. Must be a permutation of the recipe\'s ' +
          'current photo ids: every existing id present, no extras, ' +
          'no duplicates.',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          'One-line note describing the reorder and why. Stored in ' +
          "the recipe's version history. Examples: \"Moved the " +
          'finished plate first", "Grouped the prep shots before ' +
          'the served photo".',
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
    const photos = await ctx.supabase.reorderRecipePhotos(
      recipeId,
      photoIds,
      changeMessage
    );
    notifyCookbookChanged();
    return { recipe_id: recipeId, photos };
  },
};
