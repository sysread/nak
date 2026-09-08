/**
 * Schema-only export for followup_save - the create/update-merged
 * follow-up write (see ./upsert.ts for the routing contract). Impl
 * lives in the venice edge function
 * (supabase/functions/venice/tools/followup_save.ts). Caps mirror
 * MAX_FOLLOWUP_QUESTION_CHARS / MAX_FOLLOWUP_CONTEXT_CHARS in
 * supabase/functions/_shared/followups.ts (the enforcing side).
 */
export const followupSaveSchema = {
  name: 'followup_save',
  description:
    'Save a follow-up: a question you want answered in a future ' +
    'conversation because its outcome is unknown to you ("Ask how the ' +
    'lasagna turned out"). Omit id to create one; pass id (from ' +
    'followup_list) to revise or reschedule an open follow-up - use ' +
    'that when a plan MOVED rather than resolved ("we ate out, making ' +
    'the lasagna tomorrow"): push relevant_after to the new date, or ' +
    'reword question/context. A reschedule resets the ask-cooldown, so ' +
    'the moved plan can be raised fresh after the new date; pass ' +
    'relevant_after as null to clear the date entirely. This is ' +
    'neither a close (nothing was resolved) nor a duplicate - the ' +
    'follow-up keeps its identity. Only open follow-ups can be ' +
    'revised. On create: save one when the user shares a plan or an ' +
    'upcoming event with a real "how did it go" horizon they seem to ' +
    'care about - not for every plan mentioned in passing; check ' +
    'followup_list first so you do not create one whose question is ' +
    'already open or already answered. Set relevant_after to just ' +
    'after the event when a date is known; omit it when there is no ' +
    'date. Returns the saved row.',
  shortDescription: 'save a question to ask later',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'UUID of the follow-up to revise (from followup_list). Omit ' +
          'to create a new follow-up.',
      },
      question: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description:
          'First-person prompt to your future self, e.g. ' +
          '"Ask how the lasagna turned out". Required on create; on ' +
          'revise, omit to leave unchanged.',
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
        type: ['string', 'null'],
        description:
          'Optional ISO date or timestamp (e.g. "2026-07-06"). The ' +
          'follow-up becomes worth raising proactively after this ' +
          'moment - set it just AFTER the event. Omit when no date is ' +
          'known. On revise: a string reschedules (resetting the ' +
          'ask-cooldown), null clears the date, omit to leave unchanged.',
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
} as const;
