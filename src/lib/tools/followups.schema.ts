/**
 * Schema-only export for `followups` - the pending-question
 * combination tool. One tool, one `op` enum discriminator (list /
 * save / close / dismiss) with flat per-op parameters, replacing the
 * four followup_list / followup_save / followup_close /
 * followup_dismiss verb tools. The combo form follows the `skills`
 * precedent (see that schema's header for the calibration record);
 * per-op required fields cannot be expressed in one flat JSON
 * Schema, so the edge impl routes validation on `op` with ArgErrors
 * (supabase/functions/venice/tools/followups.ts).
 *
 * Caps mirror MAX_FOLLOWUP_* in supabase/functions/_shared/followups.ts
 * (the enforcing side).
 */

function formatFollowupsArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];
  // The op leads: the detail panel should read what kind of
  // follow-up call this is before any operand.
  if (typeof args.op === 'string' && args.op) {
    lines.push(`**Op:** ${args.op}`);
  }
  if (typeof args.id === 'string' && args.id) {
    lines.push(`**Follow-up id:** ${args.id}`);
  }
  if (typeof args.question === 'string' && args.question) {
    lines.push(`**Question:** ${args.question}`);
  }
  if (typeof args.context === 'string' && args.context) {
    lines.push(`**Context:** ${args.context}`);
  }
  if (typeof args.relevant_after === 'string' && args.relevant_after) {
    lines.push(`**Relevant after:** ${args.relevant_after}`);
  }
  if (typeof args.resolution === 'string' && args.resolution) {
    lines.push(`**Resolution:** ${args.resolution}`);
  }
  return lines.join('\n');
}

export const followupsSchema = {
  name: 'followups',
  description:
    "Maintain your pending questions: follow-ups you save to ask the " +
    'user in a future conversation because their outcome is unknown ' +
    'to you ("Ask how the lasagna turned out"). One tool, one op. ' +
    'save: create a follow-up when the user shares a plan or an ' +
    'upcoming event with a real "how did it go" horizon they seem ' +
    'to care about - not for every plan mentioned in passing - or ' +
    'revise/reschedule one by id when a plan MOVED rather than ' +
    'resolved ("we ate out, making the lasagna tomorrow": push ' +
    'relevant_after to the new date; a reschedule resets the ' +
    'ask-cooldown; null clears the date). ALWAYS list first so you ' +
    'do not create one whose question is already open or already ' +
    "answered. close: mark one answered the moment the user reports " +
    'the outcome - whether you asked or they volunteered it; the ' +
    'resolution is a one-line audit stamp, not a memory (if the ' +
    'outcome is worth remembering long-term, also save a memory). ' +
    'dismiss: drop one without an answer when the user asks you to ' +
    'stop asking - distinct from close: nothing was learned. Only ' +
    'open follow-ups can be revised, closed, or dismissed. Returns ' +
    'the affected row.',
  shortDescription: 'maintain pending questions to ask later',
  formatArgs: formatFollowupsArgs,
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['list', 'save', 'close', 'dismiss'],
        description:
          'REQUIRED on every call. The operation to run. list: the ' +
          'open set + recently closed. save: create or revise. ' +
          'close: mark answered. dismiss: stop asking.',
      },
      id: {
        type: 'string',
        description:
          'Follow-up UUID (from list). save: the follow-up to ' +
          'revise (omit to create). close: required. dismiss: ' +
          'required.',
      },
      question: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description:
          'save only. First-person prompt to your future self, ' +
          'e.g. "Ask how the lasagna turned out". Required on ' +
          'create; on revise, omit to leave unchanged.',
      },
      context: {
        type: 'string',
        maxLength: 500,
        description:
          'save only. One or two lines of seeding context, enough ' +
          'to raise the question naturally later ("Planned a ' +
          'ricotta lasagna for Saturday dinner").',
      },
      relevant_after: {
        type: ['string', 'null'],
        description:
          'save only. Optional ISO date or timestamp (e.g. ' +
          '"2026-07-06"). The follow-up becomes worth raising ' +
          'proactively after this moment - set it just AFTER the ' +
          'event. Omit when no date is known. On revise: a string ' +
          'reschedules (resetting the ask-cooldown), null clears ' +
          'the date, omit to leave unchanged.',
      },
      resolution: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description:
          'close only (required). One line on what the answer was.',
      },
    },
    required: ['op'],
    // Per-op required fields - flat JSON Schema cannot express them
    // (only the discriminator is unconditionally required). Consumed by
    // the edge validator (validateToolArgs) so a compound fumble -
    // wrong op + missing fields - reports everything in one throw.
    // Ops absent from the map keep handler-only validation.
    // PARTIAL map: save's requireds are conditional (question only
    // on create) and list requires nothing - both keep handler-only
    // validation by convention.
    'x-per-op-required': {
      close: ['id', 'resolution'],
      dismiss: ['id'],
    },
    additionalProperties: false,
  },
} as const;
