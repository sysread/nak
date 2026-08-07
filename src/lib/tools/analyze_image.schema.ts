/**
 * Schema-only export for analyze_image. Impl lives in
 * `./analyze_image`.
 */
export const analyzeImageSchema = {
  name: 'analyze_image',
  description:
    'Send an image attached anywhere in the current conversation to a ' +
    'vision-capable model with a focused query. If an attached image ' +
    'is already visible to you inline, answer from what you see ' +
    'instead of calling this tool - it is for images you cannot see. ' +
    'The <thread_attachments> system block lists every available ' +
    "filename (case-sensitive). Phrase query as a direct instruction " +
    "to the vision model (e.g. \"What text appears in this image?\"). " +
    "Returns the vision model's plain-text answer.",
  shortDescription: 'analyze any image in the conversation via vision model',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description:
          'Filename from <thread_attachments> (case-sensitive). Any ' +
          'turn of this conversation is reachable, not just the most ' +
          'recent user message.',
      },
      query: {
        type: 'string',
        description:
          'What to extract or describe, phrased as a direct ' +
          'instruction to the vision model.',
      },
    },
    required: ['filename', 'query'],
    additionalProperties: false,
  },
} as const;
