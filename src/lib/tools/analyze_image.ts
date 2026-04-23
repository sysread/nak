/**
 * Image-analysis tool. When a non-vision model tier is active and the
 * user attaches an image, buildUserVeniceContent() prepends a note to
 * the user turn listing the image filenames and instructing the model
 * to call this tool. The main model can then delegate visual inspection
 * to the balanced vision tier with a focused query derived from the
 * user's intent, rather than getting an unconditional "describe this"
 * dump on every request.
 *
 * Why a tool rather than unconditional pre-analysis: pre-analyzing
 * every image burns a vision call even when the user's question could
 * be answered from extracted text or conversation context. The tool
 * path lets the model call analyze_image() only when it actually needs
 * to look at the pixels, and it phrases the query based on what the
 * user asked so the vision model returns something focused.
 *
 * The image bytes live in ctx.attachments (hydrated by the chat loop
 * from the current user message's attachment rows). The tool never
 * queries the DB itself - all the bytes it needs are already in scope.
 */

import type { ToolDef } from './types';
import type { VeniceMessage } from '../venice';
import { VISION_ANALYSIS_MODEL } from '../models';
import { isImageMimeType } from '../attachments';
import { createLogger } from '../logger.svelte';

const log = createLogger('analyze-image-tool');

export const analyzeImage: ToolDef = {
  name: 'analyze_image',
  description:
    'Analyze an image attached to the current message by sending it to a ' +
    'vision-capable model with a focused query. Use this when the user ' +
    'attaches an image and you need to see it to answer. Takes `filename` ' +
    '(must match an attachment on this message exactly, case-sensitive) ' +
    'and `query` (what to look for or extract — phrase it as a direct ' +
    'instruction to the vision model, e.g. "What text appears in this ' +
    'image?" or "Describe the layout of this diagram."). Returns the ' +
    'vision model\'s plain-text answer.',
  shortDescription: 'analyze an attached image via vision model',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description:
          'Filename of the image to analyze, exactly as shown in the ' +
          'attached images list (case-sensitive).',
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

    // ctx.attachments is the hydrated Attachment[] for the current user
    // message, populated by the chat loop. The tool can only see what
    // the user sent on this turn - no cross-message access.
    const attachment = (ctx.attachments ?? []).find(
      (a) => a.filename === filename && isImageMimeType(a.mime_type)
    );

    if (!attachment) {
      // Surface the list of known image filenames so the model can
      // retry with the correct name rather than silently returning
      // nothing. Mirrors the pattern in web_search where an unusable
      // query throws with a diagnostic message.
      const known = (ctx.attachments ?? [])
        .filter((a) => isImageMimeType(a.mime_type))
        .map((a) => `"${a.filename}"`);
      const hint =
        known.length > 0
          ? ` Known image attachments: ${known.join(', ')}.`
          : ' No image attachments found on this message.';
      throw new Error(`No image attachment named "${filename}" on this message.${hint}`);
    }

    if (!attachment.data_base64) {
      // data_base64 is null when the 30-day expiry worker has reclaimed
      // the row. Rare on a freshly-sent message; more likely on a
      // regenerate triggered long after the expiry window.
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
    // a tier retarget doesn't silently break image analysis. Currently
    // mistral-small-2603, which supports vision on Venice.
    const stream = ctx.venice.streamChat({
      model: VISION_ANALYSIS_MODEL,
      messages,
      signal: ctx.signal,
      maxTokens: 1024,
    });

    let answer = '';
    for await (const ev of stream) {
      if (ev.type === 'text') {
        answer += ev.delta;
      }
      // Drop reasoning / usage / tool_call / citations. The sub-call
      // has no tools and should not emit citations; drop defensively
      // rather than recursing or erroring.
    }

    log.info(`done: ${answer.length} chars`);
    return { answer: answer.trim() };
  },
};
