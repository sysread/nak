/**
 * Schema-only export for recipe_photo_label_set. Impl lives in
 * `./recipe_photo_label_set`.
 */
export const RECIPE_PHOTO_LABEL_MAX_CHARS = 200;

export const recipePhotoLabelSetSchema = {
  name: 'recipe_photo_label_set',
  description:
    "Set or clear captions on a recipe's existing photos. labels is " +
    'an array of {photo_id, label} pairs; each sets the caption to ' +
    'the given string, or clears it when label is null/empty. Every ' +
    'photo_id must be on the recipe (from recipe_get); photos not ' +
    'named keep their captions. Returns the full ordered photo set ' +
    'with the new captions.',
  shortDescription: 'set or clear photo captions on a recipe',
  parameters: {
    type: 'object',
    properties: {
      recipe_id: {
        type: 'string',
        description: 'UUID of the recipe.',
      },
      labels: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            photo_id: {
              type: 'string',
              minLength: 1,
              description: 'Photo id to retitle (from recipe_get).',
            },
            label: {
              type: ['string', 'null'],
              maxLength: RECIPE_PHOTO_LABEL_MAX_CHARS,
              description: 'New caption, or null/empty to clear.',
            },
          },
          required: ['photo_id'],
          additionalProperties: false,
        },
        description:
          '{photo_id, label} pairs. Photos not named keep their ' +
          'captions.',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          'One-line history note; lands in the recipe changelog the user reviews.',
      },
    },
    required: ['recipe_id', 'labels', 'change_message'],
    additionalProperties: false,
  },
} as const;
