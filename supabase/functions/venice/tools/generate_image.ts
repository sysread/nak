// generate_image (function-side port)
//
// One Venice text-to-image generation, handed up to the orchestrator
// which attaches the result to the assistant's reply as a
// message_attachments row. Mirror of src/lib/tools/generate_image.ts.
//
// The base64 image does NOT go into the model-visible tool result. It
// rides under GENERATED_IMAGE_RESULT_KEY so the orchestrator can
// harvest it for the DB attach and strip it before encoding the tool-
// result row - a ~700KB base64 blob replayed into context every round
// would be pure waste and the model cannot read pixels from a string
// anyway. What the model sees back is the compact descriptor
// (filename + dimensions), enough to reference the image with
// analyze_image on a later turn.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { readVeniceKey } from './_venice_key.ts';
import { veniceGenerateImage } from '../../_shared/venice.ts';
import { GENERATED_IMAGE_RESULT_KEY } from './_generated_image.ts';

// Fallback image model when the user hasn't configured one. Mirror of
// VENICE_DEFAULT_IMAGE_MODEL in src/lib/models/index.ts (this file can't
// import from src/lib) - keep the two in sync. The user's override, if
// any, lives in profiles.settings.imageModel and is read per-call by
// resolveImageModel below.
const DEFAULT_IMAGE_MODEL = 'venice-sd35';

/**
 * Resolve the text-to-image model id for this user: their configured
 * profiles.settings.imageModel, else DEFAULT_IMAGE_MODEL. Total and
 * defensive - any read failure or malformed value degrades to the
 * default rather than failing the generation, since a missing preference
 * should never block an image. The Settings picker only ever writes ids
 * the live Venice image catalog advertised, so no capability check is
 * needed here.
 */
async function resolveImageModel(ctx: ToolContext): Promise<string> {
  try {
    const { data } = await ctx.adminClient
      .from('profiles')
      .select('settings')
      .eq('user_id', ctx.userId)
      .maybeSingle();
    const configured = (data?.settings as { imageModel?: unknown } | null)?.imageModel;
    if (typeof configured === 'string' && configured.length > 0) return configured;
  } catch {
    // Settings read failed (transient DB error, etc.) - fall back to the
    // default model rather than aborting the user's image request.
  }
  return DEFAULT_IMAGE_MODEL;
}

/**
 * Map an aspect-ratio label to pixel dimensions. Tuned for the default
 * venice-sd35, a pixel-dimensioned model (width/height up to 1280): all
 * pairs stay within the 1280px-per-edge cap and land near a ~1MP budget
 * so generation cost + latency stay comparable across ratios.
 *
 * These dimensions are model-agnostic in the common case - most Venice
 * image models accept this range - but a user-picked model with a tighter
 * cap or a stricter width/height divisor could in principle reject them.
 * v1 of the configurable-image-model feature deliberately keeps one
 * dimension table rather than fetching each model's constraints; if a
 * pick proves incompatible the generation surfaces Venice's error. A
 * per-model constraint lookup is the follow-up if that becomes a real
 * problem.
 */
function dimensionsForAspectRatio(
  ratio: string,
): { width: number; height: number } {
  switch (ratio) {
    case '16:9':
      return { width: 1280, height: 720 };
    case '9:16':
      return { width: 720, height: 1280 };
    case '4:3':
      return { width: 1152, height: 896 };
    case '3:4':
      return { width: 896, height: 1152 };
    case '1:1':
    default:
      return { width: 1024, height: 1024 };
  }
}

/**
 * Byte length of a base64 string (no `data:` prefix). Each 4 base64
 * chars encode 3 bytes; trailing '=' padding shaves 1 or 2 off the
 * tail. Used to populate the attachment row's size_bytes so the
 * message list shows a real file size rather than the inflated base64
 * length.
 */
function base64ByteLength(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

export const generateImage: ToolDef = {
  name: 'generate_image',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (prompt.length === 0) {
      throw new Error('generate_image requires a non-empty `prompt` argument');
    }
    const negativePrompt =
      typeof args.negative_prompt === 'string' ? args.negative_prompt.trim() : '';
    const stylePreset =
      typeof args.style_preset === 'string' ? args.style_preset.trim() : '';
    const aspectRatio =
      typeof args.aspect_ratio === 'string' ? args.aspect_ratio : '1:1';
    const { width, height } = dimensionsForAspectRatio(aspectRatio);

    const apiKey = await readVeniceKey(ctx.adminClient);
    if (!apiKey) {
      throw new Error('no Venice key configured (app_config unseeded)');
    }

    const model = await resolveImageModel(ctx);

    const result = await veniceGenerateImage({
      apiKey,
      model,
      prompt,
      negativePrompt: negativePrompt || undefined,
      stylePreset: stylePreset || undefined,
      width,
      height,
      format: 'webp',
      // Suppress the Venice watermark - the image is the user's
      // content in their conversation, not Venice marketing. Venice
      // may still force the watermark on plans that do not allow
      // hiding it, in which case this is a silent no-op.
      hideWatermark: true,
    });

    const ext = result.mimeType.split('/')[1] ?? 'webp';
    // Timestamped filename so multiple generations in one thread stay
    // distinguishable and analyze_image's most-recent-by-filename
    // lookup resolves a specific image.
    const filename = `generated-${Date.now()}.${ext}`;
    const size_bytes = base64ByteLength(result.imageBase64);

    return {
      filename,
      width,
      height,
      format: ext,
      // The orchestrator attaches the image to the reply; tell the
      // model so it describes the picture in prose rather than trying
      // to embed it.
      note:
        'Image generated and attached to your reply. Describe it to the user in words; ' +
        'do not paste base64 or a URL. Reference it by filename if they ask to analyze or change it.',
      // Heavy payload harvested + stripped by the orchestrator before
      // this result is persisted / replayed into context.
      [GENERATED_IMAGE_RESULT_KEY]: {
        filename,
        mime_type: result.mimeType,
        data_base64: result.imageBase64,
        size_bytes,
      },
    };
  },
};

registerTool(generateImage);
