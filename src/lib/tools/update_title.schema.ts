/**
 * Schema-only export for update_title. Impl lives in
 * `./update_title`. The TITLE_MAX_CHARS constant is also re-imported
 * by the impl so the sanitiser uses the same cap the schema
 * advertises to the model.
 */
export const TITLE_MAX_CHARS = 80;

export const updateTitleSchema = {
  name: 'update_title',
  description:
    'Rename the current conversation. Call this when the topic has ' +
    'meaningfully shifted from the current title, or on the first turn ' +
    'when the title is still the default placeholder. Pass a concise ' +
    '3-6 word title describing the real topic of the conversation. ' +
    'No trailing punctuation, no quotes, plain text.',
  shortDescription: 'rename this conversation',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        minLength: 1,
        maxLength: TITLE_MAX_CHARS,
        description:
          'New 3-6 word title. No trailing punctuation, no quotes, plain text.',
      },
    },
    required: ['title'],
    additionalProperties: false,
  },
} as const;
