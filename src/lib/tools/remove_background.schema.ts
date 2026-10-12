/**
 * Schema-only export for remove_background. The implementation lives
 * function-side (supabase/functions/venice/tools/remove_background.ts) -
 * the browser ToolDef here is the wire shape only, the same split every
 * image tool uses.
 */
export const removeBackgroundSchema = {
  name: 'remove_background',
  description:
    'Cut the subject out of an image that already exists in this ' +
    'conversation, producing a transparent PNG, and attach the result ' +
    'to your reply. Call this when the user asks to remove the ' +
    'background, isolate the subject, or make a sticker/cutout from a ' +
    'picture they uploaded or one you generated earlier. `filename` ' +
    'must come from the <thread_attachments> list - never invent one.',
  shortDescription: 'remove the background of an existing image',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description:
          'Exact filename of the image to cut out, from <thread_attachments>.',
      },
    },
    required: ['filename'],
    additionalProperties: false,
  },
} as const;
