/**
 * Schema-only export for upscale_image. The implementation lives
 * function-side (supabase/functions/venice/tools/upscale_image.ts) - the
 * browser ToolDef here is the wire shape only, the same split every
 * image tool uses.
 */
export const upscaleImageSchema = {
  name: 'upscale_image',
  description:
    'Increase the resolution of an image that already exists in this ' +
    'conversation (2x-4x) and attach the result to your reply. Call this ' +
    'when the user asks to upscale, enlarge, or sharpen a picture they ' +
    'uploaded or one you generated earlier. `filename` must come from ' +
    'the <thread_attachments> list - never invent one. Large sources can ' +
    'refuse high scales (the result would exceed the attachment storage ' +
    'limit) - the error tells you what scale fits. Edit BEFORE upscaling: ' +
    'an upscaled image can be too large to edit afterward.',
  shortDescription: 'upscale an existing image 2x-4x',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description:
          'Exact filename of the image to upscale, from <thread_attachments>.',
      },
      scale: {
        type: 'number',
        enum: [2, 3, 4],
        description:
          'Optional magnification factor. Defaults to 2. Scales above 2 ' +
          'bill at a higher rate and can refuse on large sources.',
      },
    },
    required: ['filename'],
    additionalProperties: false,
  },
} as const;
