/**
 * Image-generation tool. The main model calls this when the user asks
 * for a picture; it runs one Venice text-to-image generation and hands
 * the result up to the chat-loop, which attaches it to the assistant's
 * reply as a `message_attachments` row - the same storage and 30-day
 * retention path user uploads ride.
 *
 * The base64 image does NOT go into the model-visible tool result. It
 * rides under GENERATED_IMAGE_RESULT_KEY (see ./generated-image) so the
 * chat-loop can harvest it for the DB attach and strip it before
 * encoding the tool-result row - a ~700KB base64 blob replayed into
 * context every round would be pure waste and the model can't read
 * pixels from a string anyway. What the model sees back is the compact
 * descriptor (filename + dimensions), enough to reference the image
 * with analyze_image on a later turn.
 *
 * Toolbox scoping: lives in the GATED `images` toolbox, not always-on.
 * Generating an image spends Venice credits and writes a persistent
 * attachment row, so it needs the same deliberate user-or-model gate
 * the cookbook / memory writes use rather than firing on reflex. The
 * model can flip the toolbox on via `toggle_toolbox` once a "draw me X"
 * makes generation the obvious next move.
 */
import type { ToolDef } from './types';
import { VENICE_IMAGE_MODEL } from '../models';
import { createLogger } from '../logger.svelte';
import { generateImageSchema } from './generate_image.schema';
import { GENERATED_IMAGE_RESULT_KEY } from './generated-image';

const log = createLogger('generate-image-tool');

/**
 * Map an aspect-ratio label to pixel dimensions for venice-sd35, which
 * is a pixel-dimensioned model (width/height up to 1280) rather than an
 * aspect-ratio one. Keeping the dimension math here means the tool
 * sends a single width/height pair regardless of the model's native
 * dimension convention, and a model swap only has to update this table.
 * All pairs stay within the 1280px-per-edge cap and land near a ~1MP
 * budget so generation cost and latency stay comparable across ratios.
 */
function dimensionsForAspectRatio(ratio: string): { width: number; height: number } {
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
  ...generateImageSchema,
  async execute(args, ctx) {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (prompt.length === 0) {
      // Throwing routes through chat-loop's encodeToolContent into
      // `{error: "..."}` on the tool-result row, which the model reads
      // next round and can correct (retry with a real prompt).
      throw new Error('generate_image requires a non-empty `prompt` argument');
    }
    const negativePrompt =
      typeof args.negative_prompt === 'string' ? args.negative_prompt.trim() : '';
    const stylePreset =
      typeof args.style_preset === 'string' ? args.style_preset.trim() : '';
    const aspectRatio =
      typeof args.aspect_ratio === 'string' ? args.aspect_ratio : '1:1';
    const { width, height } = dimensionsForAspectRatio(aspectRatio);

    log.info(
      `generating ${width}x${height} image: ${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}`
    );

    let result;
    try {
      result = await ctx.venice.generateImage({
        model: VENICE_IMAGE_MODEL,
        prompt,
        negativePrompt: negativePrompt || undefined,
        stylePreset: stylePreset || undefined,
        width,
        height,
        format: 'webp',
        signal: ctx.signal,
      });
    } catch (err) {
      // Surface the Venice error verbatim into the log drawer before it
      // propagates - the drawer is the only place a power user can see
      // the actual HTTP code / content-violation detail. Without this,
      // "generate_image failed" reaches the drawer with no context.
      const detail = err instanceof Error ? err.message : String(err);
      log.error(`Venice generateImage failed: ${detail}`);
      throw err;
    }

    const ext = result.mimeType.split('/')[1] ?? 'webp';
    // Timestamped filename so multiple generations in one thread stay
    // distinguishable and analyze_image's most-recent-by-filename lookup
    // resolves a specific image.
    const filename = `generated-${Date.now()}.${ext}`;
    const size_bytes = base64ByteLength(result.imageBase64);

    log.info(`done: ${filename} (${size_bytes} bytes)`);

    return {
      filename,
      width,
      height,
      format: ext,
      // The chat-loop attaches the image to the reply; tell the model so
      // it describes the picture in prose rather than trying to embed it.
      note: 'Image generated and attached to your reply. Describe it to the user in words; do not paste base64 or a URL. Reference it by filename if they ask to analyze or change it.',
      // Heavy payload harvested + stripped by the chat-loop before this
      // result is persisted / replayed into context. See ./generated-image.
      [GENERATED_IMAGE_RESULT_KEY]: {
        filename,
        mime_type: result.mimeType,
        data_base64: result.imageBase64,
        size_bytes,
      },
    };
  },
};
