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
    'are not duplicated; the array appends. Re-attaching a filename ' +
    'already on the recipe with a non-empty label updates that ' +
    "photo's caption. Returns the post-attach full ordered photo set.",
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
          'Optional captions, parallel-indexed with filenames (same ' +
          'length). Omit if none get captions.',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          'One-line history note; lands in the recipe changelog the user reviews.',
      },
    },
    required: ['recipe_id', 'filenames', 'change_message'],
    additionalProperties: false,
  },
} as const;
