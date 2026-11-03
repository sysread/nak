// image (function-side combination tool)
//
// One tool behind an `op` enum discriminator: generate / edit /
// upscale / remove_bg. Replaces the four verb registrations
// (generate_image, edit_image, upscale_image, remove_background);
// the per-op bodies survive verbatim as internal functions - only
// the envelope changed (see the browser schema's header).
//
// Every op hands its image to the orchestrator through the
// __generated_image envelope, which attaches the bytes to the
// round's assistant row as a message_attachments row and strips the
// heavy payload before the result is persisted - the model sees only
// the compact descriptor. The harvest is structural (keyed on the
// result envelope, not the tool name), so the combo needs no
// orchestrator changes.
//
// generate: the base64 image does NOT go into the model-visible
// result. What the model sees back is the descriptor (filename +
// dimensions), enough to reference the image with analyze_image on
// a later turn.
//
// edit: the edit model is the user's configured
// profiles.settings.editImageModel (Settings picker, ?type=inpaint
// catalog), else the mirrored default below. Keep in sync with
// DEFAULT_EDIT_IMAGE_MODEL in src/lib/models/index.ts (this file
// can't import from src/lib).
//
// upscale: output-size hazard the other image ops don't share -
// Venice returns an unbounded PNG (4x of a 2048px upload is 8192px,
// tens of MB), the attachments bucket rejects over-50MiB files, and
// the attach step swallows upload failures. So this op guards twice:
// a pre-flight header decode that refuses a bound-to-fail scale
// BEFORE Venice is paid, and the shared post-hoc byte check on the
// returned bytes.
//
// remove_bg: fixed `bria-bg-remover` model (the endpoint takes no
// model field). No price-cap check: bria-bg-remover is not in any
// Venice /models catalog slice, so it is unpriceable, and the cap
// posture fails open for unpriceable models (see _shared/price-cap.ts).
//
// Per-op required fields (prompt on generate/edit, filename on the
// three source ops) are enforced inside the per-op bodies below -
// the flat wire schema cannot express them.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { readPriceCaps, readVeniceKey } from './_venice_key.ts';
import {
  assertEditModelWithinCap,
  assertImageModelWithinCap,
  assertUpscaleModelWithinCap,
} from '../../_shared/price-cap.ts';
import { isBlockedModelId } from '../../_shared/blocked-models.ts';
import {
  veniceEditImage,
  veniceGenerateImage,
  veniceRemoveBackground,
  veniceUpscaleImage,
} from '../../_shared/venice.ts';
import { GENERATED_IMAGE_RESULT_KEY, base64ToBytes } from './_generated_image.ts';
import {
  assertResultStorable,
  attachmentObjectAsBase64,
  buildImageOpResult,
  findImageAttachmentByFilename,
  mintImageFilename,
  upscalePreFlightMessage,
} from './_image_ops.ts';

// Fallback image model when the user hasn't configured one. Mirror of
// VENICE_DEFAULT_IMAGE_MODEL in src/lib/models/index.ts (this file can't
// import from src/lib) - keep the two in sync. The user's override, if
// any, lives in profiles.settings.imageModel and is read per-call by
// resolveImageModel below.
const DEFAULT_IMAGE_MODEL = 'venice-sd35';

/** Fallback edit model when the user hasn't configured one. */
const DEFAULT_EDIT_IMAGE_MODEL = 'firered-image-edit';

/**
 * Resolve the text-to-image model id for this user: their configured
 * profiles.settings.imageModel, else DEFAULT_IMAGE_MODEL. Total and
 * defensive - any read failure or malformed value degrades to the
 * default rather than failing the generation, since a missing preference
 * should never block an image. The Settings picker only ever writes ids
 * the live Venice image catalog advertised, so no capability check is
 * needed here. A stored id the blocked-model policy forbids
 * (../../_shared/blocked-models.ts) reads as unset and the default
 * serves; the /image-generate route guard covers the direct path.
 */
async function resolveImageModel(ctx: ToolContext): Promise<string> {
  try {
    const { data } = await ctx.adminClient
      .from('profiles')
      .select('settings')
      .eq('user_id', ctx.userId)
      .maybeSingle();
    const configured = (data?.settings as { imageModel?: unknown } | null)?.imageModel;
    if (
      typeof configured === 'string' &&
      configured.length > 0 &&
      !isBlockedModelId(configured)
    ) {
      return configured;
    }
  } catch {
    // Settings read failed (transient DB error, etc.) - fall back to the
    // default model rather than aborting the user's image request.
  }
  return DEFAULT_IMAGE_MODEL;
}

