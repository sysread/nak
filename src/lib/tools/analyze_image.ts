/**
 * Image-analysis tool. The main model delegates visual inspection of
 * any image attached anywhere in the current thread to a dedicated
 * vision model (`agentModel('visionAnalysis').id`; see AGENT_MODELS
 * in src/lib/models). Non-vision tiers rely on this tool exclusively;
 * vision tiers can still call it when they want a focused query
 * against a specific filename rather than reading the inlined
 * image_url part on the user turn.
 *
 * Lookup is thread-scoped, not message-scoped. The earlier design read
 * `ctx.attachments` (the just-attached user message's images only),
 * which left the model unable to re-analyze an image as soon as the
 * user typed any follow-up message. The DB query here joins
 * `message_attachments` against `messages.thread_id` so any image the
 * user attached during this conversation is reachable by filename.
 * RLS continues to enforce per-user isolation on every row touched.
 *
 * Why a tool rather than unconditional pre-analysis: pre-analyzing
 * every image burns a vision call even when the user's question could
 * be answered from extracted text or conversation context. The tool
 * path lets the model call analyze_image() only when it actually needs
 * to look at the pixels, and it phrases the query based on what the
 * user asked so the vision model returns something focused.
 *
 * The available filenames are advertised to the model on every turn
 * via the `<thread_attachments>` system block built in chat-loop, so a
 * filename mismatch is rare. The fallback diagnostic on a miss still
 * lists the live image filenames in the thread so the model can retry
 * with the right one rather than giving up.
 */

import type { ToolDef } from './types';
import type { VeniceMessage } from '../venice';
import { agentModel } from '../models';
import { createLogger } from '../logger.svelte';
import { analyzeImageSchema } from './analyze_image.schema';

const log = createLogger('analyze-image-tool');

// Max attempts (initial + retries) for the vision sub-call. The
// non-streaming completion endpoint occasionally comes back with an
// empty body (provider blip - the choice carries no content) or with
// finish_reason='length' when a dense photo's description runs past the
// maxTokens cap mid-sentence. Three attempts is the same shape the
// streaming chat path uses for its rate-limit retries and is enough
// that a single transient blip doesn't surface to the user as a failed
// analysis.
const MAX_VISION_ATTEMPTS = 3;

/**
 * Detect a vision sub-completion that ended before the model finished.
 *
 * analyze_image calls the non-streaming completion endpoint
 * (`SupabaseService.complete`), so the response is a single atomic JSON
 * body and its `finish_reason` is authoritative - there is no SSE
 * stream that could close mid-clause behind the provider's back. That
 * makes finish_reason the only truncation signal we need:
 *
 *   - 'stop' -> the model emitted its end token; the response is
 *     complete however it ends. We deliberately do NOT inspect the text
 *     tail: text-heavy images (transcriptions, numbered lists, markdown
 *     tables) legitimately end on a list item or table cell with no
 *     trailing punctuation - e.g. a 42-item readout ending on
 *     "...42. I embrace the All". A "must end on terminal punctuation"
 *     check would false-flag those complete responses as truncated and
 *     burn every retry before throwing, turning a perfect transcription
 *     into a "the image analysis failed" error.
 *   - 'length' -> hit the maxTokens cap mid-output; genuinely truncated.
 *   - null / 'content_filter' / 'error' / any other value -> the
 *     provider aborted rather than completed.
 *
 * Returns a short reason string for the log drawer when truncated, or
 * null when the response looks complete. The empty-body case is handled
 * separately by the caller.
 */
function detectTruncation(finishReason: string | null): string | null {
  if (finishReason === null) {
    return 'no finish_reason in response';
  }
  if (finishReason !== 'stop') {
    return `finish_reason=${finishReason}`;
  }
  return null;
}

