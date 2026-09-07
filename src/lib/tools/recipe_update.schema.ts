/**
 * Schema-only export for recipe_update. Impl lives in `./recipe_update`.
 */
import { MAX_RECIPE_COOKLANG_CHARS, MAX_RECIPE_TITLE_CHARS } from '../recipe-limits';

export const recipeUpdateSchema = {
  name: 'recipe_update',
  // The cooklang authoring rules live once, in recipe_save's
  // description (cooklang is poorly represented in model training
  // data, so the full spec stays verbatim there). Under
  // every-tool-declared-every-request both schemas ride the same
  // request, so a cross-reference is safe and saves ~600 chars per
  // request.
  description:
    'Update a recipe by id. Provide at least one of title, cooklang, ' +
    'source, or source_url; omit a field to leave it unchanged. ' +
    'Pass ' +
    'null for source / source_url to clear them. The star rating is ' +
    "the user's own verdict and is not editable here - only they can " +
    'set or clear it, from the recipe card. cooklang ' +
    `capped at ${MAX_RECIPE_COOKLANG_CHARS} chars; use the same Cooklang ` +
    'authoring rules recipe_save describes. change_message is REQUIRED and lands in the recipe ' +
    "history. Returns the updated row plus the recipe's current photo " +
    'list, which this tool never changes - use the recipe_photos_* ' +
    'tools to edit photos.',
  shortDescription: 'edit a saved recipe',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the recipe (from recipe_list).',
      },
      title: { type: 'string', minLength: 1, maxLength: MAX_RECIPE_TITLE_CHARS },
      cooklang: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_RECIPE_COOKLANG_CHARS,
      },
      source: {
        type: ['string', 'null'],
        maxLength: 400,
        description: 'Free-form provenance, or null to clear.',
      },
      source_url: {
        type: ['string', 'null'],
        maxLength: 2000,
        description: 'URL provenance, or null to clear.',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          'One-line history note; lands in the recipe changelog the user reviews. Examples: "Fixed servings ' +
          'metadata", "Removed tahini per user dietary note".',
      },
    },
    required: ['id', 'change_message'],
    additionalProperties: false,
  },
} as const;
