/**
 * Fetch one prior conversation by id: title, summary, and a windowed
 * transcript. The conversation-layer counterpart to wiki_get, reached
 * after conversation_search (or straight from an id in an auto-injected
 * context block) once the model knows which thread it wants to read.
 *
 * Returns `{found: false}` rather than throwing when the id is unknown
 * (or belongs to another user - RLS filters it out), matching wiki_get
 * and recipe_get so the calling model handles "not found" in prose
 * rather than guarding every call with a try/catch.
 *
 * Windowing: unlike a wiki article (bounded by MAX_WIKI_CONTENT_CHARS),
 * a thread transcript is unbounded - a long conversation could blow the
 * main model's context if dumped whole. We keep the most recent
 * messages within a character budget and set `truncated: true` when
 * older turns were dropped; the always-present `summary` covers the
 * part that didn't fit.
 *
 * Schema lives in `./conversation_get.schema.ts`.
 */
import type { ToolDef } from './types';
import type { Message } from '../supabase';
import { conversationGetSchema } from './conversation_get.schema';

/** Character budget for the returned transcript. Keeps a long thread
 *  from swamping the main model's context; the summary carries the
 *  gist of anything trimmed. Comparable to MAX_WIKI_CONTENT_CHARS
 *  (16000) but a little tighter since a transcript is lower-density
 *  than an edited article. */
const MAX_TRANSCRIPT_CHARS = 12_000;

interface TranscriptMessage {
  role: Message['role'];
  content: string;
}

/**
 * Project a thread's messages onto the most-recent window that fits the
 * budget. Only user and assistant turns with real text survive -
 * tool-call rows and empty assistant rows carry no readable content and
 * would just spend budget. `truncated` is true when older messages were
 * dropped to fit.
 */
function windowTranscript(messages: Message[]): {
  messages: TranscriptMessage[];
  truncated: boolean;
} {
  const readable: TranscriptMessage[] = messages
    .filter(
      (m) =>
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim().length > 0
    )
    .map((m) => ({ role: m.role, content: m.content.trim() }));

  let chars = 0;
  let start = 0;
  for (let i = readable.length - 1; i >= 0; i--) {
    chars += readable[i].content.length;
    // Keep at least the most recent message even if it alone exceeds the
    // budget - a transcript with no messages is useless to the caller.
    if (chars > MAX_TRANSCRIPT_CHARS && i < readable.length - 1) {
      start = i + 1;
      break;
    }
  }

  return { messages: readable.slice(start), truncated: start > 0 };
}

export const conversationGet: ToolDef = {
  ...conversationGetSchema,
  async execute(args, ctx) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) throw new Error('id is required');

    // One batched select gives us title/summary/archived/updated_at and
    // doubles as the existence + ownership check (RLS drops other users'
    // threads, so a missing row reads as not-found).
    const [summary] = await ctx.supabase.listThreadSummariesByIds([id]);
    if (!summary) return { found: false };

    const messages = await ctx.supabase.listMessages(id);
    const transcript = windowTranscript(messages);

    return {
      found: true,
      conversation: {
        id: summary.id,
        title: summary.title,
        summary: summary.summary,
        updated_at: summary.updated_at,
        archived: summary.archived,
        truncated: transcript.truncated,
        messages: transcript.messages,
      },
    };
  },
};
