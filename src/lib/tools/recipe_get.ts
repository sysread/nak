/**
 * Fetch the full Cooklang source for a single recipe by id. Used after
 * `recipe_list` once the model knows which recipe it wants to read,
 * edit, or transcribe for the user. Returns the whole row including
 * the (potentially multi-KiB) `cooklang` field plus the recipe's
 * current photo ids in display order.
 *
 * Returns `{found: false}` rather than throwing when the id is unknown
 * (or belongs to another user — RLS filters it out). Throwing would
 * force the LLM to guard every call with a try/catch; a structured
 * "not found" lets it handle the case in prose.
 *
 * The `photos` field carries ids, positions, and labels - no image
 * bytes. That keeps the response small while giving the LLM the
 * handles it needs to chain into `recipe_photos_remove`,
 * `recipe_photos_reorder`, or `recipe_photo_label_set`. `label` is
 * the photo's caption (null when there isn't one). To see what's
 * in a photo, the model can call `analyze_image` against the
 * original conversation attachment filename it remembers attaching,
 * or just describe to the user which photo position is which.
 */
import type { ToolDef } from './types';
import { recipeGetSchema } from './recipe_get.schema';

export const recipeGet: ToolDef = {
  ...recipeGetSchema,
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');
    const row = await ctx.supabase.getRecipe(id);
    if (!row) return { found: false };
    const photos = await ctx.supabase.listRecipePhotoMeta(id);
    return { found: true, recipe: { ...row, photos } };
  },
};
