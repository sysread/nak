/**
 * Schema-only export for followup_list. Impl lives in the venice edge
 * function (supabase/functions/venice/tools/followup_list.ts).
 */
export const followupListSchema = {
  name: 'followup_list',
  description:
    'List your follow-ups: the open questions you saved to ask the user ' +
    'later (with their relevant_after dates and how often each has been ' +
    'raised), plus recently closed ones with their resolutions. Use it ' +
    'to answer "what were you going to ask me?", to find an id for ' +
    'followup_update / followup_close / followup_dismiss, and ALWAYS ' +
    'before followup_create - a question already open, answered, or ' +
    'dismissed must not be created again.',
  shortDescription: 'list saved follow-up questions',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
} as const;
