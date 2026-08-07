// Shared plumbing for the tools that put an image in front of a vision
// model: analyze_image (a picture the user attached) and analyze_pdf_page
// (one rasterized page of a PDF). Both need the same two things - bytes out
// of the attachments bucket as a data URL, and a vision sub-completion with
// a fallback - so they live here rather than being duplicated or having one
// tool import the other.

import type { SupabaseClient } from '@supabase/supabase-js';
import { toolComplete } from './_venice_complete.ts';

// Vision queries run against the primary model first and retry once against
// the uncensored fallback on any failure.
//
// Primary - qwen3-vl-235b-a22b: 128k context, native vision, no reasoning,
// multi-image, Venice privacy tier "private" (Venice-hosted, not proxied to
// a third party). The stricter content posture, used for the common case.
// The earlier e2ee-qwen3-vl-30b-a3b-p (Venice's only E2EE-served vision id)
// is deliberately NOT used: measured 2026-08-07 it failed every probe
// (87s connection drop, then repeated 180s+ hangs) while this id answered
// the same query in 5-20s. E2EE serving is not a requirement here - the
// fallback below was never E2EE either.
//
// Fallback - venice-uncensored-1-2: same vision wire contract, but
// permissive. The motivating case is Venice's content-safety filter
// spuriously rejecting an innocuous photo (a loaf of home-baked bread
// tripped it); the uncensored model describes it without the block. Also
// much the faster of the pair (~50 tok/s vs ~14), so a primary timeout
// degrades to a quick answer rather than a second slow one.
//
// These ids mirror MODELS entries in src/lib/models/index.ts but are
// duplicated here because the edge function is a Deno island and can't
// import from src/lib (see supabase/functions/README.md).
const PRIMARY_VISION_MODEL = 'qwen3-vl-235b-a22b';
const FALLBACK_VISION_MODEL = 'venice-uncensored-1-2';

// Per-attempt latency ceiling. Without one, a hung vision upstream runs
// until the turn's 380s wall deadline (WALL_DEADLINE_MS in
// getStreamingResponse.ts) and the user sees the whole turn die with
// "wall timeout" instead of the tool degrading to the fallback model.
// 90s covers the slowest legitimate answer observed on the primary
// (~65s for a ~900-token exhaustive description at ~14 tok/s) with
// headroom, while still leaving most of the wall budget for the
// fallback attempt and the rest of the turn.
const VISION_ATTEMPT_TIMEOUT_MS = 90_000;

/**
 * Download one object from the `attachments` bucket and encode it as a
 * base64 data URL.
 *
 * Inlining rather than handing Venice a signed URL is deliberate, and both
 * reasons are environmental rather than aesthetic:
 *   - Local dev: the signed URL points at 127.0.0.1:54321 (or an internal
 *     Docker hostname like kong:8000 inside the edge runtime container),
 *     which Venice cannot reach from the public internet. The vision API
 *     returns "Supplied image did not pass validation checks."
 *   - "Is this URL public?" is hard to answer reliably from inside the
 *     function - SUPABASE_URL reflects the container's view, not the public
 *     endpoint - and it's the wrong thing to branch on anyway. Always
 *     inlining removes the environment-detection class of bugs entirely.
 *
 * Cost: ~33% payload bloat from base64, plus the function downloading and
 * forwarding instead of Venice fetching directly. Worth it for the
 * reliability.
 */
export async function attachmentObjectAsDataUrl(
  adminClient: SupabaseClient,
  storagePath: string,
  mimeType: string,
  label: string,
): Promise<string> {
  const { data: blob, error } = await adminClient.storage
    .from('attachments')
    .download(storagePath);
  if (error || !blob) {
    throw new Error(`${label} could not be downloaded for analysis. Try again.`);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/**
 * Run the query against one vision model id. Returns the trimmed answer, or
 * throws when the model returns nothing or truncates. A content-safety
 * rejection from Venice arrives as a thrown VeniceError out of toolComplete
 * and propagates straight out; the caller treats both shapes the same way.
 */
async function runOne(
  apiKey: string,
  model: string,
  query: string,
  imageUrl: string,
  label: string,
): Promise<string> {
  // Bound this attempt's wall clock. The abort surfaces as a thrown
  // VeniceError('network') out of toolComplete, which the caller treats
  // like any other failure: primary falls back, fallback propagates.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), VISION_ATTEMPT_TIMEOUT_MS);
  let result;
  try {
    result = await toolComplete({
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
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const trimmed = result.text.trim();
  if (trimmed.length === 0) {
    throw new Error(
      `Vision model ${model} returned no text for ${label} (finish_reason=${result.finishReason ?? 'null'}). ` +
        'Usually a transient provider blip - retry, or describe to the user that the image analysis failed.',
    );
  }
  if (result.finishReason !== 'stop') {
    throw new Error(
      `Vision model ${model} returned truncated output for ${label} (finish_reason=${result.finishReason ?? 'null'}). ` +
        'Retry, or describe to the user that the image analysis failed.',
    );
  }
  return trimmed;
}

/**
 * Ask a vision model about an image, primary model first, falling back once
 * to the permissive uncensored model on any failure.
 *
 * Failure-agnostic on purpose: a content block arrives as either a thrown
 * VeniceError (HTTP 4xx from veniceComplete) or a non-stop finish_reason
 * indistinguishable from an ordinary truncation, so we can't match on it.
 * Any primary failure routes to the fallback; a genuinely-transient primary
 * failure just costs one extra sub-call on the other model. If the fallback
 * also throws, the error propagates to the model so it can apologise or
 * describe the failure rather than relaying a partial answer as if it were
 * real.
 *
 * `label` is what the user would call this image ("photo.png", "page 3 of
 * report.pdf"); it only ever appears in error text.
 */
export async function askVision(
  apiKey: string,
  query: string,
  imageUrl: string,
  label: string,
): Promise<string> {
  try {
    return await runOne(apiKey, PRIMARY_VISION_MODEL, query, imageUrl, label);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(
      `[vision] primary ${PRIMARY_VISION_MODEL} failed for ${label}: ${detail}; falling back to ${FALLBACK_VISION_MODEL}`,
    );
    return await runOne(apiKey, FALLBACK_VISION_MODEL, query, imageUrl, label);
  }
}
