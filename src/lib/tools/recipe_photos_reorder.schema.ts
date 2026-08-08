/**
 * Schema-only export for recipe_photos_reorder. Impl lives in
 * `./recipe_photos_reorder`.
 */
export const recipePhotosReorderSchema = {
  name: 'recipe_photos_reorder',
  description:
    "Set a recipe's photo display order. photo_ids MUST be a " +
    "permutation of the recipe's current photo set (every id present, " +
    'no missing, no extras, no duplicates). Call recipe_get first to ' +
    'read the current order. To add or remove use ' +
    'recipe_photos_attach or recipe_photos_remove; to recaption use ' +
    'recipe_photo_label_set. Captions travel with their photos. ' +
    'change_message REQUIRED. Returns {recipe_id, photos: [{id, ' +
    'position, label}, ...]} with positions renumbered from 0.',
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
          'One-line history note; lands in the recipe changelog the user reviews. Examples: "Moved the finished plate ' +
          'first", "Grouped prep shots before the served photo".',
      },
    },
    required: ['recipe_id', 'photo_ids', 'change_message'],
    additionalProperties: false,
  },
} as const;
