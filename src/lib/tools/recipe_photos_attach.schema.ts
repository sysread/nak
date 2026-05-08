/**
 * Schema-only export for recipe_photos_attach. Impl lives in
 * `./recipe_photos_attach`.
 */
export const recipePhotosAttachSchema = {
  name: 'recipe_photos_attach',
  description:
    'Add one or more photos from the current conversation to a saved ' +
    'recipe. `filenames` lists the conversation-attachment filenames ' +
    'in display order (the same names you see in the ' +
    '<thread_attachments> system block, case-sensitive). Each must be ' +
    'live (not expired). Photos already on the recipe are not ' +
    'duplicated; the array appends to the end of the existing photo ' +
    'set. `labels` is OPTIONAL and parallel-indexed with `filenames` ' +
    '(labels[i] is the caption for filenames[i]); pass empty string ' +
    'or null for photos that should have no caption, and omit the ' +
    'array entirely when no photo gets a caption. Captions are ' +
    'rendered below the thumbnail and beside the lightbox image. ' +
    'When attaching a filename whose image is already on the recipe ' +
    "and `labels[i]` is non-empty, the existing photo's caption is " +
    'updated. Use `recipe_photos_remove` to drop photos, ' +
    '`recipe_photos_reorder` to change their order, and ' +
    '`recipe_photo_label_set` to change captions on photos already ' +
    'on the recipe. `change_message` is REQUIRED and lands in the ' +
    'recipe history. Returns {recipe_id, photos: [{id, position, ' +
    'label}, ...]} - the post-attach full ordered set so you can ' +
    'chain into a follow-up call without a separate read.',
  shortDescription: 'attach conversation images to a recipe',
  parameters: {
    type: 'object',
    properties: {
      recipe_id: {
        type: 'string',
        description: 'UUID of the recipe to attach photos to.',
      },
      filenames: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
        description:
          'Conversation-attachment filenames to copy onto the recipe, ' +
          'in display order. Must match the names in ' +
          '<thread_attachments> exactly (case-sensitive).',
      },
      labels: {
        type: 'array',
        items: { type: ['string', 'null'], maxLength: 200 },
        description:
          'Optional captions for the photos, parallel-indexed with ' +
          '`filenames`. labels[i] is the caption for filenames[i]; ' +
          'pass empty string or null when a photo should have no ' +
          'caption. Length MUST match `filenames` when provided. ' +
          'Omit the field entirely (do not pass an empty array) ' +
          'when none of the photos being attached get a caption.',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          "One-line note describing what's being added and why. " +
          "Stored in the recipe's version history. Examples: " +
          '"Added a photo of the finished plate", "Saved the user\'s ' +
          'progress photo of the dough".',
      },
    },
    required: ['recipe_id', 'filenames', 'change_message'],
    additionalProperties: false,
  },
} as const;
