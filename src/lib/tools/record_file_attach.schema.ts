/**
 * Schema-only export for record_file_attach. Impl lives in
 * `./record_file_attach` (edge:
 * supabase/functions/venice/tools/record_file_attach.ts).
 *
 * Promotes a file already in the conversation (a user upload OR a
 * generate_image output - both are thread attachments) onto a wiki
 * record, copying the bytes into the persistent record-files store.
 */
export const recordFileAttachSchema = {
  name: 'record_file_attach',
  description:
    'Attach a file from THIS conversation to a wiki record, by its ' +
    'filename. Works for any file the conversation holds - a file the ' +
    'user uploaded or an image you generated. The bytes are copied into ' +
    'permanent record storage, so the file stays on the record even after ' +
    'the chat attachment expires. Use this to put crumb photos, scanned ' +
    'cards, or generated images onto the record that documents them. The ' +
    'file must still be live in the thread (an expired attachment errors).',
  shortDescription: 'attach a conversation file to a record',
  parameters: {
    type: 'object',
    properties: {
      record_id: {
        type: 'string',
        description: 'Required. UUID of the record to attach the file to (from record_list / record_search).',
      },
      filename: {
        type: 'string',
        description: 'Required. Exact filename of the file as it appears in this conversation.',
      },
    },
    required: ['record_id', 'filename'],
    additionalProperties: false,
  },
} as const;
