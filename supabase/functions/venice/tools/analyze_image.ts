// analyze_image (function-side - the live implementation)
//
// Vision-tier sub-completion against an image attachment in the
// current thread. Wire schema lives in
// src/lib/tools/analyze_image.schema.ts; the browser ToolDef of the
// same name is schema-only (it advertises the tool to the model via
// buildToolList) and never executes - dispatch happens here, in the
// streaming function's performToolCall.
//
// The vision sub-call and the bytes-to-data-URL step are shared with
// analyze_pdf_page and live in ./_vision.ts.
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

import { requireThreadId, registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { readVeniceKey } from './_venice_key.ts';
import { askVision, attachmentObjectAsDataUrl } from './_vision.ts';

interface AttachmentRow {
  id: string;
  filename: string;
  storage_path: string | null;
  mime_type: string;
}

/**
 * Explain a filename that exists in the thread but isn't an image.
 *
 * Without this the tool reported "No image attachment named X in this
 * thread" for a PDF the user had plainly attached, which is FALSE - the
 * attachment is right there. The model read that as "the file is gone",
 * told the user it couldn't read PDFs, and stopped. Naming what the file
 * actually is, and which lever reaches it, is what turns a dead end into a
 * redirect.
 */
async function describeNonImageMatch(
  ctx: ToolContext,
  filename: string,
): Promise<string | null> {
  const { data } = await ctx.adminClient
    .from('message_attachments')
    .select('mime_type, page_count, messages!inner(thread_id)')
    .eq('messages.thread_id', requireThreadId(ctx))
    .eq('filename', filename)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ mime_type: string; page_count: number | null }>();
  if (!data) return null;

  const base =
    `"${filename}" is in this conversation but it is not an image ` +
    `(${data.mime_type}), so analyze_image cannot read it.`;
  if (typeof data.page_count === 'number' && data.page_count > 0) {
    return (
      `${base} Its text was extracted at upload time and is inlined in the ` +
      `user turn where it was attached - read it there. To LOOK at a page ` +
      `(scans, charts, diagrams, layout, signatures), call ` +
      `analyze_pdf_page(filename, page, query); the document has ` +
      `${data.page_count} pages.`
    );
  }
  return (
    `${base} Its text was extracted at upload time and is inlined in the ` +
    `user turn where it was attached - read it there rather than calling a tool.`
  );
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
      .eq('messages.thread_id', requireThreadId(ctx))
      .eq('filename', filename)
      .like('mime_type', 'image/%')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<AttachmentRow>();
    if (error) throw new Error(`findImageByFilenameInThread failed: ${error.message}`);
    if (!data) {
      // The `image/%` filter above means a miss can mean two very different
      // things. Distinguish them before answering, or a non-image
      // attachment gets reported as absent.
      const nonImage = await describeNonImageMatch(ctx, filename);
      throw new Error(nonImage ?? `No image attachment named "${filename}" in this thread.`);
    }
    if (!data.storage_path) {
      throw new Error(`Image "${filename}" has expired and its data is no longer available.`);
    }

    const imageUrl = await attachmentObjectAsDataUrl(
      ctx.adminClient,
      data.storage_path,
      data.mime_type,
      `Image "${filename}"`,
    );

    const apiKey = await readVeniceKey(ctx.adminClient);
    if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

    return { answer: await askVision(apiKey, query, imageUrl, `"${filename}"`) };
  },
};

registerTool(analyzeImage);
