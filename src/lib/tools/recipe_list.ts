/**
 * List recipes in the user's cookbook, optionally filtered by a
 * title substring. Returns just the small projection (id + title +
 * source + updated_at) — the model calls `recipe_get` to fetch the
 * full Cooklang source once it knows which recipe it wants.
 *
 * Keeping cooklang off the list response is a budget concern: a single
 * recipe's source runs 1-3 KiB, and a list of 40 recipes with full
 * sources would eat the entire context window before the model
 * even starts answering.
 */
import type { ToolDef } from './types';

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;

export const recipeList: ToolDef = {
  name: 'recipe_list',
  description:
    "List the user's saved recipes, most-recent first. Returns an array of " +
    '{id, title, source, updated_at} — call recipe_get to fetch the full ' +
    'Cooklang source. Leave `query` empty to list everything.',
  shortDescription: "list the user's recipes",
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Optional case-insensitive substring filter on recipe title. ' +
          'Omit or leave empty to list all recipes.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_LIMIT,
        description: `Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
      },
    },
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const rawLimit = typeof args.limit === 'number' ? args.limit : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(rawLimit)));
    const rows = await ctx.supabase.listRecipes(query, limit);
    // Strip `cooklang` from the list response — see file header for
    // why. The model reads (id, title, source, updated_at) and
    // follows up with recipe_get if it needs the full source.
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      source: r.source,
      source_url: r.source_url,
      updated_at: r.updated_at,
    }));
  },
};
