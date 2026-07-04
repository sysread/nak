/**
 * Schema-only export for followup_close. Impl lives in the venice edge
 * function (supabase/functions/venice/tools/followup_close.ts).
 */
export const followupCloseSchema = {
  name: 'followup_close',
  description:
    'Mark an open follow-up answered, the moment the user reports the ' +
    'outcome - whether you asked or they volunteered it. resolution is ' +
    'a one-line record of what the answer was ("made it Saturday; too ' +
    'salty"). Closing stops the question from ever surfacing again; if ' +
    'the outcome itself is worth remembering long-term, also save it as ' +
    'a memory (memory_create) - the resolution line is an audit stamp, ' +
    'not a memory.',
  shortDescription: 'mark a follow-up answered',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Required. UUID of the follow-up (from followup_list).',
      },
      resolution: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description: 'Required. One line on what the answer was.',
      },
    },
    required: ['id', 'resolution'],
    additionalProperties: false,
  },
} as const;