/**
 * Resolve the edit-model id for this user: their configured
 * profiles.settings.editImageModel, else DEFAULT_EDIT_IMAGE_MODEL. Total
 * and defensive - any read failure or malformed value degrades to the
 * default rather than failing the edit, since a missing preference should
 * never block an image op. The Settings picker only writes ids the live
 * Venice inpaint catalog advertised. A stored id the blocked-model
 * policy forbids (../../_shared/blocked-models.ts) reads as unset and
 * the default serves.
 */
async function resolveEditImageModel(ctx: ToolContext): Promise<string> {
  try {
    const { data } = await ctx.adminClient
      .from('profiles')
      .select('settings')
      .eq('user_id', ctx.userId)
      .maybeSingle();
    const configured = (data?.settings as { editImageModel?: unknown } | null)?.editImageModel;
    if (
      typeof configured === 'string' &&
      configured.length > 0 &&
      !isBlockedModelId(configured)
    ) {
      return configured;
    }
  } catch {
    // Settings read failed (transient DB error, etc.) - fall back to the
    // default model rather than aborting the user's edit.
  }
  return DEFAULT_EDIT_IMAGE_MODEL;
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

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

async function generateOp(args: Record<string, unknown>, ctx: ToolContext) {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (prompt.length === 0) {
    throw new Error('image (op=generate) requires a non-empty `prompt` argument');
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

  // Enforce the project-global per-image price cap (app_config.max_image_usd,
  // seeded by `mise run setup`). The Settings picker already hides over-cap
  // models, so this is the backstop for a stale selection or an over-cap
  // built-in default; it throws a 403 VeniceError the tool surfaces as an
  // error result. Inert when no image cap is set; fails open on a catalog
  // hiccup. See assertImageModelWithinCap.
  await assertImageModelWithinCap({
    model,
    apiKey,
    caps: await readPriceCaps(ctx.adminClient),
  });

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
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

async function editOp(args: Record<string, unknown>, ctx: ToolContext) {
  const filename = typeof args.filename === 'string' ? args.filename.trim() : '';
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (!filename) throw new Error('image (op=edit) requires a non-empty `filename` argument');
  if (!prompt) throw new Error('image (op=edit) requires a non-empty `prompt` argument');

  const apiKey = await readVeniceKey(ctx.adminClient);
  if (!apiKey) {
    throw new Error('no Venice key configured (app_config unseeded)');
  }

  const model = await resolveEditImageModel(ctx);

  // Enforce the project-global per-image price cap (app_config.max_image_usd)
  // against the edit model's per-edit price - the same backstop the
  // generate op runs; the Settings picker hides over-cap models,
  // this catches a stale selection.
  await assertEditModelWithinCap({
    model,
    apiKey,
    caps: await readPriceCaps(ctx.adminClient),
  });

  const source = await findImageAttachmentByFilename(ctx, filename, 'image (op=edit)');
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
}

// ---------------------------------------------------------------------------
// upscale
// ---------------------------------------------------------------------------

async function upscaleOp(args: Record<string, unknown>, ctx: ToolContext) {
  const filename = typeof args.filename === 'string' ? args.filename.trim() : '';
  const scale = typeof args.scale === 'number' ? args.scale : 2;
  if (!filename) throw new Error('image (op=upscale) requires a non-empty `filename` argument');
  if (scale < 2 || scale > 4 || !Number.isFinite(scale)) {
    throw new Error('image (op=upscale) requires a `scale` of 2, 3, or 4');
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

  const source = await findImageAttachmentByFilename(ctx, filename, 'image (op=upscale)');
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
}

// ---------------------------------------------------------------------------
// remove_bg
// ---------------------------------------------------------------------------

async function removeBgOp(args: Record<string, unknown>, ctx: ToolContext) {
  const filename = typeof args.filename === 'string' ? args.filename.trim() : '';
  if (!filename) {
    throw new Error('image (op=remove_bg) requires a non-empty `filename` argument');
  }

  const apiKey = await readVeniceKey(ctx.adminClient);
  if (!apiKey) {
    throw new Error('no Venice key configured (app_config unseeded)');
  }

  const source = await findImageAttachmentByFilename(ctx, filename, 'image (op=remove_bg)');
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
}

// ---------------------------------------------------------------------------
// combination-tool envelope
// ---------------------------------------------------------------------------

export const image: ToolDef = {
  name: 'image',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const op = typeof args.op === 'string' ? args.op.trim() : '';
    if (!op) {
      throw new Error('op is required (generate | edit | upscale | remove_bg)');
    }
    switch (op) {
      case 'generate':
        return generateOp(args, ctx);
      case 'edit':
        return editOp(args, ctx);
      case 'upscale':
        return upscaleOp(args, ctx);
      case 'remove_bg':
        return removeBgOp(args, ctx);
      default:
        throw new Error(
          `unknown op "${op}" - expected generate, edit, upscale, or remove_bg`,
        );
    }
  },
};

registerTool(image);
