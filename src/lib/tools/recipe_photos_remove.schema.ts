/**
 * Schema-only export for recipe_photos_remove. Impl lives in
 * `./recipe_photos_remove`.
 */
export const recipePhotosRemoveSchema = {
  name: 'recipe_photos_remove',
  description:
    'Remove one or more photos from a recipe by photo id (the id ' +
    "field on each entry of recipe_get's photos array). Every id " +
    'must be on the recipe; an unknown id fails the call rather than ' +
    'silently skipping. change_message REQUIRED. Returns ' +
    '{recipe_id, photos: [{id, position, label}, ...]} - the ' +
    'post-removal full ordered set with surviving captions preserved.',
  shortDescription: 'remove photos from a recipe by id',
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
          'Photo ids to remove (use recipe_get to find them).',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          'One-line history note. Examples: "Removed the blurry first ' +
          'attempt", "Dropped the redundant overhead shot".',
      },
    },
    required: ['recipe_id', 'photo_ids', 'change_message'],
    additionalProperties: false,
  },
} as const;
