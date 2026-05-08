/**
 * Schema-only export for recipe_get. Impl lives in `./recipe_get`.
 */
export const recipeGetSchema = {
  name: 'recipe_get',
  description:
    'Fetch a recipe by id. Returns {found: true, recipe: {id, title, ' +
    'source, source_url, cooklang, rating, created_at, updated_at, ' +
    'photos: [{id, position, label}, ...]}} or {found: false}. ' +
    'Photos in display order; label is the optional caption (null when ' +
    'none). Pass photo ids to recipe_photos_remove / ' +
    'recipe_photos_reorder / recipe_photo_label_set. Use recipe_list ' +
    'first to discover recipe ids.',
  shortDescription: 'fetch a recipe by id',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the recipe (from recipe_list).',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
