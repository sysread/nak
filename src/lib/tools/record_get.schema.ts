/**
 * Schema-only export for record_get. Impl lives in `./record_get`
 * (edge: supabase/functions/venice/tools/record_get.ts).
 */
export const recordGetSchema = {
  name: 'record_get',
  description:
    'Fetch one record by id, with its attached files and its links to ' +
    'other records. Returns {found: true, record: {...}, files: [{id, ' +
    'filename, is_image, extracted_text?}], links: [{direction, label, ' +
    'record_id, date, excerpt}]} or {found: false}. Attached documents ' +
    'expose their text under extracted_text (images do not). Use ' +
    'record_list or record_search to discover ids.',
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
