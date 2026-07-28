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
