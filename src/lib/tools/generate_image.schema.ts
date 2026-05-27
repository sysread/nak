/**
 * Schema-only export for generate_image. Impl lives in `./generate_image`.
 *
 * Kept separate from the impl so the registry can ship the tool's
 * wire shape eagerly while the implementation (which pulls the Venice
 * image endpoint) loads lazily on first dispatch - same split every
 * gated tool uses.
 */
export const generateImageSchema = {
  name: 'generate_image',
  description:
    'Generate an image from a text description and attach it to your ' +
    'reply. Call this when the user asks you to draw, create, paint, ' +
    'render, or otherwise produce a picture. Write `prompt` as a rich, ' +
    'concrete visual description (subject, setting, lighting, style, ' +
    'composition) - the more specific the better. Optional ' +
    '`negative_prompt` lists what to keep out; `style_preset` applies a ' +
    'named aesthetic; `aspect_ratio` picks the frame shape. The image is ' +
    'attached to the message you send after this call - do NOT paste ' +
    'base64 or a URL into your reply, just describe what you made. The ' +
    'returned filename can be handed to analyze_image later if the user ' +
    'wants to inspect or iterate on it.',
  shortDescription: 'generate an image from a text prompt',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'Rich visual description of the image to generate. Name the ' +
          'subject, setting, lighting, mood, and art style.',
      },
      negative_prompt: {
        type: 'string',
        description:
          'Optional. Elements to exclude from the image (e.g. "text, ' +
          'watermark, blurry").',
      },
      style_preset: {
        type: 'string',
        description:
          'Optional named aesthetic, e.g. "Photographic", "Anime", ' +
          '"3D Model", "Cinematic", "Comic Book".',
      },
      aspect_ratio: {
        type: 'string',
        enum: ['1:1', '16:9', '9:16', '4:3', '3:4'],
        description:
          'Optional frame shape. Defaults to "1:1" (square) when omitted.',
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
} as const;
