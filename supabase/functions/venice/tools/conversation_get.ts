// conversation_get (function-side port)
//
// Fetch one prior conversation by id: title, summary, and a windowed
// transcript. The model reaches for this after conversation_search
// once it knows which thread it wants to read. Wire schema lives in
// src/lib/tools/conversation_get.schema.ts.
//
// Auth: b-strict. threads.user_id direct ownership filter.
//
// What we skip vs the browser path: attachment hydration and the
// interrupted-exchange recovery synth. Both are display concerns;
// the model only sees text content here, and a recovery-synthesized
// tail row from another thread reads as noise rather than signal in
// a transcript window.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';

// Mirrors MAX_TRANSCRIPT_CHARS in src/lib/tools/conversation_get.ts.
// Lower than the wiki cap (16000) because transcripts are
// lower-density than edited articles.
const MAX_TRANSCRIPT_CHARS = 12_000;

interface ThreadSummary {
  id: string;
  title: string;
  summary: string | null;
  archived: boolean;
  updated_at: string;
}

interface MessageRow {
  role: string;
  content: string | null;
}

interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Project the thread's messages onto the most-recent window that
 * fits MAX_TRANSCRIPT_CHARS. Only user and assistant turns with real
 * text survive - tool-call rows and empty assistant rows would burn
 * budget without payload. `truncated` is true when older messages
 * were dropped to fit; the always-present `summary` covers what
 * didn't fit in the window.
 */
function windowTranscript(rows: MessageRow[]): {
  messages: TranscriptMessage[];
  truncated: boolean;
} {
  const readable: TranscriptMessage[] = [];
  for (const row of rows) {
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    if (typeof row.content !== 'string') continue;
    const trimmed = row.content.trim();
    if (trimmed.length === 0) continue;
    readable.push({ role: row.role, content: trimmed });
  }

  let chars = 0;
  let start = 0;
  for (let i = readable.length - 1; i >= 0; i--) {
    chars += readable[i].content.length;
    if (chars > MAX_TRANSCRIPT_CHARS && i < readable.length - 1) {
      start = i + 1;
      break;
    }
  }

  return { messages: readable.slice(start), truncated: start > 0 };
}

export const conversationGet: ToolDef = {
  name: 'conversation_get',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) throw new Error('id is required');

    // RLS OFF: filter by userId. user_id eq + id eq double-checks
    // the thread belongs to the requester before we read messages.
    // The messages.thread_id reference inherits ownership from
    // threads, so the second query below can rely on the ownership
    // we just validated here without re-checking user_id on each
    // row.
    const { data: summary, error: summaryErr } = await ctx.adminClient
      .from('threads')
      .select('id, title, summary, archived, updated_at')
      .eq('user_id', ctx.userId)
      .eq('id', id)
      .maybeSingle<ThreadSummary>();
    if (summaryErr) throw new Error(`listThreadSummariesByIds failed: ${summaryErr.message}`);
    if (!summary) return { found: false };

    // RLS OFF: ownership pre-validated on the threads row above; a
    // by-thread_id select here is safe because thread ownership was
    // just confirmed for this requester.
    const { data: rows, error: rowsErr } = await ctx.adminClient
      .from('messages')
      .select('role, content')
      .eq('thread_id', id)
      .order('created_at', { ascending: true });
    if (rowsErr) throw new Error(`listMessages failed: ${rowsErr.message}`);

    const transcript = windowTranscript((rows ?? []) as MessageRow[]);

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

registerTool(conversationGet);
