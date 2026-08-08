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
    'photo_id must be on the recipe (use recipe_get to find ids). ' +
    'Photos not named keep their existing captions. Max 200 chars per ' +
    'caption. To add or remove photos use recipe_photos_attach or ' +
    'recipe_photos_remove. change_message REQUIRED. Returns ' +
    "{recipe_id, photos: [{id, position, label}, ...]} - the recipe's " +
    'full ordered photo set with the new captions.',
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
              description:
                'Photo id to retitle. Must be on the recipe (use ' +
                'recipe_get to find ids).',
            },
            label: {
              type: ['string', 'null'],
              maxLength: RECIPE_PHOTO_LABEL_MAX_CHARS,
              description:
                'New caption, or null/empty to clear. Max 200 chars.',
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
          'One-line history note; lands in the recipe changelog the user reviews. Examples: "Captioned the finished ' +
          'plate", "Cleared the obsolete progress-shot caption".',
      },
    },
    required: ['recipe_id', 'labels', 'change_message'],
    additionalProperties: false,
  },
} as const;
