/**
 * Schema-only export for recipe_photo_label_set. Impl lives in
 * `./recipe_photo_label_set`.
 */
export const RECIPE_PHOTO_LABEL_MAX_CHARS = 200;

export const recipePhotoLabelSetSchema = {
  name: 'recipe_photo_label_set',
  description:
    "Set or clear captions on a recipe's existing photos. `labels` " +
    'is an array of {photo_id, label} pairs; each pair sets that ' +
    "photo's caption to the given string, or clears it when label " +
    'is null or empty. Every photo_id must currently be on the ' +
    'recipe (call `recipe_get` first to discover ids and current ' +
    'captions). Photos not named keep their existing captions. ' +
    'Captions render below the thumbnail and beside the lightbox ' +
    'image; max 200 chars. To add or remove photos, use ' +
    '`recipe_photos_attach` or `recipe_photos_remove`. ' +
    '`change_message` is REQUIRED and lands in the recipe history. ' +
    'Returns {recipe_id, photos: [{id, position, label}, ...]} - ' +
    "the recipe's full ordered photo set with the new captions.",
  shortDescription: 'set or clear photo captions on a recipe',
  parameters: {
    type: 'object',
    properties: {
      recipe_id: {
        type: 'string',
        description:
          'UUID of the recipe whose photo captions to set or clear.',
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
                'Photo id to retitle. Must currently be on the ' +
                'recipe (use recipe_get to find ids).',
            },
            label: {
              type: ['string', 'null'],
              maxLength: RECIPE_PHOTO_LABEL_MAX_CHARS,
              description:
                'New caption, or null/empty string to clear the ' +
                'caption back to "no label". Max 200 chars.',
            },
          },
          required: ['photo_id'],
          additionalProperties: false,
        },
        description:
          '{photo_id, label} pairs. Each photo_id must currently be ' +
          'linked to the recipe. Photos not named keep their ' +
          'existing captions.',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          "One-line note describing what's being captioned and why. " +
          "Stored in the recipe's version history. Examples: " +
          '"Captioned the finished plate", "Cleared the obsolete ' +
          'progress-shot caption".',
      },
    },
    required: ['recipe_id', 'labels', 'change_message'],
    additionalProperties: false,
  },
} as const;
