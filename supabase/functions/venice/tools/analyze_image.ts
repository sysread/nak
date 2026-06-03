// analyze_image (function-side port)
//
// Vision-tier sub-completion against an image attachment in the
// current thread. Wire schema lives in
// src/lib/tools/analyze_image.schema.ts.
//
// Simplifications vs the browser path:
// - Single-attempt (no 3x retry loop for empty/truncated responses).
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

// Mirror of agentModel('visionAnalysis') in src/lib/models/index.ts.
const VISION_MODEL = 'e2ee-qwen3-vl-30b-a3b-p';
const SIGNED_URL_TTL_SECONDS = 300;

interface AttachmentRow {
  id: string;
  filename: string;
  storage_path: string | null;
  mime_type: string;
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

    // Sign a short-lived URL for Venice's vision input - Venice
    // fetches the image server-side from the URL, so we never pull
    // bytes through the function.
    const { data: signed, error: signErr } = await ctx.adminClient.storage
      .from('attachments')
      .createSignedUrl(data.storage_path, SIGNED_URL_TTL_SECONDS);
    if (signErr || !signed?.signedUrl) {
      throw new Error(`Image "${filename}" could not be signed for analysis. Try again.`);
    }

    const apiKey = await readVeniceKey(ctx.adminClient);
    if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

    const result = await toolComplete({
      apiKey,
      model: VISION_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: query },
            { type: 'image_url', image_url: { url: signed.signedUrl } },
          ] as unknown as string,
        },
      ],
      maxTokens: 8196,
    });

    const trimmed = result.text.trim();
    if (trimmed.length === 0) {
      throw new Error(
        `Vision model returned no text for "${filename}" (finish_reason=${result.finishReason ?? 'null'}). ` +
          'Usually a transient provider blip - retry, or describe to the user that the image analysis failed.',
      );
    }
    if (result.finishReason !== 'stop') {
      throw new Error(
        `Vision model returned truncated output for "${filename}" (finish_reason=${result.finishReason ?? 'null'}). ` +
          'Retry, or describe to the user that the image analysis failed.',
      );
    }

    return { answer: trimmed };
  },
};

registerTool(analyzeImage);
