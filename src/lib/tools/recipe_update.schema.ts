/**
 * Schema-only export for recipe_update. Impl lives in `./recipe_update`.
 */
import { MAX_RECIPE_COOKLANG_CHARS, MAX_RECIPE_TITLE_CHARS } from '../cooklang';

export const recipeUpdateSchema = {
  name: 'recipe_update',
  description:
    'Update a recipe by id. Omit a field to leave it unchanged. Pass null for ' +
    '`source` or `source_url` to clear them. `cooklang` is capped at ' +
    `${MAX_RECIPE_COOKLANG_CHARS} chars. Long recipes can be grouped with ` +
    '`== Section Name ==` or `# Section Name` headers. A line whose first ' +
    'non-whitespace character is `@` is an ingredient declaration (goes in ' +
    'the ingredients list, not in the numbered instructions); a dash-only ' +
    'line (e.g. `--` alone) resets the section so subsequent prose renders ' +
    'as flat numbered instructions. Long steps split across lines by ' +
    'prefixing continuations with `> `. `change_message` is REQUIRED and ' +
    "appears in the recipe's history panel as the description of this " +
    'edit (e.g. "Fixed a typo in step 3", "Doubled the recipe", ' +
    "\"Added the user's substitution for tahini\"). Use recipe_list first " +
    'to find ids. Returns the updated row.',
  shortDescription: 'edit a saved recipe',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'UUID of the recipe to update (from recipe_list).',
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
          "User's 1-5 star rating, or null to clear back to unrated. Only " +
          'set this when the user has explicitly told you how they feel ' +
          "about the recipe (e.g. \"that turned out great, give it 5 " +
          'stars"). Do not invent a rating from reviews or your own ' +
          'judgement.',
      },
      change_message: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          'One-line note describing what changed and why. Stored in the ' +
          "recipe's version history and shown to the user in the History " +
          'panel. Examples: "Fixed servings metadata", "Removed tahini ' +
          'per user dietary note", "Cleaned up imported prose".',
      },
    },
    required: ['id', 'change_message'],
    additionalProperties: false,
  },
} as const;
