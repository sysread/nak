// upscale_image (function-side)
//
// One Venice 2x-4x upscale of an image already in the thread, using the
// fixed `upscaler` model (the endpoint takes no model field). Same
// __generated_image envelope as generate_image - the orchestrator attaches
// it with no orchestrator changes.
//
// Upscale has an output-size hazard the other image ops don't: Venice
// returns an unbounded PNG (4x of a 2048px upload is 8192px, tens of MB),
// the attachments bucket rejects over-50MiB files, and the attach step
// swallows upload failures. So this tool guards twice - a pre-flight
// header decode that refuses a bound-to-fail scale BEFORE Venice is paid,
// and the shared post-hoc byte check on the returned bytes. Edit before
// upscaling: an upscaled output can exceed the edit endpoints' input caps.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { readPriceCaps, readVeniceKey } from './_venice_key.ts';
import { assertUpscaleModelWithinCap } from '../../_shared/price-cap.ts';
import { veniceUpscaleImage } from '../../_shared/venice.ts';
import { base64ToBytes } from './_generated_image.ts';
import {
  assertResultStorable,
  attachmentObjectAsBase64,
  buildImageOpResult,
  findImageAttachmentByFilename,
  mintImageFilename,
  upscalePreFlightMessage,
} from './_image_ops.ts';

export const upscaleImage: ToolDef = {
  name: 'upscale_image',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const filename = typeof args.filename === 'string' ? args.filename.trim() : '';
    const scale = typeof args.scale === 'number' ? args.scale : 2;
    if (!filename) throw new Error('upscale_image requires a non-empty `filename` argument');
    if (scale < 2 || scale > 4 || !Number.isFinite(scale)) {
      throw new Error('upscale_image requires a `scale` of 2, 3, or 4');
    }

    const apiKey = await readVeniceKey(ctx.adminClient);
    if (!apiKey) {
      throw new Error('no Venice key configured (app_config unseeded)');
    }

    // The upscaler bills by tier (2x vs 4x), so the cap check needs the
    // requested scale, not a model id.
    await assertUpscaleModelWithinCap({
      scale,
      apiKey,
      caps: await readPriceCaps(ctx.adminClient),
    });

    const source = await findImageAttachmentByFilename(ctx, filename, 'upscale_image');
    if (!source.storage_path) {
      throw new Error(`Image "${filename}" has expired and its data is no longer available.`);
    }
    const { base64 } = await attachmentObjectAsBase64(
      ctx.adminClient,
      source.storage_path,
      source.mime_type,
      `Image "${source.filename}"`
    );

    // Pre-flight: refuse a scale whose output must exceed the storage
    // budget BEFORE spending the Venice call. Returns a message when the
    // attempt is doomed, null when it can proceed.
    const preFlight = upscalePreFlightMessage(base64ToBytes(base64), scale);
    if (preFlight) throw new Error(preFlight);

    const result = await veniceUpscaleImage({
      apiKey,
      // The upscale endpoint rejects data URIs - raw base64 only.
      image: base64,
      scale,
      signal: ctx.signal,
    });

    assertResultStorable(result.imageBase64, scale);

    return buildImageOpResult({
      filename: mintImageFilename('upscaled', 'png'),
      mimeType: result.mimeType,
      imageBase64: result.imageBase64,
      note:
        'Image upscaled and attached to your reply. Describe the result to the user in words; ' +
        'do not paste base64 or a URL. Reference it by filename if they want to iterate again.',
    });
  },
};

registerTool(upscaleImage);
