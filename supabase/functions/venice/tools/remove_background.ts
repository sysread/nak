// remove_background (function-side)
//
// One Venice background removal on an image already in the thread, using
// the fixed `bria-bg-remover` model (the endpoint takes no model field).
// Returns a transparent PNG. Same __generated_image envelope as
// generate_image - the orchestrator attaches it with no orchestrator
// changes.
//
// No price-cap check: bria-bg-remover is not in any Venice /models catalog
// slice, so it is unpriceable, and the cap posture fails open for
// unpriceable models (see _shared/price-cap.ts). The output is still
// size-guarded like every image op.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { readVeniceKey } from './_venice_key.ts';
import { veniceRemoveBackground } from '../../_shared/venice.ts';
import {
  assertResultStorable,
  attachmentObjectAsBase64,
  buildImageOpResult,
  findImageAttachmentByFilename,
  mintImageFilename,
} from './_image_ops.ts';

export const removeBackground: ToolDef = {
  name: 'remove_background',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const filename = typeof args.filename === 'string' ? args.filename.trim() : '';
    if (!filename) {
      throw new Error('remove_background requires a non-empty `filename` argument');
    }

    const apiKey = await readVeniceKey(ctx.adminClient);
    if (!apiKey) {
      throw new Error('no Venice key configured (app_config unseeded)');
    }

    const source = await findImageAttachmentByFilename(ctx, filename, 'remove_background');
    if (!source.storage_path) {
      throw new Error(`Image "${filename}" has expired and its data is no longer available.`);
    }
    const { base64, mimeType: sourceMime } = await attachmentObjectAsBase64(
      ctx.adminClient,
      source.storage_path,
      source.mime_type,
      `Image "${source.filename}"`
    );

    const result = await veniceRemoveBackground({
      apiKey,
      image: `data:${sourceMime};base64,${base64}`,
      signal: ctx.signal,
    });

    assertResultStorable(result.imageBase64);

    return buildImageOpResult({
      filename: mintImageFilename('no-bg', 'png'),
      mimeType: result.mimeType,
      imageBase64: result.imageBase64,
      note:
        'Background removed and the cutout attached to your reply (transparent PNG). ' +
        'Describe the result to the user in words; do not paste base64 or a URL. ' +
        'Reference it by filename if they want to iterate again.',
    });
  },
};

registerTool(removeBackground);
