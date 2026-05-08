/**
 * Schema-only export for recipe_photos_remove. Impl lives in
 * `./recipe_photos_remove`.
 */
export const recipePhotosRemoveSchema = {
  name: 'recipe_photos_remove',
  description:
    'Remove one or more photos from a recipe by photo id (the `id` ' +
    'field on each entry of the recipe\'s `photos` array - call ' +
    '`recipe_get` first to find them). Every id must currently be ' +
    'on the recipe; an unknown id fails the whole call rather than ' +
    'silently skipping. `change_message` is REQUIRED and lands in ' +
    'the recipe history. Returns {recipe_id, photos: [{id, ' +
    'position, label}, ...]} - the post-removal full ordered set, ' +
    "with the surviving photos' captions preserved.",
  shortDescription: 'remove photos from a recipe by id',
  parameters: {
    type: 'object',
    properties: {
      recipe_id: {
        type: 'string',
        description: 'UUID of the recipe to remove photos from.',
      },
      photo_ids: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
        description:
          'Photo ids to remove. Each id must currently be on the ' +
          'recipe (use recipe_get to find them).',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          "One-line note describing what's being removed and why. " +
          "Stored in the recipe's version history. Examples: " +
          '"Removed the blurry first attempt", "Dropped the ' +
          'redundant overhead shot".',
      },
    },
    required: ['recipe_id', 'photo_ids', 'change_message'],
    additionalProperties: false,
  },
} as const;