export const analyzeImage: ToolDef = {
  ...analyzeImageSchema,
  async execute(args, ctx) {
    const filename = typeof args.filename === 'string' ? args.filename.trim() : '';
    const query = typeof args.query === 'string' ? args.query.trim() : '';

    if (filename.length === 0) {
      throw new Error('analyze_image requires a non-empty `filename` argument');
    }
    if (query.length === 0) {
      throw new Error('analyze_image requires a non-empty `query` argument');
    }

    // Thread-scoped lookup: returns the most recent image with this
    // filename anywhere in the conversation, regardless of expiry. We
    // distinguish "not found" from "expired" below so the model gets a
    // useful diagnostic on a miss rather than a generic "no image"
    // message. RLS scopes the query to the signed-in user's threads.
    const attachment = await ctx.supabase.findImageByFilenameInThread(
      ctx.threadId,
      filename
    );

    if (!attachment) {
      // Fetch the live image filenames in this thread so the error
      // hint can name what's actually available. Only runs on the miss
      // path - the cost (one small SELECT) is acceptable for a
      // diagnostic that helps the model self-correct on its next call.
      // Mirrors the pattern in web_search where an unusable query
      // throws with an actionable message.
      const summaries = await ctx.supabase
        .listAttachmentSummariesForThread(ctx.threadId)
        .catch(() => []);
      const liveImageNames = summaries
        .filter((s) => s.is_image && !s.expired)
        .map((s) => `"${s.filename}"`);
      const hint =
        liveImageNames.length > 0
          ? ` Live image attachments in this thread: ${liveImageNames.join(', ')}.`
          : ' This thread has no live image attachments.';
      throw new Error(`No image attachment named "${filename}" in this thread.${hint}`);
    }

    if (!attachment.storage_path) {
      // storage_path is null when the expiry sweep has deleted the
      // object. The model already sees expired filenames in the
      // <thread_attachments> block under the "Expired" heading, so it
      // shouldn't normally call us here - but if it does, surface the
      // expiry rather than silently producing nothing.
      throw new Error(
        `Image "${filename}" has expired and its data is no longer available.`
      );
    }

    log.info(`analyzing "${filename}" with query: ${query.slice(0, 80)}`);

    // Hand Venice a short-lived signed URL into the attachments bucket;
    // its vision input fetches the image server-side, so we never pull
    // the bytes into the browser. (Venice accepts either a public URL or
    // an inline data URI; the signed URL is public for its TTL.)
    const signedUrls = await ctx.supabase.createAttachmentSignedUrls([attachment]);
    const imageUrl = signedUrls.get(attachment.id);
    if (!imageUrl) {
      throw new Error(
        `Image "${filename}" could not be loaded for analysis. Try again.`
      );
    }

    // Venice OpenAI-compatible vision shape: text query part followed
    // by an image_url part pointing at the signed URL.
    const messages: VeniceMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: query },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ];

    // Vision sub-call retry loop. The non-streaming completion endpoint
    // is normally a one-shot, but the vision model has been observed to
    // return either an empty body (provider blip - the choice carries
    // no content) or finish_reason='length' when a dense photo's
    // description runs past the token cap. maxTokens is 8196: bounded,
    // but enough headroom that a verbose describe-this-photo response
    // wraps up naturally rather than getting cut mid-description.
    // The retry burns another vision call but produces a usable answer
    // ~95% of the time on the second attempt. Each retry logs a warning
    // to the log drawer so a sticky failure stays visible to the user
    // rather than silently looping.
    let lastFinishReason: string | null = null;
    let lastLength = 0;
    for (let attempt = 1; attempt <= MAX_VISION_ATTEMPTS; attempt += 1) {
      const result = await ctx.supabase.complete({
        model: agentModel('visionAnalysis').id,
        messages,
        signal: ctx.signal,
        maxTokens: 8196,
      });

      const trimmed = result.text.trim();
      lastFinishReason = result.finishReason;
      lastLength = trimmed.length;

      if (trimmed.length === 0) {
        log.warn(
          `empty vision response for "${filename}" (attempt ${attempt}/${MAX_VISION_ATTEMPTS}, finish_reason=${result.finishReason ?? 'null'})`
        );
        continue;
      }

      const truncationReason = detectTruncation(result.finishReason);
      if (truncationReason) {
        // Capture the tail so the drawer entry is enough to diagnose
        // the failure without needing to re-run with extra logging.
        const tail = trimmed.slice(-80);
        log.warn(
          `truncated vision response for "${filename}" (attempt ${attempt}/${MAX_VISION_ATTEMPTS}, ${truncationReason}, ${trimmed.length} chars); tail=${JSON.stringify(tail)}`
        );
        continue;
      }

      log.info(`done: ${trimmed.length} chars`);
      return { answer: trimmed };
    }

    // All attempts came back empty or truncated. Throw rather than
    // return a partial answer so the main model sees a real tool error
    // and can apologise / retry / describe the failure - returning a
    // half-sentence as if it were the answer causes the main model to
    // confidently relay nonsense to the user.
    if (lastLength === 0) {
      throw new Error(
        `Vision model returned no text for "${filename}" after ${MAX_VISION_ATTEMPTS} attempts. This is usually a transient provider blip - try again, or describe to the user that the image analysis failed.`
      );
    }
    throw new Error(
      `Vision model returned truncated output for "${filename}" after ${MAX_VISION_ATTEMPTS} attempts (last finish_reason=${lastFinishReason ?? 'null'}). The image analysis sub-model is unstable right now - retry the tool, or describe to the user that the image analysis failed.`
    );
  },
};
