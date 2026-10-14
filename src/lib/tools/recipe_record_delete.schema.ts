/**
 * Schema-only export for recipe_record_delete. Impl lives in
 * `./recipe_record_delete` (edge:
 * supabase/functions/venice/tools/recipe_record_delete.ts).
 */
export const recipeRecordDeleteSchema = {
  name: 'recipe_record_delete',
  description:
    'Delete a cooking record the user no longer wants kept. Provide ' +
    'id (from recipe_record_list or recipe_record_search). Hard ' +
    'delete - the log is the historical record, so only remove one ' +
    'when the user explicitly asks or it is clearly a duplicate / ' +
    'mistake. Returns {deleted: true}, or {deleted: false, reason} ' +
    'when no record with that id exists - check the flag rather ' +
    'than assuming the delete landed.',
  shortDescription: 'delete a cooking record',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Required. UUID of the record to delete.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
