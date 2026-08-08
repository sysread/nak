/**
 * Schema-only export for the recipe_list tool. Impl lives in
 * `./recipe_list` and re-exports the schema via spread.
 */
export const RECIPE_LIST_DEFAULT_LIMIT = 100;
export const RECIPE_LIST_MAX_LIMIT = 500;

export const recipeListSchema = {
  name: 'recipe_list',
  description:
    "List the user's saved recipes. Returns {id, title, source, " +
    'source_url, rating, updated_at}[] - call recipe_get for the ' +
    'full Cooklang source. Empty query lists everything; sort ' +
    "defaults to most-recent-first ('rating' orders by stars first, " +
    'unrated last).',
  shortDescription: "list the user's recipes",
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Optional case-insensitive substring filter on title.',
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
          "'updated' (default) most-recently-edited first; 'rating' " +
          'highest-rated first, unrated last.',
      },
    },
    additionalProperties: false,
  },
} as const;
