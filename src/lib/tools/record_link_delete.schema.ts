/**
 * Schema-only export for record_link_delete. Impl lives in
 * `./record_link_delete` (edge:
 * supabase/functions/venice/tools/record_link_delete.ts).
 */
export const recordLinkDeleteSchema = {
  name: 'record_link_delete',
  description:
    'Remove the directed link from one record to another. Direction ' +
    'matters: this removes the (from -> to) edge only, leaving any ' +
    'reverse edge. Returns {deleted: true|false}. Use the record ids a ' +
    "record_get listing of the record's links reports.",
  shortDescription: 'remove a link between records',
  parameters: {
    type: 'object',
    properties: {
      from_record_id: {
        type: 'string',
        description: 'Required. UUID of the source record of the link to remove.',
      },
      to_record_id: {
        type: 'string',
        description: 'Required. UUID of the target record of the link to remove.',
      },
    },
    required: ['from_record_id', 'to_record_id'],
    additionalProperties: false,
  },
} as const;
