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

/**
 * True when the URL's host is unreachable from the public internet,
 * meaning Venice's vision API cannot fetch it. Covers localhost, the
 * IPv4 loopback range, IPv6 loopback, the IPv4 private ranges, and
 * the .local mDNS suffix. The tool's caller falls back to inlining
 * base64 in that case so the request still reaches Venice with usable
 * bytes; production deployments against a hosted Supabase URL stay on
 * the cheaper signed-URL path.
 */
function isLocalHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.local')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  if (host.startsWith('127.')) return true;
  if (host.startsWith('10.')) return true;
  if (host.startsWith('192.168.')) return true;
  // RFC 1918 172.16.0.0/12 - 172.16.x.x through 172.31.x.x. Split out so
  // the cidr math stays readable as a Number range check rather than a
  // regex on the second octet.
  if (host.startsWith('172.')) {
    const second = Number(host.split('.')[1]);
    if (Number.isFinite(second) && second >= 16 && second <= 31) return true;
  }
  return false;
}

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

    // Resolve a URL Venice can read. In production this is a signed
    // public URL from Supabase Storage: Venice fetches it server-side
    // and we never pull bytes through the function. In local dev the
    // signed URL points at 127.0.0.1:54321 which Venice cannot reach
    // from the public internet - the vision API returns "Supplied
    // image did not pass validation checks." On localhost-ish hosts
    // we download the bytes and inline as a data URL instead. Costs
    // ~33% payload bloat (base64 encoding) but works everywhere; the
    // signed-URL path stays the default in production for that
    // bandwidth savings.
    const { data: signed, error: signErr } = await ctx.adminClient.storage
      .from('attachments')
      .createSignedUrl(data.storage_path, SIGNED_URL_TTL_SECONDS);
    if (signErr || !signed?.signedUrl) {
      throw new Error(`Image "${filename}" could not be signed for analysis. Try again.`);
    }

    let imageUrl = signed.signedUrl;
    if (isLocalHost(imageUrl)) {
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
      imageUrl = `data:${data.mime_type};base64,${base64}`;
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
            { type: 'image_url', image_url: { url: imageUrl } },
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
