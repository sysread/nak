/**
 * Schema-only export for record_delete. Impl lives in `./record_delete`
 * (edge: supabase/functions/venice/tools/record_delete.ts).
 */
export const recordDeleteSchema = {
  name: 'record_delete',
  description:
    'Delete a record the user no longer wants kept. Provide id (from ' +
    'record_list or record_search). Hard delete - records are historical ' +
    'documentation, so only remove one when the user explicitly asks or ' +
    'it is clearly a duplicate / mistake. Returns {deleted: true}.',
  shortDescription: 'delete a record',
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
