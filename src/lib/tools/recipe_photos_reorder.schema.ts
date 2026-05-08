/**
 * Schema-only export for recipe_photos_reorder. Impl lives in
 * `./recipe_photos_reorder`.
 */
export const recipePhotosReorderSchema = {
  name: 'recipe_photos_reorder',
  description:
    "Set a recipe's photo display order. `photo_ids` is the new " +
    "ordering and MUST be exactly the recipe's current photo set " +
    '(every id present, no missing ones, no extras, no duplicates). ' +
    'Call `recipe_get` first to read the current `photos` array, ' +
    'then pass the same ids back in the desired order. To add or ' +
    'remove photos, use `recipe_photos_attach` or ' +
    '`recipe_photos_remove`; to change captions, use ' +
    '`recipe_photo_label_set`. This tool only reorders - existing ' +
    'captions travel with their photos automatically. ' +
    '`change_message` is REQUIRED and lands in the recipe history. ' +
    'Returns {recipe_id, photos: [{id, position, label}, ...]} - ' +
    'the new ordering with positions renumbered from 0.',
  shortDescription: 'reorder a recipe’s photos',
  parameters: {
    type: 'object',
    properties: {
      recipe_id: {
        type: 'string',
        description: 'UUID of the recipe whose photos to reorder.',
      },
      photo_ids: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
        description:
          "New ordering. Must be a permutation of the recipe's " +
          'current photo ids: every existing id present, no extras, ' +
          'no duplicates.',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          'One-line note describing the reorder and why. Stored in ' +
          "the recipe's version history. Examples: \"Moved the " +
          'finished plate first", "Grouped the prep shots before ' +
          'the served photo".',
      },
    },
    required: ['recipe_id', 'photo_ids', 'change_message'],
    additionalProperties: false,
  },
} as const;
