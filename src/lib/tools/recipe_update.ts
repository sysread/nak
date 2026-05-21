/**
 * Patch an existing recipe's title, cooklang, source, or source_url.
 * Any field can be omitted to leave it alone. Explicit null for
 * `source` / `source_url` clears the field — useful when the model
 * wants to drop a stale URL.
 *
 * Mirrors recipe_save's cooklang cap — an update that breaches the
 * limit is rejected rather than truncated, so the model gets a clear
 * signal it needs to shrink the source.
 */
import type { ToolDef } from './types';
import {
  MAX_RECIPE_COOKLANG_CHARS,
  MAX_RECIPE_TITLE_CHARS,
  validateCooklangSource,
} from '../cooklang';
// See recipe_save.ts — plain-.ts import, not the rune-using store.
import { notifyCookbookChanged } from '../cookbook-events';
import { recipeUpdateSchema } from './recipe_update.schema';

export const recipeUpdate: ToolDef = {
  ...recipeUpdateSchema,
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id : '';
    if (!id) throw new Error('id is required');
    const patch: {
      title?: string;
      cooklang?: string;
      source?: string | null;
      source_url?: string | null;
      rating?: number | null;
    } = {};
    if (typeof args.title === 'string' && args.title.trim().length > 0) {
      const t = args.title.trim();
      if (t.length > MAX_RECIPE_TITLE_CHARS) {
        throw new Error(
          `title exceeds ${MAX_RECIPE_TITLE_CHARS}-char limit (got ${t.length})`
        );
      }
      patch.title = t;
    }
    if (typeof args.cooklang === 'string' && args.cooklang.length > 0) {
      if (args.cooklang.length > MAX_RECIPE_COOKLANG_CHARS) {
        throw new Error(
          `cooklang exceeds ${MAX_RECIPE_COOKLANG_CHARS}-char limit (got ${args.cooklang.length})`
        );
      }
      // Same authoring-quirk gate recipe_save runs, for the same
      // reason: corrective error at the tool surface beats a silently
      // mis-rendered update landing in the user's cookbook.
      const cooklangErrors = validateCooklangSource(args.cooklang);
      if (cooklangErrors.length > 0) {
        throw new Error(
          `cooklang validation failed:\n- ${cooklangErrors.join('\n- ')}`
        );
      }
      patch.cooklang = args.cooklang;
    }
    if (args.source === null) patch.source = null;
    else if (typeof args.source === 'string') patch.source = args.source.trim();
    if (args.source_url === null) patch.source_url = null;
    else if (typeof args.source_url === 'string') patch.source_url = args.source_url.trim();
    // `rating` accepts null (clear), an integer 1-5, or omission
    // (leave alone). `'rating' in args` distinguishes the explicit-
    // null case from absence, mirroring the source / source_url
    // handling above.
    if ('rating' in args) {
      if (args.rating === null) {
        patch.rating = null;
      } else if (typeof args.rating === 'number') {
        if (!Number.isInteger(args.rating) || args.rating < 1 || args.rating > 5) {
          throw new Error('rating must be an integer between 1 and 5, or null to clear');
        }
        patch.rating = args.rating;
      }
    }
    if (Object.keys(patch).length === 0) {
      throw new Error(
        'provide at least one of title, cooklang, source, source_url, or rating'
      );
    }
    const changeMessage =
      typeof args.change_message === 'string' ? args.change_message.trim() : '';
    if (!changeMessage) {
      throw new Error('change_message is required');
    }
    const row = await ctx.supabase.updateRecipe(id, patch, changeMessage);
    notifyCookbookChanged();
    // Tack the current photo set onto the return so the LLM sees the
    // photos didn't move - parallel shape with recipe_get and the
    // recipe_photos_* tools. The scalar update path leaves photos
    // alone (the RPC inherits the previous version's link set), so
    // this just echoes the existing set rather than reflecting any
    // change.
    const photos = await ctx.supabase.listRecipePhotoMeta(id);
    return { ...row, photos };
  },
};
