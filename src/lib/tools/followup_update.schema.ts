/**
 * Schema-only export for followup_update. Impl lives in the venice edge
 * function (supabase/functions/venice/tools/followup_update.ts).
 */
export const followupUpdateSchema = {
  name: 'followup_update',
  description:
    'Revise or reschedule an open follow-up. Use this when a plan MOVED ' +
    'rather than resolved ("we ate out, making the lasagna tomorrow"): ' +
    'push relevant_after to the new date, or reword question/context. ' +
    'This is neither a close (nothing was resolved) nor a new save - ' +
    'the follow-up keeps its identity. Rescheduling resets the ' +
    'ask-cooldown, so the moved plan can be raised fresh after the new ' +
    'date. Pass relevant_after as null to clear the date entirely ' +
    '(the follow-up then only surfaces when the topic comes up). ' +
    'Provide at least one of question, context, or relevant_after. ' +
    'Only open follow-ups can be updated.',
  shortDescription: 'reschedule or revise a follow-up',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Required. UUID of the follow-up (from followup_list).',
      },
      question: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'New question wording. Omit to leave unchanged.',
      },
      context: {
        type: 'string',
        maxLength: 500,
        description: 'New seeding context. Omit to leave unchanged.',
      },
      relevant_after: {
        type: ['string', 'null'],
        description:
          'New ISO date/timestamp for when the question becomes worth ' +
          'raising, or null to clear the date. Omit to leave unchanged.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
} as const;
