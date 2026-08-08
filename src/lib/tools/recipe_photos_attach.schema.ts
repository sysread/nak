/**
 * Schema-only export for recipe_photos_attach. Impl lives in
 * `./recipe_photos_attach`.
 */
export const recipePhotosAttachSchema = {
  name: 'recipe_photos_attach',
  description:
    'Add one or more conversation-attached photos to a saved recipe. ' +
    'filenames lists conversation-attachment filenames in display ' +
    'order (must match <thread_attachments> exactly, case-sensitive); ' +
    'each must be live (not expired). Photos already on the recipe ' +
    'are not duplicated; the array appends. Optional labels is ' +
    'parallel-indexed with filenames (labels[i] captions ' +
    'filenames[i]); pass empty/null for no caption, omit the array ' +
    'entirely when no photo gets a caption. Re-attaching a filename ' +
    'already on the recipe with a non-empty label updates that ' +
    "photo's caption. Use recipe_photos_remove to drop, " +
    'recipe_photos_reorder to reorder, recipe_photo_label_set to ' +
    'recaption photos already on the recipe. change_message REQUIRED. ' +
    'Returns {recipe_id, photos: [{id, position, label}, ...]} - ' +
    'the post-attach full ordered set.',
  shortDescription: 'attach conversation images to a recipe',
  parameters: {
    type: 'object',
    properties: {
      recipe_id: {
        type: 'string',
        description: 'UUID of the recipe.',
      },
      filenames: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
        description:
          'Conversation-attachment filenames in display order. Must ' +
          'match <thread_attachments> exactly (case-sensitive).',
      },
      labels: {
        type: 'array',
        items: { type: ['string', 'null'], maxLength: 200 },
        description:
          'Optional captions parallel-indexed with filenames. Length ' +
          'MUST match filenames when provided; pass empty/null per ' +
          'photo for no caption. Omit the field entirely if none get ' +
          'captions.',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          'One-line history note; lands in the recipe changelog the user reviews. Examples: "Added the finished plate ' +
          'photo", "Saved the dough progress shot".',
      },
    },
    required: ['recipe_id', 'filenames', 'change_message'],
    additionalProperties: false,
  },
} as const;
