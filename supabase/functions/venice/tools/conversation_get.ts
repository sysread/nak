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
 * Reduce stored rows to the user/assistant turns worth showing. Tool
 * rows and empty assistant rows would burn window budget without
 * payload.
 */
function readableTurns(rows: MessageRow[]): TranscriptMessage[] {
  const readable: TranscriptMessage[] = [];
  for (const row of rows) {
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    if (typeof row.content !== 'string') continue;
    const trimmed = row.content.trim();
    if (trimmed.length === 0) continue;
    readable.push({ role: row.role, content: trimmed });
  }
  return readable;
}

/**
 * Find the turn that best matches `query` by naive term overlap, or -1.
 *
 * Deliberately lexical rather than a second embedding round trip: by
 * the time this runs, conversation_search has already done the semantic
 * work of picking the thread, and the caller is passing back words it
 * saw in that hit's `passage`. Overlap against a passage the caller is
 * quoting back is a much easier problem than open-ended retrieval, and
 * it keeps this a single DB read.
 *
 * Scoring is term-frequency-free on purpose: a turn mentioning "lentils"
 * five times is not five times more likely to be the one wanted than a
 * turn mentioning it once alongside "cider" and "soak". Distinct terms
 * matched is the better signal.
 */
function bestMatchIndex(turns: readonly TranscriptMessage[], query: string): number {
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2),
    ),
  ];
  if (terms.length === 0) return -1;

  let bestScore = 0;
  let bestIndex = -1;
  for (let i = 0; i < turns.length; i++) {
    const haystack = turns[i].content.toLowerCase();
    let score = 0;
    for (const term of terms) if (haystack.includes(term)) score++;
    // Ties go to the EARLIER turn. A topic is usually introduced before
    // it is discussed, and the introduction is what a caller asking
    // "where did we talk about X" wants.
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/**
 * Project the thread's turns onto a window that fits
 * MAX_TRANSCRIPT_CHARS, centred on `anchor` (or on the tail when there
 * is no anchor).
 *
 * The tail default is what the tool has always done, and on its own it
 * is a trap: a caller that correctly identifies a 107-message thread
 * and needs its FIRST message gets the last eight turns instead, with
 * no way to ask for anything else. `truncated: true` told it something
 * was missing but not what, where, or how to reach it - so the only
 * move left was to call again with the same id and get the same bytes.
 * The anchor, and the window position reported alongside it, are the
 * way out of that dead end.
 */
function windowTranscript(
  rows: MessageRow[],
  anchor: number = -1,
): {
  messages: TranscriptMessage[];
  truncated: boolean;
  window: { start: number; end: number; total: number };
} {
  const readable = readableTurns(rows);

  if (anchor >= 0) {
    // Grow outward from the anchor, alternating back and forward, so
    // the caller gets the matching turn WITH the exchange around it -
    // an answer without its question reads as context-free.
    // Annotated rather than inferred: these are reassigned inside a
    // branch whose condition reads them back, which TS flags as a
    // circular inference without the explicit types.
    let chars: number = readable[anchor].content.length;
    let start: number = anchor;
    let end: number = anchor;
    // Alternate outward rather than filling one side first. Reaching
    // only backward leaves the match as the last turn shown, so the
    // caller sees a question with no answer; reaching only forward
    // loses the turn that set up the match. Each side is re-checked
    // against the remaining budget every step, so one oversized
    // neighbour stops that direction without stopping the other.
    let preferBack: boolean = true;
    for (;;) {
      const canGoBack: boolean =
        start > 0 && chars + readable[start - 1].content.length <= MAX_TRANSCRIPT_CHARS;
      const canGoForward: boolean =
        end < readable.length - 1 &&
        chars + readable[end + 1].content.length <= MAX_TRANSCRIPT_CHARS;
      if (!canGoBack && !canGoForward) break;

      const takeBack: boolean = canGoBack && (preferBack || !canGoForward);
      if (takeBack) {
        start--;
        chars += readable[start].content.length;
      } else {
        end++;
        chars += readable[end].content.length;
      }
      preferBack = !takeBack;
    }
    return {
      messages: readable.slice(start, end + 1),
      truncated: start > 0 || end < readable.length - 1,
      window: { start, end, total: readable.length },
    };
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

  return {
    messages: readable.slice(start),
    truncated: start > 0,
    window: { start, end: Math.max(start, readable.length - 1), total: readable.length },
  };
}

export const conversationGet: ToolDef = {
  name: 'conversation_get',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) throw new Error('id is required');
    const query = typeof args.query === 'string' ? args.query.trim() : '';

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
      .order('position', { ascending: true });
    if (rowsErr) throw new Error(`listMessages failed: ${rowsErr.message}`);

    const messageRows = (rows ?? []) as MessageRow[];
    const anchor = query ? bestMatchIndex(readableTurns(messageRows), query) : -1;
    const transcript = windowTranscript(messageRows, anchor);

    return {
      found: true,
      conversation: {
        id: summary.id,
        title: summary.title,
        summary: summary.summary,
        updated_at: summary.updated_at,
        archived: summary.archived,
        truncated: transcript.truncated,
        // Window position, so `truncated` is actionable instead of a
        // dead end. A caller that can see it received turns 99-107 of
        // 107 knows the rest of the thread exists and roughly where -
        // and can pass a `query` to land somewhere else in it.
        window: transcript.window,
        // Whether the requested query actually anchored the window.
        // False means the terms were not found and this is the ordinary
        // tail view, which is very different information from "here is
        // your passage" and must not be silently conflated with it.
        matched_query: query ? anchor >= 0 : null,
        messages: transcript.messages,
      },
    };
  },
};

registerTool(conversationGet);

// Test-only surface. The windowing is the whole point of this tool -
// a wrong window is how a caller that correctly found its thread still
// came away with the wrong part of it - so it is asserted directly in
// supabase/functions/tests/conversation-get.test.ts.
export const __test = {
  bestMatchIndex,
  readableTurns,
  windowTranscript,
  MAX_TRANSCRIPT_CHARS,
};
