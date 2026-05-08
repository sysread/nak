/**
 * Schema-only export for analyze_image. Impl lives in
 * `./analyze_image`.
 */
export const analyzeImageSchema = {
  name: 'analyze_image',
  description:
    'Analyze an image that has been attached anywhere in the current ' +
    'conversation by sending it to a vision-capable model with a ' +
    'focused query. Use this when you need to see an image to answer. ' +
    'The `<thread_attachments>` system block lists every available ' +
    'filename. Takes `filename` (must match exactly, case-sensitive) ' +
    'and `query` (what to look for or extract — phrase as a direct ' +
    'instruction to the vision model, e.g. "What text appears in this ' +
    'image?" or "Describe the layout of this diagram."). Returns the ' +
    "vision model's plain-text answer.",
  shortDescription: 'analyze any image in the conversation via vision model',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description:
          'Filename of the image to analyze, exactly as listed in the ' +
          '`<thread_attachments>` block (case-sensitive). Images from ' +
          'any prior turn of this conversation are reachable, not just ' +
          'the most recent user message.',
      },
      query: {
        type: 'string',
        description:
          'What to extract or describe. Phrase as a direct question or ' +
          'instruction — e.g. "What text appears in this image?" or ' +
          '"Describe the layout of this diagram."',
      },
    },
    required: ['filename', 'query'],
    additionalProperties: false,
  },
} as const;
