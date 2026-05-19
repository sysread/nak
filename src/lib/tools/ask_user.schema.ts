/**
 * Schema-only export for ask_user. Impl lives in `./ask_user`.
 *
 * The tool poses a multiple-choice clarifying question. Unlike every
 * other tool in the catalog, its "result" is supplied by the user, not
 * computed by code - the chat-loop suspends after this call lands and
 * waits for a UI-provided answer before resuming. See `./ask_user.ts`
 * for the sentinel/answer wire shapes and `src/lib/chat-loop.ts` for
 * how the loop drives the suspend/resume cycle.
 *
 * Constants exported so the impl, the UI card, and tests share one
 * source of truth on option-count bounds and content length caps.
 */
export const ASK_USER_MIN_OPTIONS = 2;
export const ASK_USER_MAX_OPTIONS = 4;
// Caps the model can blow through if it gets verbose. The UI wraps
// freely, but a 500-word "option" defeats the point of the chip
// affordance - if the model wants prose, it should write prose, not
// stuff it into a multiple-choice option.
export const ASK_USER_QUESTION_MAX_CHARS = 240;
export const ASK_USER_LABEL_MAX_CHARS = 60;
export const ASK_USER_DESCRIPTION_MAX_CHARS = 200;

export const askUserSchema = {
  name: 'ask_user',
  description:
    'Ask the user a clarifying multiple-choice question instead of ' +
    'guessing their intent. Use when the request is genuinely ' +
    'ambiguous and the wrong branch would waste a long answer. ' +
    'Provide a short question and 2-4 short options; the UI ' +
    'automatically adds an "Other" free-form escape so the user ' +
    'can answer outside the options if needed. ' +
    'Do NOT use for trivial confirmations, for chitchat, or when a ' +
    'sensible default exists. Do NOT use as a stalling tactic - only ' +
    'ask when the answer materially changes what you would say next. ' +
    'After this call the conversation pauses until the user answers; ' +
    'their answer arrives as the tool result on the next round, with ' +
    'a `via` field naming whether they picked an option or typed ' +
    'free-form text. Do not call any other tool in the same round as ' +
    'ask_user unless its result would inform the question itself.',
  shortDescription: 'ask a multiple-choice clarifying question',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        minLength: 1,
        maxLength: ASK_USER_QUESTION_MAX_CHARS,
        description:
          'The clarifying question, addressed to the user in plain ' +
          'second person. One sentence. No preamble like "I have a ' +
          'question:" - just the question itself.',
      },
      options: {
        type: 'array',
        minItems: ASK_USER_MIN_OPTIONS,
        maxItems: ASK_USER_MAX_OPTIONS,
        description:
          `Between ${ASK_USER_MIN_OPTIONS} and ${ASK_USER_MAX_OPTIONS} ` +
          'distinct answers the user is most likely to want. Order ' +
          'matters: put the answer you think the user most likely ' +
          'wants first. The UI adds an "Other" escape automatically; ' +
          'do not include one yourself.',
        items: {
          type: 'object',
          properties: {
            label: {
              type: 'string',
              minLength: 1,
              maxLength: ASK_USER_LABEL_MAX_CHARS,
              description:
                'Short label (under 6 words). Shown as the chip text.',
            },
            description: {
              type: 'string',
              minLength: 1,
              maxLength: ASK_USER_DESCRIPTION_MAX_CHARS,
              description:
                'One sentence explaining what choosing this option ' +
                'will mean. Shown under the label inside the chip; ' +
                'wraps on narrow viewports so it is never truncated.',
            },
          },
          required: ['label', 'description'],
          additionalProperties: false,
        },
      },
    },
    required: ['question', 'options'],
    additionalProperties: false,
  },
} as const;
