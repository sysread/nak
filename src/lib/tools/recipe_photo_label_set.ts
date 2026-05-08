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
import {
  recipePhotoLabelSetSchema,
  RECIPE_PHOTO_LABEL_MAX_CHARS,
} from './recipe_photo_label_set.schema';

export const recipePhotoLabelSet: ToolDef = {
  ...recipePhotoLabelSetSchema,
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
        if (e.label.length > RECIPE_PHOTO_LABEL_MAX_CHARS) {
          throw new Error(
            `label exceeds ${RECIPE_PHOTO_LABEL_MAX_CHARS}-char limit (got ${e.label.length})`
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
