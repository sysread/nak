// analyze_image (function-side - the live implementation)
//
// Vision-tier sub-completion against an image attachment in the
// current thread. Wire schema lives in
// src/lib/tools/analyze_image.schema.ts; the browser ToolDef of the
// same name is schema-only (it advertises the tool to the model via
// buildToolList) and never executes - dispatch happens here, in the
// streaming function's performToolCall.
//
// The vision sub-call is shared with analyze_pdf_page in ./_vision.ts.
// The attachment lookup (thread-scoped by filename, miss diagnostics,
// expired-storage branch) is shared with the image-op tools
// (edit_image, upscale_image, remove_background) in ./_image_ops.ts -
// the diagnostics render byte-identical to this tool's own historical
// wording because the tests pin it.
//
// Simplifications vs a browser dispatch:
// - One attempt per model (no 3x empty/truncated retry loop).
//   Empty/truncated surfaces as a tool error and the model can
//   retry at its own discretion.
// - Miss diagnostic doesn't enumerate live filenames in the thread;
//   the standard <thread_attachments> system block already advertises
//   what's available.
//
// Auth: b-strict. The attachment lookup joins message_attachments
// to messages and filters by user via the thread relationship,
// which the orchestrator's threadId already validated at /stream
// entry.

import { registerTool, type ToolDef } from '../performToolCall.ts';
import { readVeniceKey } from './_venice_key.ts';
import { askVision, attachmentObjectAsDataUrl } from './_vision.ts';
import { findImageAttachmentByFilename } from './_image_ops.ts';

export const analyzeImage: ToolDef = {
  name: 'analyze_image',
  async execute(args: Record<string, unknown>, ctx) {
    const filename = typeof args.filename === 'string' ? args.filename.trim() : '';
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!filename) throw new Error('analyze_image requires a non-empty `filename` argument');
    if (!query) throw new Error('analyze_image requires a non-empty `query` argument');

    const data = await findImageAttachmentByFilename(ctx, filename, 'analyze_image');
    if (!data.storage_path) {
      throw new Error(`Image "${filename}" has expired and its data is no longer available.`);
    }

    const imageUrl = await attachmentObjectAsDataUrl(
      ctx.adminClient,
      data.storage_path,
      data.mime_type,
      `Image "${data.filename}"`,
    );

    const apiKey = await readVeniceKey(ctx.adminClient);
    if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

    return { answer: await askVision(apiKey, query, imageUrl, `"${data.filename}"`) };
  },
};

registerTool(analyzeImage);
