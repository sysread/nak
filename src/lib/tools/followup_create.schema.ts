/**
 * Schema-only export for followup_create. Impl lives in the venice edge
 * function (supabase/functions/venice/tools/followup_create.ts).
 *
 * Caps mirror MAX_FOLLOWUP_QUESTION_CHARS / MAX_FOLLOWUP_CONTEXT_CHARS
 * in supabase/functions/_shared/followups.ts (the enforcing side).
 */
export const followupCreateSchema = {
  name: 'followup_create',
  description:
    'Save a follow-up: a question you want answered in a future ' +
    'conversation because its outcome is unknown to you ("Ask how the ' +
    'lasagna turned out"). Save one when the user shares a plan or an ' +
    'upcoming event with a real "how did it go" horizon they seem to ' +
    'care about - not for every plan mentioned in passing. Check ' +
    'followup_list first: do not create one whose question is already ' +
    'open, or already answered or dismissed. Set relevant_after to just ' +
    'after the event when a date is known, so you can raise it ' +
    'proactively once it has passed; omit it when there is no date - ' +
    'the follow-up will then only surface when the topic comes up. ' +
    'Returns the created row.',
  shortDescription: 'save a question to ask later',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description:
          'Required. First-person prompt to your future self, e.g. ' +
          '"Ask how the lasagna turned out".',
      },
      context: {
        type: 'string',
        maxLength: 500,
        description:
          'One or two lines of seeding context, enough to raise the ' +
          'question naturally later ("Planned a ricotta lasagna for ' +
          'Saturday dinner").',
      },
      relevant_after: {
        type: 'string',
        description:
          'Optional ISO date or timestamp (e.g. "2026-07-06"). The ' +
          'follow-up becomes worth raising proactively after this ' +
          'moment - set it just AFTER the event. Omit when no date is ' +
          'known.',
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
} as const;
