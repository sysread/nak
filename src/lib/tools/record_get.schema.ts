/**
 * Schema-only export for record_get. Impl lives in `./record_get`
 * (edge: supabase/functions/venice/tools/record_get.ts).
 */
export const recordGetSchema = {
  name: 'record_get',
  description:
    'Fetch one record by id. Returns {found: true, record: {id, ' +
    'article_id, date, content, tags, created_at, updated_at}} or ' +
    '{found: false}. Use record_list or record_search to discover ids.',
  shortDescription: 'fetch a record by id',
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
