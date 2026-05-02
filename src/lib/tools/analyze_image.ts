/**
 * Image-analysis tool. The main model delegates visual inspection of
 * any image attached anywhere in the current thread to a dedicated
 * vision model (VISION_ANALYSIS_MODEL). Non-vision tiers rely on this
 * tool exclusively; vision tiers can still call it when they want a
 * focused query against a specific filename rather than reading the
 * inlined image_url part on the user turn.
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
import { VISION_ANALYSIS_MODEL } from '../models';
import { createLogger } from '../logger.svelte';

const log = createLogger('analyze-image-tool');

export const analyzeImage: ToolDef = {
  name: 'analyze_image',
  description:
    'Analyze an image that has been attached anywhere in the current ' +
    'conversation by sending it to a vision-capable model with a ' +
    'focused query. Use this when you need to see an image to answer. ' +
    'The `<thread_attachments>` system block lists every available ' +
    'filename. Takes `filename` (must match exactly, case-sensitive) ' +
    'and `query` (what to look for or extract — phrase as a direct ' +
    'instruction to the vision model, e.g. "What text appears in this ' +
    'image?" or "Describe the layout of this diagram."). Returns the ' +
    'vision model\'s plain-text answer.',
  shortDescription: 'analyze any image in the conversation via vision model',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description:
          'Filename of the image to analyze, exactly as listed in the ' +
          '`<thread_attachments>` block (case-sensitive). Images from ' +
          'any prior turn of this conversation are reachable, not just ' +
          'the most recent user message.',
      },
      query: {
        type: 'string',
        description:
          'What to extract or describe. Phrase as a direct question or ' +
          'instruction — e.g. "What text appears in this image?" or ' +
          '"Describe the layout of this diagram."',
      },
    },
    required: ['filename', 'query'],
    additionalProperties: false,
  },
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

    if (!attachment.data_base64) {
      // data_base64 is null when the 30-day expiry worker has reclaimed
      // the row. The model already sees expired filenames in the
      // <thread_attachments> block under the "Expired" heading, so it
      // shouldn't normally call us here - but if it does, surface the
      // expiry rather than silently producing nothing.
      throw new Error(
        `Image "${filename}" has expired and its data is no longer available.`
      );
    }

    log.info(`analyzing "${filename}" with query: ${query.slice(0, 80)}`);

    // Venice OpenAI-compatible vision shape: text query part followed
    // by an image_url part. The data: URI carries the base64 inline so
    // Venice does not need to fetch a remote URL.
    const messages: VeniceMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: query },
          {
            type: 'image_url',
            image_url: {
              url: `data:${attachment.mime_type};base64,${attachment.data_base64}`,
            },
          },
        ],
      },
    ];

    // VISION_ANALYSIS_MODEL is decoupled from any user-facing tier so
    // a tier retarget doesn't silently break image analysis. Uses the
    // non-streaming completion endpoint - this is a background sub-
    // call with no UI to render token-by-token into, and the one-shot
    // path avoids the SSE-only failure modes other sub-tools used to
    // hit.
    const result = await ctx.venice.completeChat({
      model: VISION_ANALYSIS_MODEL,
      messages,
      signal: ctx.signal,
      maxTokens: 1024,
    });

    const trimmed = result.text.trim();
    if (trimmed.length === 0) {
      // Empty completion means the vision sub-call produced no text -
      // typically a transient provider blip (model overloaded, network
      // dropped mid-stream, or the stream finished before any delta
      // arrived). Throw rather than return `{answer: ""}` so the model
      // sees a real tool error and can apologise / retry, rather than
      // guessing the tool itself is broken and emitting a different
      // filename on retry.
      log.warn(`empty vision response for "${filename}"`);
      throw new Error(
        `Vision model returned no text for "${filename}". This is usually a transient provider blip - try again, or describe to the user that the image analysis failed.`
      );
    }

    log.info(`done: ${trimmed.length} chars`);
    return { answer: trimmed };
  },
};
