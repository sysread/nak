/**
 * Set or clear captions on photos that are already linked to a
 * recipe. Pass an array of `{photo_id, label}` pairs - each pair
 * sets that photo's caption to the given string, or clears it when
 * the label is null or empty. Photos not named in the call keep
 * whatever caption they had before.
 *
 * Use `recipe_get` first to discover photo ids; the returned
 * `photos` array carries `{id, position, label}` entries the model
 * can echo back into a follow-up call.
 *
 * Why a separate tool from attach/reorder/remove: each verb is
 * single-purpose so the failure mode is closed. attach can't
 * silently overwrite captions on existing photos; reorder can't
 * silently strip them; remove can't silently retitle survivors.
 * Captions are their own edit, so they get their own verb.
 */
import type { ToolDef } from './types';
// See recipe_save.ts - plain-.ts import, not the rune-using store.
import { notifyCookbookChanged } from '../cookbook-events';

const MAX_LABEL_CHARS = 200;

export const recipePhotoLabelSet: ToolDef = {
  name: 'recipe_photo_label_set',
  description:
    "Set or clear captions on a recipe's existing photos. `labels` " +
    'is an array of {photo_id, label} pairs; each pair sets that ' +
    'photo\'s caption to the given string, or clears it when label ' +
    'is null or empty. Every photo_id must currently be on the ' +
    'recipe (call `recipe_get` first to discover ids and current ' +
    'captions). Photos not named keep their existing captions. ' +
    'Captions render below the thumbnail and beside the lightbox ' +
    'image; max 200 chars. To add or remove photos, use ' +
    '`recipe_photos_attach` or `recipe_photos_remove`. ' +
    '`change_message` is REQUIRED and lands in the recipe history. ' +
    'Returns {recipe_id, photos: [{id, position, label}, ...]} - ' +
    "the recipe's full ordered photo set with the new captions.",
  shortDescription: 'set or clear photo captions on a recipe',
  parameters: {
    type: 'object',
    properties: {
      recipe_id: {
        type: 'string',
        description:
          'UUID of the recipe whose photo captions to set or clear.',
      },
      labels: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            photo_id: {
              type: 'string',
              minLength: 1,
              description:
                "Photo id to retitle. Must currently be on the " +
                'recipe (use recipe_get to find ids).',
            },
            label: {
              type: ['string', 'null'],
              maxLength: MAX_LABEL_CHARS,
              description:
                'New caption, or null/empty string to clear the ' +
                'caption back to "no label". Max 200 chars.',
            },
          },
          required: ['photo_id'],
          additionalProperties: false,
        },
        description:
          '{photo_id, label} pairs. Each photo_id must currently be ' +
          "linked to the recipe. Photos not named keep their " +
          'existing captions.',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          "One-line note describing what's being captioned and why. " +
          "Stored in the recipe's version history. Examples: " +
          '"Captioned the finished plate", "Cleared the obsolete ' +
          'progress-shot caption".',
      },
    },
    required: ['recipe_id', 'labels', 'change_message'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const recipeId = typeof args.recipe_id === 'string' ? args.recipe_id : '';
    if (!recipeId) throw new Error('recipe_id is required');
    const rawLabels = Array.isArray(args.labels) ? args.labels : [];
    if (rawLabels.length === 0) {
      throw new Error('labels must contain at least one entry');
    }
    const photos: Array<{ id: string; label: string | null }> = [];
    for (const entry of rawLabels) {
      if (!entry || typeof entry !== 'object') {
        throw new Error('labels entries must be {photo_id, label} objects');
      }
      const e = entry as { photo_id?: unknown; label?: unknown };
      if (typeof e.photo_id !== 'string' || e.photo_id.length === 0) {
        throw new Error('photo_id is required on every labels entry');
      }
      let label: string | null = null;
      if (e.label !== undefined && e.label !== null) {
        if (typeof e.label !== 'string') {
          throw new Error('label must be a string or null');
        }
        if (e.label.length > MAX_LABEL_CHARS) {
          throw new Error(
            `label exceeds ${MAX_LABEL_CHARS}-char limit (got ${e.label.length})`
          );
        }
        label = e.label;
      }
      photos.push({ id: e.photo_id, label });
    }
    const changeMessage =
      typeof args.change_message === 'string' ? args.change_message.trim() : '';
    if (!changeMessage) {
      throw new Error('change_message is required');
    }
    const updated = await ctx.supabase.setRecipePhotoLabels(
      recipeId,
      photos,
      changeMessage
    );
    notifyCookbookChanged();
    return { recipe_id: recipeId, photos: updated };
  },
};
