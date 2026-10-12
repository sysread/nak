/**
 * Schema-only export for edit_image. The implementation lives
 * function-side (supabase/functions/venice/tools/edit_image.ts) - the
 * browser ToolDef here is the wire shape only, the same split every
 * image tool uses.
 */
export const editImageSchema = {
  name: 'edit_image',
  description:
    'Edit an image that already exists in this conversation with a text ' +
    'instruction, and attach the edited result to your reply. Call this ' +
    'when the user asks you to change, modify, add to, or remove ' +
    'something from a picture they uploaded or one you generated earlier. ' +
    '`filename` must come from the <thread_attachments> list - never ' +
    'invent one. Write `prompt` as a short, specific instruction naming ' +
    'exactly what to change ("remove the tree", "make the sky a vivid ' +
    'orange sunset"); these edit models want small, concrete edits, not ' +
    'full scene rewrites (keep it under ~1500 characters). The ORIGINAL ' +
    'image is left untouched and the result is attached to the message ' +
    'you send after this call - do NOT paste base64 or a URL into your ' +
    'reply, just describe what changed. You cannot see the source pixels ' +
    'inline; call analyze_image on it first if you need to know what it ' +
    'shows. Edit BEFORE upscaling - an upscaled image can be too large ' +
    'to edit.',
  shortDescription: 'edit an existing image from a text instruction',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description:
          'Exact filename of the image to edit, from <thread_attachments> ' +
          '(uploads, generated images, or previous edits all qualify).',
      },
      prompt: {
        type: 'string',
        description:
          'Short, specific description of the change: name the subject ' +
          'and the exact alteration. One edit per call - chain calls to ' +
          'layer changes.',
      },
    },
    required: ['filename', 'prompt'],
    additionalProperties: false,
  },
} as const;
