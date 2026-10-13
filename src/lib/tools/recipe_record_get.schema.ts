/**
 * Schema-only export for recipe_record_get. Impl lives in
 * `./recipe_record_get` (edge:
 * supabase/functions/venice/tools/recipe_record_get.ts).
 */
export const recipeRecordGetSchema = {
  name: 'recipe_record_get',
  description:
    'Fetch one cooking record by id - its full Markdown body plus ' +
    'date, tags, and outcome. Returns {found: true, record: {...}} ' +
    'or {found: false}. Use recipe_record_list or ' +
    'recipe_record_search to discover ids. Get before ' +
    'recipe_record_update: details arrive piecemeal, and content is ' +
    'a full-replacement patch, so the existing body must be merged ' +
    'into the update.',
  shortDescription: 'fetch a cooking record by id',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Required. UUID of the record.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
