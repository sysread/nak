/**
 * Schema-only export for `recipe_photos` - the recipe-photo
 * combination tool. One tool, one `op` enum discriminator
 * (attach / remove / reorder / label) with flat per-op parameters,
 * replacing the four recipe_photos_* / recipe_photo_label_set verb
 * tools. The combo form follows the `skills` precedent (see that
 * schema's header for the calibration record and the enum-vs-oneOf
 * rationale); per-op required fields cannot be expressed in one
 * flat JSON Schema, so the edge impl enforces them
 * (supabase/functions/venice/tools/recipe_photos.ts).
 *
 * The four per-op contracts predate the combo: the May 2026 split
 * (a49dd52d) recorded a deliberate anti-merge rationale for
 * attach/remove/reorder ("set the photo set to X" invites the model
 * to forget to enumerate the existing photos and silently clear
 * them). The combo preserves every closed per-op contract - reorder
 * still takes a full permutation, attach still fails fast with
 * every problem named - only the envelope changed, from
 * name-to-name to name-plus-op.
 *
 * Impl lives in the venice edge function, which self-registers for
 * dispatch.
 */

function formatRecipePhotosArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];
  // The op leads: the detail panel should read what kind of photo
  // call this is before any operand.
  if (typeof args.op === 'string' && args.op) {
    lines.push(`**Op:** ${args.op}`);
  }
  if (typeof args.recipe_id === 'string' && args.recipe_id) {
    lines.push(`**Recipe id:** ${args.recipe_id}`);
  }
  if (Array.isArray(args.filenames) && args.filenames.length > 0) {
    lines.push(`**Filenames:** ${args.filenames.join(', ')}`);
  }
  if (Array.isArray(args.photo_ids) && args.photo_ids.length > 0) {
    lines.push(`**Photo ids:** ${args.photo_ids.join(', ')}`);
  }
  if (Array.isArray(args.labels) && args.labels.length > 0) {
    lines.push(`**Labels:** ${JSON.stringify(args.labels)}`);
  }
  if (typeof args.change_message === 'string' && args.change_message) {
    lines.push(`**Change:** ${args.change_message}`);
  }
  return lines.join('\n');
}

export const recipePhotosSchema = {
  name: 'recipe_photos',
  description:
    "Manage the photos on a saved recipe. One tool, one op. " +
    'attach: add conversation-attached images to the recipe, in ' +
    'display order; re-attaching a filename already on the recipe ' +
    "with a non-empty label updates that photo's caption instead of " +
    'duplicating it. remove: drop photos by id - every id must be on ' +
    'the recipe; an unknown id FAILS the call rather than silently ' +
    'skipping. reorder: set the full display order - photo_ids must ' +
    'be a permutation of the current set (every id present, no ' +
    'extras, no duplicates). label: set or clear captions on ' +
    'existing photos; photos not named keep their captions. Every ' +
    'op writes a recipe_versions row, so each change shows in the ' +
    "user's History panel. Returns the post-change full ordered " +
    'photo set with positions from 0.',
  shortDescription: 'manage recipe photos (attach/remove/reorder/label)',
  formatArgs: formatRecipePhotosArgs,
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['attach', 'remove', 'reorder', 'label'],
        description:
          'The operation to run. attach: add conversation images. ' +
          'remove: drop photos by id. reorder: set the display ' +
          'order. label: set or clear captions.',
      },
      recipe_id: {
        type: 'string',
        description:
          'UUID of the recipe. Required on every op. Use recipe_get ' +
          'to find it.',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          'Required on every op. One-line history note; lands in ' +
          'the recipe changelog the user reviews.',
      },
      filenames: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
        description:
          'attach only. Conversation-attachment filenames in ' +
          'display order. Must match <thread_attachments> exactly ' +
          '(case-sensitive); each must be live (not expired).',
      },
      labels: {
        type: 'array',
        description:
          'Two shapes, by op. attach: OPTIONAL (string|null)[] ' +
          'parallel-indexed with filenames (same length) - the ' +
          'caption per new photo; omit if none get captions. ' +
          'label: REQUIRED {photo_id, label}[] pairs - label is ' +
          'the new caption (max 200 chars) or null/empty to clear; ' +
          'photos not named keep their captions.',
      },
      photo_ids: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
        description:
          'remove: photo ids to drop (from recipe_get). reorder: ' +
          'the FULL new ordering - a permutation of the current ' +
          'photo ids; captions travel with their photos.',
      },
    },
    required: ['op', 'recipe_id', 'change_message'],
    additionalProperties: false,
  },
} as const;
