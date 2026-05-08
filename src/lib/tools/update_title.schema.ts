/**
 * Schema-only export for update_title. Impl lives in
 * `./update_title`. TITLE_MAX_CHARS is re-imported by the impl so
 * the sanitiser uses the same cap the schema advertises.
 */
export const TITLE_MAX_CHARS = 80;

export const updateTitleSchema = {
  name: 'update_title',
  description:
    'Rename the current conversation. Call when the topic has ' +
    'meaningfully shifted from the title, or on the first turn when ' +
    'the title is still the default placeholder. 3-6 words, no ' +
    'trailing punctuation, no quotes, plain text.',
  shortDescription: 'rename this conversation',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        minLength: 1,
        maxLength: TITLE_MAX_CHARS,
        description:
          '3-6 word title. No trailing punctuation, no quotes, plain text.',
      },
    },
    required: ['title'],
    additionalProperties: false,
  },
} as const;
