/**
 * List recipes in the user's cookbook, optionally filtered by a
 * title substring. Returns just the small projection (id + title +
 * source + updated_at) - the model calls `recipe_get` to fetch the
 * full Cooklang source once it knows which recipe it wants.
 *
 * Keeping cooklang off the list response is a budget concern: a single
 * recipe's source runs 1-3 KiB, and a list of 40 recipes with full
 * sources would eat the entire context window before the model
 * even starts answering.
 *
 * Schema lives in `./recipe_list.schema.ts`.
 */
import type { ToolDef } from './types';
import {
  recipeListSchema,
  RECIPE_LIST_DEFAULT_LIMIT,
  RECIPE_LIST_MAX_LIMIT,
} from './recipe_list.schema';

export const recipeList: ToolDef = {
  ...recipeListSchema,
  async execute(args, ctx) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const rawLimit =
      typeof args.limit === 'number' ? args.limit : RECIPE_LIST_DEFAULT_LIMIT;
    const limit = Math.max(
      1,
      Math.min(RECIPE_LIST_MAX_LIMIT, Math.floor(rawLimit))
    );
    const sort: 'updated' | 'rating' =
      args.sort === 'rating' ? 'rating' : 'updated';
    const rows = await ctx.supabase.listRecipes(query, limit, sort);
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      source: r.source,
      source_url: r.source_url,
      rating: r.rating,
      updated_at: r.updated_at,
    }));
  },
};
