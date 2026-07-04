/**
 * Schema-only export for followup_dismiss. Impl lives in the venice edge
 * function (supabase/functions/venice/tools/followup_dismiss.ts).
 */
export const followupDismissSchema = {
  name: 'followup_dismiss',
  description:
    'Drop an open follow-up without an answer - the user asked you to ' +
    'stop asking about it, or the question is clearly no longer wanted. ' +
    'Distinct from followup_close: nothing was learned, the user just ' +
    'does not want the question raised. A dismissed question is not ' +
    're-created later.',
  shortDescription: 'stop asking a follow-up',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Required. UUID of the follow-up (from followup_list).',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
