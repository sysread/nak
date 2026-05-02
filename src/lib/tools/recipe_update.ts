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
import { MAX_RECIPE_COOKLANG_CHARS, MAX_RECIPE_TITLE_CHARS } from '../cooklang';
// See recipe_save.ts — plain-.ts import, not the rune-using store.
import { notifyCookbookChanged } from '../cookbook-events';

export const recipeUpdate: ToolDef = {
  name: 'recipe_update',
  description:
    'Update a recipe by id. Omit a field to leave it unchanged. Pass null for ' +
    '`source` or `source_url` to clear them. `cooklang` is capped at ' +
    `${MAX_RECIPE_COOKLANG_CHARS} chars. Long recipes can be grouped with ` +
    '`== Section Name ==` or `# Section Name` headers. A line whose first ' +
    'non-whitespace character is `@` is an ingredient declaration (goes in ' +
    'the ingredients list, not in the numbered instructions); a dash-only ' +
    'line (e.g. `--` alone) resets the section so subsequent prose renders ' +
    'as flat numbered instructions. Long steps split across lines by ' +
    'prefixing continuations with `> `. `change_message` is REQUIRED and ' +
    "appears in the recipe's history panel as the description of this " +
    'edit (e.g. "Fixed a typo in step 3", "Doubled the recipe", ' +
    "\"Added the user's substitution for tahini\"). Use recipe_list first " +
    'to find ids. Returns the updated row.',
  shortDescription: 'edit a saved recipe',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the recipe to update (from recipe_list).',
      },
      title: { type: 'string', minLength: 1, maxLength: MAX_RECIPE_TITLE_CHARS },
      cooklang: { type: 'string', minLength: 1, maxLength: MAX_RECIPE_COOKLANG_CHARS },
      source: {
        type: ['string', 'null'],
        maxLength: 400,
        description: 'Free-form provenance, or null to clear.',
      },
      source_url: {
        type: ['string', 'null'],
        maxLength: 2000,
        description: 'URL provenance, or null to clear.',
      },
      rating: {
        type: ['integer', 'null'],
        minimum: 1,
        maximum: 5,
        description:
          "User's 1-5 star rating, or null to clear back to unrated. Only " +
          'set this when the user has explicitly told you how they feel ' +
          "about the recipe (e.g. \"that turned out great, give it 5 " +
          'stars"). Do not invent a rating from reviews or your own ' +
          'judgement.',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          'One-line note describing what changed and why. Stored in the ' +
          "recipe's version history and shown to the user in the History " +
          'panel. Examples: "Fixed servings metadata", "Removed tahini ' +
          'per user dietary note", "Cleaned up imported prose".',
      },
    },
    required: ['id', 'change_message'],
    additionalProperties: false,
  },
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
