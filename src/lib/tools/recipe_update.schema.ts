/**
 * Schema-only export for recipe_update. Impl lives in `./recipe_update`.
 */
import { MAX_RECIPE_COOKLANG_CHARS, MAX_RECIPE_TITLE_CHARS } from '../recipe-limits';

export const recipeUpdateSchema = {
  name: 'recipe_update',
  description:
    'Update a recipe by id. Omit a field to leave it unchanged; pass ' +
    'null for source / source_url / rating to clear them. cooklang ' +
    `capped at ${MAX_RECIPE_COOKLANG_CHARS} chars; section / declaration / ` +
    'continuation rules match recipe_save. Same authoring constraints ' +
    'apply: no markdown (`**bold**`, backticks) in the source; use ' +
    '`~{N%unit}` for durations; write modifier+ingredient as one ' +
    'multi-word braced name (`@pre-minced garlic{1%tbsp}`), not two ' +
    '`@` tokens. change_message is REQUIRED and lands in the recipe ' +
    'history. Returns the updated row.',
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
      rating: {
        type: ['integer', 'null'],
        minimum: 1,
        maximum: 5,
        description:
          "User's 1-5 star rating, or null to clear. Set only when " +
          'the user has explicitly indicated their feelings about the ' +
          'recipe; do not invent.',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          'One-line history note. Examples: "Fixed servings ' +
          'metadata", "Removed tahini per user dietary note".',
      },
    },
    required: ['id', 'change_message'],
    additionalProperties: false,
  },
} as const;
