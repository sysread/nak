/**
 * Schema-only export for record_file_remove. Impl lives in
 * `./record_file_remove` (edge:
 * supabase/functions/venice/tools/record_file_remove.ts).
 */
export const recordFileRemoveSchema = {
  name: 'record_file_remove',
  description:
    'Detach a file from a wiki record, deleting it from the record (and ' +
    'its stored bytes). Returns {removed: true|false}. The file_id comes ' +
    'from a record_get listing of the record\'s files.',
  shortDescription: 'remove a file from a record',
  parameters: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        description: 'Required. UUID of the record file to remove.',
      },
    },
    required: ['file_id'],
    additionalProperties: false,
  },
} as const;
