/**
 * Schema-only export for `image` - the image combination tool. One
 * tool, one `op` enum discriminator (generate / edit / upscale /
 * remove_bg) with flat per-op parameters, replacing the four
 * generate_image / edit_image / upscale_image / remove_background
 * verb tools. The combo form follows the `skills` precedent (see
 * that schema's header for the calibration record); per-op required
 * fields are enforced in the edge impl
 * (supabase/functions/venice/tools/image.ts).
 *
 * Coupling: src/lib/ui/generated-image.ts's IMAGE_TOOL_NAMES set
 * resolves the dedicated generated-image card by tool NAME - it must
 * list this tool when the combo lands (the per-op envelope is
 * unchanged, so the card itself reads the same result shape).
 *
 * All four ops share one contract: the produced image is attached
 * server-side to the reply and arrives ONLY as a compact descriptor
 * (filename + dimensions) - never paste base64 or a URL into prose.
 * The result filename is resolvable by analyze_image and by later
 * ops' `filename` parameter.
 */

function formatImageArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];
  // The op leads: the detail panel should read what kind of image
  // call this is before any operand.
  if (typeof args.op === 'string' && args.op) {
    lines.push(`**Op:** ${args.op}`);
  }
  if (typeof args.filename === 'string' && args.filename) {
    lines.push(`**Filename:** ${args.filename}`);
  }
  if (typeof args.prompt === 'string' && args.prompt) {
    lines.push(`**Prompt:** ${args.prompt}`);
  }
  if (typeof args.negative_prompt === 'string' && args.negative_prompt) {
    lines.push(`**Negative:** ${args.negative_prompt}`);
  }
  if (typeof args.style_preset === 'string' && args.style_preset) {
    lines.push(`**Style:** ${args.style_preset}`);
  }
  if (typeof args.aspect_ratio === 'string' && args.aspect_ratio) {
    lines.push(`**Aspect:** ${args.aspect_ratio}`);
  }
  if (typeof args.scale === 'number') {
    lines.push(`**Scale:** ${args.scale}x`);
  }
  return lines.join('\n');
}

export const imageSchema = {
  name: 'image',
  description:
    'Create or transform images. Every call MUST carry `op` - it is ' +
    'the first argument, always. One tool, one op. generate: draw ' +
    'from a text description - write the prompt rich and concrete ' +
    '(subject, setting, lighting, style); optional negative_prompt, ' +
    'style_preset, and aspect_ratio shape it. edit: change an image ' +
    'already in this conversation with a short, specific ' +
    'instruction ("remove the tree", "make the sky a vivid orange ' +
    'sunset") - one edit per call, chain calls to layer changes; ' +
    'small concrete edits beat scene rewrites. upscale: increase an ' +
    "existing image's resolution 2x-4x; large sources can refuse " +
    'high scales (the error says what fits). remove_bg: cut the ' +
    'subject out into a transparent PNG. edit / upscale / remove_bg ' +
    "take `filename` from <thread_attachments> - never invent one. " +
    'Edit BEFORE upscaling: an upscaled image can be too large to ' +
    'edit afterward. The ORIGINAL image is left untouched by edit, ' +
    'upscale, and remove_bg; every result is a NEW attachment on ' +
    'your reply. You cannot see image pixels inline; call ' +
    'analyze_image first when you need to know what one shows.',
  shortDescription: 'generate, edit, upscale, or cut out images',
  formatArgs: formatImageArgs,
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['generate', 'edit', 'upscale', 'remove_bg'],
        description:
          'REQUIRED on every call, including the very first image ' +
          'call of a conversation - calls without it are rejected. ' +
          'The operation to run. generate: new image from text. ' +
          'edit: instruct a change to an existing image. upscale: ' +
          'raise the resolution. remove_bg: transparent cutout.',
      },
      prompt: {
        type: 'string',
        description:
          'generate: a rich visual description (subject, setting, ' +
          'lighting, mood, art style) - required. edit: a short, ' +
          'specific change instruction naming the subject and the ' +
          'exact alteration - required.',
      },
      filename: {
        type: 'string',
        description:
          'edit / upscale / remove_bg. Exact filename of the source ' +
          'image, from <thread_attachments> (uploads, generated ' +
          'images, or previous results all qualify). Required.',
      },
      negative_prompt: {
        type: 'string',
        description:
          'generate only, optional. Elements to exclude (e.g. "text, ' +
          'watermark, blurry").',
      },
      style_preset: {
        type: 'string',
        description:
          'generate only, optional. A named aesthetic, e.g. ' +
          '"Photographic", "Anime", "3D Model", "Cinematic".',
      },
      aspect_ratio: {
        type: 'string',
        enum: ['1:1', '16:9', '9:16', '4:3', '3:4'],
        description:
          'generate only, optional. Frame shape; defaults to "1:1".',
      },
      scale: {
        type: 'number',
        enum: [2, 3, 4],
        description:
          'upscale only, optional. Magnification factor; defaults ' +
          'to 2. Scales above 2 bill at a higher rate and can ' +
          'refuse on large sources.',
      },
    },
    required: ['op'],
    // Per-op required fields - flat JSON Schema cannot express them
    // (only the discriminator is unconditionally required). Consumed by
    // the edge validator (validateToolArgs) so a compound fumble -
    // wrong op + missing fields - reports everything in one throw.
    // Ops absent from the map keep handler-only validation.
    'x-per-op-required': {
      generate: ['prompt'],
      edit: ['filename', 'prompt'],
      upscale: ['filename'], // scale is optional (defaults to 2)
      remove_bg: ['filename'],
    },
    additionalProperties: false,
  },
} as const;
