/**
 * Schema-only export for the recipe_list tool. Impl lives in
 * `./recipe_list` and re-exports the schema via spread.
 */
export const RECIPE_LIST_DEFAULT_LIMIT = 40;
export const RECIPE_LIST_MAX_LIMIT = 200;

export const recipeListSchema = {
  name: 'recipe_list',
  description:
    "List the user's saved recipes. Returns an array of " +
    '{id, title, source, source_url, rating, updated_at} — call recipe_get ' +
    'to fetch the full Cooklang source. Leave `query` empty to list ' +
    "everything. `sort` defaults to most-recent-first; pass 'rating' to " +
    'order by stars (highest first; unrated last).',
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
        maximum: RECIPE_LIST_MAX_LIMIT,
        description: `Max results (default ${RECIPE_LIST_DEFAULT_LIMIT}, max ${RECIPE_LIST_MAX_LIMIT}).`,
      },
      sort: {
        type: 'string',
        enum: ['updated', 'rating'],
        description:
          "Sort order. 'updated' (default) lists most-recently-edited " +
          "first. 'rating' lists highest-rated first, ties broken by " +
          'most-recent edit; unrated recipes appear last.',
      },
    },
    additionalProperties: false,
  },
} as const;
