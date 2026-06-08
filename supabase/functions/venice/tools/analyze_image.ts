// analyze_image (function-side - the live implementation)
//
// Vision-tier sub-completion against an image attachment in the
// current thread. Wire schema lives in
// src/lib/tools/analyze_image.schema.ts; the browser ToolDef of the
// same name is schema-only (it advertises the tool to the model via
// buildToolList) and never executes - dispatch happens here, in the
// streaming function's performToolCall.
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

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { readVeniceKey } from './_venice_key.ts';
import { toolComplete } from './_venice_complete.ts';

// analyze_image runs its query against the primary vision model first
// and retries once against the uncensored fallback on any failure.
//
// Primary - e2ee-qwen3-vl-30b-a3b-p: 128k context, native vision, no
// reasoning. The stricter content posture, used for the common case.
//
// Fallback - venice-uncensored-1-2: same vision wire contract, but
// permissive. The motivating case is Venice's content-safety filter
// spuriously rejecting an innocuous photo (a loaf of home-baked bread
// tripped it); the uncensored model describes it without the block.
//
// These ids mirror MODELS entries in src/lib/models/index.ts but are
// duplicated here because the edge function is a Deno island and can't
// import from src/lib (see supabase/functions/README.md).
const PRIMARY_VISION_MODEL = 'e2ee-qwen3-vl-30b-a3b-p';
const FALLBACK_VISION_MODEL = 'venice-uncensored-1-2';

interface AttachmentRow {
  id: string;
  filename: string;
  storage_path: string | null;
  mime_type: string;
}

/**
 * Run the query against one vision model id. Returns the trimmed
 * answer, or throws when the model returns nothing or truncates. A
 * content-safety rejection from Venice arrives as a thrown VeniceError
 * out of toolComplete and propagates straight out; execute() catches
 * both shapes the same way and routes to the fallback model.
 */
async function runVision(
  apiKey: string,
  model: string,
  query: string,
  imageUrl: string,
  filename: string,
): Promise<string> {
  const result = await toolComplete({
    apiKey,
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: query },
          { type: 'image_url', image_url: { url: imageUrl } },
        ] as unknown as string,
      },
    ],
    maxTokens: 8196,
  });

  const trimmed = result.text.trim();
  if (trimmed.length === 0) {
    throw new Error(
      `Vision model ${model} returned no text for "${filename}" (finish_reason=${result.finishReason ?? 'null'}). ` +
        'Usually a transient provider blip - retry, or describe to the user that the image analysis failed.',
    );
  }
  if (result.finishReason !== 'stop') {
    throw new Error(
      `Vision model ${model} returned truncated output for "${filename}" (finish_reason=${result.finishReason ?? 'null'}). ` +
        'Retry, or describe to the user that the image analysis failed.',
    );
  }
  return trimmed;
}

export const analyzeImage: ToolDef = {
  name: 'analyze_image',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const filename = typeof args.filename === 'string' ? args.filename.trim() : '';
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!filename) throw new Error('analyze_image requires a non-empty `filename` argument');
    if (!query) throw new Error('analyze_image requires a non-empty `query` argument');

    // Thread-scoped lookup. message_attachments inherits ownership
    // from messages -> threads, and threadId was already validated
    // against userId at /stream entry, so a filter on messages.thread_id
    // is the correct scope.
    //
    // RLS OFF: scoped via parent thread (validated upstream). Join
    // message_attachments to messages so the thread_id check rides
    // on the relationship. Take the most recent matching image.
    const { data, error } = await ctx.adminClient
      .from('message_attachments')
      .select('id, filename, storage_path, mime_type, messages!inner(thread_id)')
      .eq('messages.thread_id', ctx.threadId)
      .eq('filename', filename)
      .like('mime_type', 'image/%')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<AttachmentRow>();
    if (error) throw new Error(`findImageByFilenameInThread failed: ${error.message}`);
    if (!data) throw new Error(`No image attachment named "${filename}" in this thread.`);
    if (!data.storage_path) {
      throw new Error(`Image "${filename}" has expired and its data is no longer available.`);
    }

    // Download the bytes and inline them as a base64 data URL. Earlier
    // shape signed a public URL and let Venice fetch it server-side
    // (cheaper bandwidth, parallel fetch). Two failure modes drove the
    // unconditional inline:
    //   - Local dev: the signed URL points at 127.0.0.1:54321 (or
    //     internal Docker hostnames like kong:8000 inside the edge
    //     runtime container) which Venice cannot reach from the public
    //     internet. The vision API returns "Supplied image did not
    //     pass validation checks."
    //   - "Is this URL public?" turns out to be hard to answer
    //     reliably from inside the function - SUPABASE_URL reflects
    //     the container's view, not the public endpoint - and that's
    //     the wrong thing to base a "fall back to inline" decision on
    //     anyway. Always inlining removes the environment-detection
    //     class of bugs entirely.
    // Cost: ~33% payload bloat from base64 encoding (well under the
    // 25 MB Venice cap for any image the user is likely to generate
    // or upload) plus the function downloading-then-forwarding instead
    // of Venice fetching directly. Worth it for the reliability.
    const { data: blob, error: dlErr } = await ctx.adminClient.storage
      .from('attachments')
      .download(data.storage_path);
    if (dlErr || !blob) {
      throw new Error(`Image "${filename}" could not be downloaded for analysis. Try again.`);
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    const imageUrl = `data:${data.mime_type};base64,${base64}`;

    const apiKey = await readVeniceKey(ctx.adminClient);
    if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

    // Primary vision model first, falling back once to the permissive
    // uncensored model on any failure. Failure-agnostic on purpose: a
    // content block arrives as either a thrown VeniceError (HTTP 4xx
    // from veniceComplete) or a non-stop finish_reason indistinguishable
    // from an ordinary truncation, so we can't match on it. Any primary
    // failure routes to the fallback; a genuinely-transient primary
    // failure just costs one extra sub-call on the other model.
    try {
      return { answer: await runVision(apiKey, PRIMARY_VISION_MODEL, query, imageUrl, filename) };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(
        `[analyze_image] primary ${PRIMARY_VISION_MODEL} failed for "${filename}": ${detail}; falling back to ${FALLBACK_VISION_MODEL}`,
      );
      // Fallback. If this also throws, the error propagates to the
      // model so it can apologise / describe the failure rather than
      // relaying a partial answer as if it were real. The model-facing
      // retry guidance rides on runVision's thrown message.
      return { answer: await runVision(apiKey, FALLBACK_VISION_MODEL, query, imageUrl, filename) };
    }
  },
};

registerTool(analyzeImage);
