// edit_image (function-side)
//
// One Venice prompt-driven edit of an image already in the thread - a
// photo the user uploaded, or a picture an earlier turn produced. Result
// rides the same __generated_image envelope as generate_image, so the
// orchestrator attaches it to the round's assistant row with no
// orchestrator changes. The model-visible note tells the model the image
// is attached and it should describe the result in prose.
//
// The edit model is the user's configured profiles.settings.editModel
// (Settings picker, ?type=inpaint catalog), else the mirrored default
// below. Keep in sync with DEFAULT_EDIT_IMAGE_MODEL in src/lib/models/index.ts
// (this file can't import from src/lib).

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { readPriceCaps, readVeniceKey } from './_venice_key.ts';
import { assertEditModelWithinCap } from '../../_shared/price-cap.ts';
import { veniceEditImage } from '../../_shared/venice.ts';
import {
  assertResultStorable,
  attachmentObjectAsBase64,
  buildImageOpResult,
  findImageAttachmentByFilename,
  mintImageFilename,
} from './_image_ops.ts';

/** Fallback edit model when the user hasn't configured one. */
const DEFAULT_EDIT_IMAGE_MODEL = 'firered-image-edit';

/**
 * Resolve the edit-model id for this user: their configured
 * profiles.settings.editImageModel, else DEFAULT_EDIT_IMAGE_MODEL. Total
 * and defensive - any read failure or malformed value degrades to the
 * default rather than failing the edit, since a missing preference should
 * never block an image op. The Settings picker only writes ids the live
 * Venice inpaint catalog advertised.
 */
async function resolveEditImageModel(ctx: ToolContext): Promise<string> {
  try {
    const { data } = await ctx.adminClient
      .from('profiles')
      .select('settings')
      .eq('user_id', ctx.userId)
      .maybeSingle();
    const configured = (data?.settings as { editImageModel?: unknown } | null)?.editImageModel;
    if (typeof configured === 'string' && configured.length > 0) return configured;
  } catch {
    // Settings read failed (transient DB error, etc.) - fall back to the
    // default model rather than aborting the user's edit.
  }
  return DEFAULT_EDIT_IMAGE_MODEL;
}

export const editImage: ToolDef = {
  name: 'edit_image',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const filename = typeof args.filename === 'string' ? args.filename.trim() : '';
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!filename) throw new Error('edit_image requires a non-empty `filename` argument');
    if (!prompt) throw new Error('edit_image requires a non-empty `prompt` argument');

    const apiKey = await readVeniceKey(ctx.adminClient);
    if (!apiKey) {
      throw new Error('no Venice key configured (app_config unseeded)');
    }

    const model = await resolveEditImageModel(ctx);

    // Enforce the project-global per-image price cap (app_config.max_image_usd)
    // against the edit model's per-edit price - the same backstop the
    // generate_image tool runs; the Settings picker hides over-cap models,
    // this catches a stale selection.
    await assertEditModelWithinCap({
      model,
      apiKey,
      caps: await readPriceCaps(ctx.adminClient),
    });

    const source = await findImageAttachmentByFilename(ctx, filename, 'edit_image');
    if (!source.storage_path) {
      throw new Error(`Image "${filename}" has expired and its data is no longer available.`);
    }
    const { base64, mimeType: sourceMime } = await attachmentObjectAsBase64(
      ctx.adminClient,
      source.storage_path,
      source.mime_type,
      `Image "${source.filename}"`
    );

    const result = await veniceEditImage({
      apiKey,
      model,
      prompt,
      image: `data:${sourceMime};base64,${base64}`,
      signal: ctx.signal,
    });

    // Post-hoc size guard: an oversized result can't be stored, and the
    // model must learn that from the tool result, not from a card that
    // never resolves.
    assertResultStorable(result.imageBase64);

    const out = buildImageOpResult({
      filename: mintImageFilename('edited', result.mimeType.split('/')[1] ?? 'webp'),
      mimeType: result.mimeType,
      imageBase64: result.imageBase64,
      note:
        'Image edited and attached to your reply. Describe the change to the user in words; ' +
        'do not paste base64 or a URL. Reference it by filename if they want to iterate again.',
    });
    return out;
  },
};

registerTool(editImage);
