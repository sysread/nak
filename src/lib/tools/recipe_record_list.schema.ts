/**
 * Schema-only export for recipe_record_list. Impl lives in
 * `./recipe_record_list` (edge:
 * supabase/functions/venice/tools/recipe_record_list.ts).
 */
export const recipeRecordListSchema = {
  name: 'recipe_record_list',
  description:
    "List one recipe's cooking log (its records), most recent event " +
    'first. Provide recipe_id (from recipe_list) and optional ' +
    'filters: from_date / to_date (inclusive ISO 8601 bounds), tags ' +
    '(a record must carry every listed tag), and outcome (success | ' +
    'mixed | failure). Returns {records: [{id, date, content, tags, ' +
    'outcome, created_at}]}. Use this to survey a recipe\'s log ' +
    'before recipe_record_create - if the event is already logged, ' +
    'recipe_record_update the existing record instead of stacking a ' +
    'duplicate (same EVENT, not same date).',
  shortDescription: "list a recipe's cooking log",
  parameters: {
    type: 'object',
    properties: {
      recipe_id: {
        type: 'string',
        description: 'Required. UUID of the recipe.',
      },
      from_date: {
        type: 'string',
        description: 'Optional. Inclusive lower bound on the event date ("YYYY-MM-DD").',
      },
      to_date: {
        type: 'string',
        description: 'Optional. Inclusive upper bound on the event date ("YYYY-MM-DD").',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional. Only records carrying every one of these tags.',
      },
      outcome: {
        type: 'string',
        enum: ['success', 'mixed', 'failure'],
        description: 'Optional. Only records classified with this outcome.',
      },
      limit: {
        type: 'number',
        description: 'Optional. Max records to return (default 50, max 200).',
      },
    },
    required: ['recipe_id'],
    additionalProperties: false,
  },
} as const;
