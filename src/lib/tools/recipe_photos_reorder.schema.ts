/**
 * Schema-only export for recipe_photos_reorder. Impl lives in
 * `./recipe_photos_reorder`.
 */
export const recipePhotosReorderSchema = {
  name: 'recipe_photos_reorder',
  description:
    "Set a recipe's photo display order. photo_ids must be a " +
    "permutation of the recipe's current photo set (every id present, " +
    'no extras, no duplicates; call recipe_get to read the current ' +
    'order). Captions travel with their photos. Returns the reordered ' +
    'set with positions renumbered from 0.',
  shortDescription: 'reorder a recipe\'s photos',
  parameters: {
    type: 'object',
    properties: {
      recipe_id: {
        type: 'string',
        description: 'UUID of the recipe.',
      },
      photo_ids: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
        description:
          "New ordering. Permutation of the recipe's current photo " +
          'ids - every id present, no extras, no duplicates.',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          'One-line history note; lands in the recipe changelog the user reviews.',
      },
    },
    required: ['recipe_id', 'photo_ids', 'change_message'],
    additionalProperties: false,
  },
} as const;
