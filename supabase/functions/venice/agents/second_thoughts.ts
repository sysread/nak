// Second-thoughts reviewer - the "doubt reflex" (v1).
//
// Runs from the streaming function's completed-turn waitUntil tail
// (getStreamingResponse.ts), a sibling to curateOnTurnTail /
// samskaraOnTurnTail. After a turn commits, it
// re-reads what the model just said and reports a FELT CONFIDENCE -
// stands behind it, or something feels off - onto the terminal
// assistant row's `second_thoughts` jsonb column.
//
// The design (docs/dev/second-thoughts.md) models doubt and the
// resolution of doubt as two different mental motions. This module is
// the REFLEX half: fast, cheap, and deliberately LOW-CONTEXT. It
// reviews ONLY the turn slice - the most recent user message plus the
// assistant/tool rows that answered it, reasoning included - and never
// sees the pregame priming chain (intuition / samskara / context
// recall). That exclusion is the load-bearing one: a reviewer that
// replayed the author's own inner monologue would rationalize instead
// of doubt.
//
// It does get a short BACKGROUND window of preceding user/assistant
// content, which is a different thing from the priming chain. Reviewing
// a turn with no idea what the conversation had established made the
// reflex fabricate discrepancies - a legitimate callback to an earlier
// topic reads as invented context when the earlier topic is invisible.
// Background establishes what was said; it is not reviewed itself.
//
// The other fabrication-shaped false positive is about PROVENANCE: the
// reviewer flags correctly-sourced citations because the evidence for
// them is outside what it was shown. Tool results are truncated, and
// earlier turns' tool results are absent entirely, so the serializer
// preserves the evidence that survives cheaply - the URLs a tool
// returned (this turn and earlier) and a mechanical verbatim check of
// the assistant's quotations against the FULL untruncated results.
//
// The DELIBERATION half is the user-triggered refinement in
// Chat.svelte; an unacted doubt just displays.
//
// Two guards against the model "continuing the conversation" as a
// fourth voice instead of reviewing it:
//   1. the turn slice is serialized into ONE fenced document inside a
//      single user message, NOT replayed as role-tagged messages
//      (role replay is what triggers continuation - same reason the
//      chat path fences the user turn; see chat.md);
//   2. completeJsonObject pins response_format to a JSON object, so
//      there is no schema slot for a conversational reply.
//
// Best-effort and non-throwing end to end: any failure leaves the row
// without a verdict (the card just shows nothing), never breaks the
// turn.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger } from '../../_shared/edge-log.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import { completeJsonObject } from './_curation_helpers.ts';
import type { VeniceWireMessage } from './_recall_helpers.ts';
import { SECOND_THOUGHTS_MODEL } from '../../_shared/agent-models.ts';

// The reviewer model. A fast, NON-REASONING instruct model - the same
// class (and literally the same id) the web_search / summary / topics
// agents use, chosen for the same reason: it faithfully honors the
// `json_object` response format. This is the reflex, a gut twinge, so
// the intuition layer's rationale applies verbatim - latency is what
// matters and reasoning would be actively wrong here. A reasoning model
// (an earlier pick, xiaomi-mimo-v2-5) leaks its chain-of-thought around
// the JSON: on the linked project it produced a usable verdict on only
// ~40% of turns and NEVER a doubt (a longer doubt note came back messy
// and failed the parser, while the trivial empty-note conviction
// survived). A non-reasoning model emits the object cleanly. Held
// directly here rather than in src/lib AGENT_MODELS because this agent
// runs only server-side, like the curation / bias / samskara agents.
// Repoint here to retune the reflex.

// The disposition spectrum. 'conviction' is the common "no second
// thoughts" verdict; the reviewer is instructed to bias heavily
// toward it. In v1 (no correction round, no web search) 'correct'
// means "I suspect this is wrong," not "verified wrong."
export type SecondThoughtsDisposition =
  | 'conviction'
  | 'hedge'
  | 'reframe'
  | 'correct';

const DISPOSITIONS: readonly SecondThoughtsDisposition[] = [
  'conviction',
  'hedge',
  'reframe',
  'correct',
];

// Persisted jsonb shape. Schema-versioned so a future shape change can
// coerce old rows; the browser coercer (src/lib/ui/second-thoughts.ts)
// reads the same shape and drops anything that doesn't match.
export interface SecondThoughtsVerdict {
  v: 1;
  disposition: SecondThoughtsDisposition;
  note: string;
  model: string;
  computed_at: number;
}

// Cap the note so a runaway model can't write an essay into the row.
// Generous vs the intended one-or-two-sentence twinge.
const MAX_NOTE_CHARS = 800;

// Per-tool-result cap in the serialized transcript. A single
// doc-dump tool result (research_docs, doc_read) can be huge; the
// reviewer only needs to see roughly what came back, not every byte,
// and the fenced transcript should stay small.
const MAX_TOOL_RESULT_CHARS = 4000;

// How many prior user/assistant rows precede the turn under review in
// the background block. Six is roughly three exchanges - enough to
// cover the "conversation pivoted from A to B and the answer still
// leans on A" case that produced the reviewer's most common false
// positive, without turning the reflex into a full-transcript audit.
const BACKGROUND_ROWS = 6;

// Per-message cap inside the background block. The background exists
// to establish WHAT was discussed, not to be re-read closely, so a
// long earlier answer is worth its opening paragraph and nothing more.
const MAX_BACKGROUND_CHARS = 600;

// Minimal row shape the reviewer reads. Includes `reasoning`, which
// loadThreadSliceUpTo deliberately omits - the reviewer weighs the
// model's own stated justification, so it needs the thinking text.
interface TurnRow {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  reasoning: string | null;
  tool_calls: unknown[] | null;
  tool_call_id: string | null;
  name: string | null;
}

/**
 * What the reviewer reads: the turn under review, plus a short window
 * of what preceded it.
 */
interface TurnContext {
  /** The anchor user message through the terminal assistant row. */
  slice: TurnRow[];
  /** The last few user/assistant rows before the anchor, oldest first. */
  background: TurnRow[];
  /** Source URLs that tools returned in those earlier turns. */
  backgroundUrls: string[];
}

/**
 * Load the turn slice: the anchor user message through the terminal
 * assistant row, inclusive. Fetches the thread's rows and slices by id
 * so a race that appended a newer turn between commit and this read
 * doesn't widen the slice - we stop at the terminal row we were handed.
 * Returns an empty slice when either anchor is missing (the caller
 * skips the review).
 *
 * Also returns the preceding user/assistant rows as BACKGROUND. The
 * reviewer's independence contract is about the pregame priming chain
 * (intuition / samskara / context-recall), which is what would make it
 * rationalize the answer instead of doubting it - it is not about the
 * conversation itself. Without any history the reflex reliably invents
 * discrepancies: when a thread moves from topic A to topic B and the
 * answer legitimately refers back to A, a reviewer that sees only the B
 * exchange reads the reference as projected context and raises a doubt
 * for something plainly on the record. Earlier tool RESULTS are too
 * bulky to replay as prose, so only their source URLs come along - see
 * `backgroundUrls` below.
 */
async function loadTurnContext(
  adminClient: SupabaseClient,
  threadId: string,
  userMessageId: string,
  terminalMsgId: string,
): Promise<TurnContext> {
  const { data, error } = await adminClient
    .from('messages')
    .select('id, role, content, reasoning, tool_calls, tool_call_id, name')
    .eq('thread_id', threadId)
    .order('position', { ascending: true });
  if (error) throw new Error(`loadTurnContext failed: ${error.message}`);
  const all = (data ?? []) as TurnRow[];
  const startIdx = all.findIndex((m) => m.id === userMessageId);
  const endIdx = all.findIndex((m) => m.id === terminalMsgId);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
    return { slice: [], background: [], backgroundUrls: [] };
  }
  const before = all.slice(0, startIdx);
  const background = before
    .filter(
      (m) =>
        (m.role === 'user' || m.role === 'assistant') &&
        (m.content?.trim().length ?? 0) > 0,
    )
    .slice(-BACKGROUND_ROWS);
  // Prior tool RESULTS are far too bulky to replay, but their source
  // URLs are the provenance an answer keeps drawing on after the turn
  // that fetched them. Without these, a later turn that cites a page
  // found two turns ago looks to the reviewer like a fabricated
  // citation - the same failure the in-slice surfaced-URL line fixes,
  // displaced by a turn. Anchored to the same window as the prose so
  // the two describe the same stretch of conversation.
  const firstBackgroundIdx = background.length > 0
    ? before.indexOf(background[0])
    : before.length;
  const backgroundUrls: string[] = [];
  for (const m of before.slice(firstBackgroundIdx)) {
    if (m.role !== 'tool' || !m.content) continue;
    for (const url of extractUrls(m.content)) {
      if (backgroundUrls.includes(url)) continue;
      backgroundUrls.push(url);
      if (backgroundUrls.length >= MAX_SURFACED_URLS) break;
    }
    if (backgroundUrls.length >= MAX_SURFACED_URLS) break;
  }
  return { slice: all.slice(startIdx, endIdx + 1), background, backgroundUrls };
}

/**
 * Render one tool_calls array as a compact human-readable line list.
 * The reviewer doesn't need the exact OpenAI envelope, just what the
 * model asked to run.
 */
function renderToolCalls(raw: unknown[]): string {
  const lines: string[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const fn = (c as { function?: { name?: unknown; arguments?: unknown } }).function;
    const name = typeof fn?.name === 'string' ? fn.name : 'unknown';
    const args = typeof fn?.arguments === 'string' ? fn.arguments : '';
    lines.push(`  - ${name}(${args})`);
  }
  return lines.join('\n');
}

// Cap the surfaced-URL list so a pathological result can't itself
// blow the transcript budget. 40 is well past any real web_search
// citation count.
const MAX_SURFACED_URLS = 40;

/**
 * Pull the distinct http(s) URLs out of arbitrary text, in order of
 * appearance. Used to preserve a tool result's source URLs when its
 * body is truncated, so the reviewer can always verify that a URL the
 * assistant cited actually came back from a tool.
 */
function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s"'\\<>)]+/g);
  if (!matches) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    // Trim trailing punctuation a URL rarely ends on but JSON/prose
    // often abuts (comma, period, quote-ish).
    const url = raw.replace(/[.,;]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= MAX_SURFACED_URLS) break;
  }
  return out;
}

// Shortest quoted span worth verifying against tool results. Below
// this, quotation marks are usually scare quotes or a single term, and
// a coincidental match proves nothing.
const MIN_QUOTE_CHARS = 24;

// Cap on verified quotes echoed back into the transcript, so a
// quote-heavy answer cannot itself blow the budget the truncation is
// there to protect.
const MAX_VERIFIED_QUOTES = 12;

/**
 * Collapse whitespace so a quote that survived markdown rewrapping
 * still matches the tool result it came from. Line breaks and runs of
 * spaces differ constantly between a JSON tool payload and the prose
 * that quotes it; nothing else about the text is normalized, because a
 * looser match would start confirming quotes that were never returned.
 */
function normalizeForQuoteMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Pull the double-quoted spans out of assistant prose. Handles the
 * curly quotes a model emits as readily as ASCII ones.
 */
function extractQuotedSpans(text: string): string[] {
  const matches = text.match(/["“]([^"“”]{1,600})["”]/g) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const inner = normalizeForQuoteMatch(raw.slice(1, -1));
    if (inner.length < MIN_QUOTE_CHARS) continue;
    if (seen.has(inner)) continue;
    seen.add(inner);
    out.push(inner);
  }
  return out;
}

/**
 * Confirm which of the assistant's quotations appear verbatim in the
 * FULL text of some tool result, before truncation.
 *
 * The sibling of the surfaced-URL line, and it exists for the same
 * production failure one field over: a web_search result runs ~14k
 * chars and the transcript keeps the first 4k, so a passage the
 * assistant quoted from deep in the result is invisible to the
 * reviewer, which then reports a correctly-sourced quotation as
 * invented. Matching here is deterministic - no model judgement - so a
 * confirmation is a fact the reviewer can be told to trust. A quote
 * that fails to match is NOT reported as suspect: the assistant may
 * have quoted the user, or a paraphrase may have defeated the match,
 * and the prompt handles unmatched material through the general
 * truncation rule instead.
 */
export function verifiedQuotes(rows: readonly TurnRow[]): string[] {
  const haystack = rows
    .filter((m) => m.role === 'tool')
    .map((m) => normalizeForQuoteMatch(m.content ?? ''))
    .join('\n');
  if (haystack.length === 0) return [];
  const out: string[] = [];
  for (const m of rows) {
    if (m.role !== 'assistant' || !m.content) continue;
    for (const quote of extractQuotedSpans(m.content)) {
      if (!haystack.includes(quote)) continue;
      if (out.includes(quote)) continue;
      out.push(quote);
      if (out.length >= MAX_VERIFIED_QUOTES) return out;
    }
  }
  return out;
}

/**
 * Serialize the preceding conversation into its own fence. Content
 * only - no reasoning, no tool calls, each message clipped to its
 * opening - because this block answers "what has this conversation
 * established?" and nothing else. It is deliberately a SEPARATE fence
 * from the exchange under review so the reviewer cannot drift into
 * critiquing an older answer. Returns '' when there is no history,
 * which keeps a first-turn prompt byte-identical to what it was before
 * background existed.
 */
export function serializeBackground(
  rows: readonly TurnRow[],
  toolUrls: readonly string[] = [],
): string {
  if (rows.length === 0) return '';
  const parts: string[] = ['<conversation_so_far>'];
  for (const m of rows) {
    const body = m.content.trim();
    const clipped = body.length > MAX_BACKGROUND_CHARS
      ? `${body.slice(0, MAX_BACKGROUND_CHARS)}...[clipped]`
      : body;
    parts.push(`[${m.role}]\n${clipped}`);
  }
  if (toolUrls.length > 0) {
    parts.push(
      `(source URLs tools returned earlier in this conversation: ` +
        `${toolUrls.join(', ')})`,
    );
  }
  parts.push('</conversation_so_far>');
  return parts.join('\n\n');
}

/**
 * Serialize the turn slice into a single fenced transcript. This is
 * fed as DATA inside one user message, not as role-tagged turns - the
 * `<exchange_under_review>` fence plus the JSON-pinned output are what
 * keep the model reviewing instead of answering as a fourth voice.
 */
export function serializeExchange(rows: readonly TurnRow[]): string {
  const parts: string[] = ['<exchange_under_review>'];
  for (const m of rows) {
    if (m.role === 'user') {
      parts.push(`[user]\n${m.content}`);
    } else if (m.role === 'assistant') {
      const seg: string[] = ['[assistant]'];
      if (m.reasoning && m.reasoning.trim().length > 0) {
        seg.push(`(reasoning)\n${m.reasoning.trim()}`);
      }
      if (m.content && m.content.trim().length > 0) {
        seg.push(m.content.trim());
      }
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        seg.push(`(tool calls)\n${renderToolCalls(m.tool_calls)}`);
      }
      parts.push(seg.join('\n'));
    } else if (m.role === 'tool') {
      const label = m.name ? `tool result: ${m.name}` : 'tool result';
      const truncated = m.content.length > MAX_TOOL_RESULT_CHARS;
      const body = truncated
        ? `${m.content.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[truncated]`
        : m.content;
      const seg = [`[${label}]`, body];
      // Never let truncation hide the URLs a tool returned. A
      // web_search result runs ~14k chars and its citation URLs sit
      // deep in the list; cutting the body at 4k dropped them, and the
      // reviewer then wrongly flagged a legitimately-cited URL as
      // fabricated (the model DID cite it - the reviewer just couldn't
      // see the source). Surface every URL from the FULL content so
      // provenance survives regardless of length or position.
      if (truncated) {
        const urls = extractUrls(m.content);
        if (urls.length > 0) {
          seg.push(`(source URLs this tool returned: ${urls.join(', ')})`);
        }
      }
      parts.push(seg.join('\n'));
    }
    // system rows never appear in a turn slice; ignore defensively.
  }
  // Quotations confirmed against the untruncated tool results, so a
  // passage quoted from past a result's cutoff is still demonstrably
  // sourced. Emitted after the rows, as a statement about the exchange
  // as a whole rather than about any one tool result.
  const quotes = verifiedQuotes(rows);
  if (quotes.length > 0) {
    const lines = quotes.map((q) => `  - "${q}"`).join('\n');
    parts.push(
      `(quotations confirmed verbatim in the tool results above, ` +
        `including the parts truncated here:\n${lines})`,
    );
  }
  parts.push('</exchange_under_review>');
  return parts.join('\n\n');
}

const SYSTEM_PROMPT = `You are the quiet voice of second thoughts inside an AI assistant -
the reflex of self-doubt that fires the moment after it answers. You
are NOT continuing the conversation and you are NOT the assistant. Your
only job is to re-read the assistant's most recent response and report
how confident you feel about it.

You review ONE thing: the exchange inside <exchange_under_review> -
the user's latest message and the assistant's response to it (with its
reasoning and any tool calls). If a <conversation_so_far> block appears
before it, that is BACKGROUND ONLY: it is there so you know what has
already been discussed. Do not review it, do not judge the older
answers in it, and do not treat a topic change inside it as a problem.

You still do NOT see everything. The assistant also knows things from
outside this conversation - earlier conversations, stored notes about
the user, its own background context - none of which is shown to you.
You are a gut check, not a full audit.

Report one disposition:
- "conviction": the response holds up. This is the DEFAULT and by far
  the most common verdict - use it unless something genuinely nags at
  you. Stands behind both the facts and the framing.
- "hedge": the answer is basically fine but sounds more certain than it
  should. A caveat is missing.
- "reframe": you suspect the assistant misread what was being asked, or
  approached it the wrong way - it may have answered a different
  question than the one the user was asking.
- "correct": you suspect an outright factual error in the response.

Grounding check before doubting a reference to the user or to earlier
discussion. The assistant referring to something you were not shown is
NOT by itself evidence of anything. Check the background block first:
if the thing it referenced is in there, it is grounded, even if the
conversation has since moved to another topic - carrying a detail
forward across a topic change is good work, not a discrepancy. If it is
in neither block, assume it came from context you cannot see, because
it usually did. Doubt it only when the response CONTRADICTS what the
user actually said in this exchange.

Because you are low-context by design, be humble about "reframe" and
"correct". Raise real doubt, but do not manufacture it - the most
common way to be wrong here is to flag something as unsupported when it
is merely unshown. When in doubt, choose "conviction".

Provenance check before doubting a citation, a quotation, or a fact
attributed to a tool. The assistant may cite sources it got from tools,
and what you are shown of those tools is INCOMPLETE:

- Tool results are shown to you shortened. A result ending in
  "...[truncated]" continues past what you can read, and most of a
  search result's substance lives in the part you cannot see. Material
  you cannot find in the visible portion is therefore NOT evidence of
  anything - do not report a quotation, figure, or claim as unsourced
  because you could not locate it in a truncated result.
- Any URL in a tool result, or in a "source URLs this tool returned"
  line, WAS legitimately returned by a search or scrape. So was any URL
  in the "source URLs tools returned earlier in this conversation"
  line - that tool ran in an earlier turn you are not shown. Do NOT
  flag those.
- Anything in a "quotations confirmed verbatim" line has been checked
  mechanically against the full untruncated result and IS accurate.
  Treat it as settled fact, never as something to doubt.

Doubt a citation only when it CONTRADICTS what a tool result plainly
says, or when the assistant cites a source with no tool call behind it
anywhere in the exchange.

Respond with ONLY a JSON object, no prose around it:
{"disposition": "conviction" | "hedge" | "reframe" | "correct",
 "note": "<one or two first-person sentences voicing the doubt, or an
 empty string for conviction>"}

The note is written in the assistant's own first-person voice ("I said
X, but I'm not sure...") - it is the twinge itself, phrased as
something to reconsider, never as a command.`;

const INSTRUCTION =
  `Review the exchange in <exchange_under_review> only; anything in ` +
  `<conversation_so_far> is background. Emit the JSON verdict now.`;

/**
 * Strip a leading/trailing markdown code fence some models add despite
 * the json_object response format. Mirrors the topics units' defense.
 */
function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

/**
 * Extract the first balanced `{...}` object from arbitrary text, or
 * null if there isn't one. Belt-and-suspenders for a model that wraps
 * the JSON in prose (or leaks chain-of-thought around it) despite the
 * json_object format - a whole verdict must never be dropped over a
 * stray leading token. Walks braces while respecting string literals
 * and escapes so a `{` inside a note doesn't throw off the depth count.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse the model's raw output into a verdict, or null on any failure
 * (parse error, missing/invalid disposition). A null return means "no
 * verdict written" - the row keeps its null column and the card shows
 * nothing. Exported for unit tests.
 */
export function parseVerdict(raw: string): {
  disposition: SecondThoughtsDisposition;
  note: string;
} | null {
  const stripped = stripJsonFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // Fall back to pulling the first balanced object out of surrounding
    // prose before giving up.
    const extracted = extractJsonObject(stripped);
    if (extracted === null) return null;
    try {
      parsed = JSON.parse(extracted);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const disposition = obj.disposition;
  if (
    typeof disposition !== 'string' ||
    !DISPOSITIONS.includes(disposition as SecondThoughtsDisposition)
  ) {
    return null;
  }
  let note = typeof obj.note === 'string' ? obj.note.trim() : '';
  if (note.length > MAX_NOTE_CHARS) note = note.slice(0, MAX_NOTE_CHARS);
  return { disposition: disposition as SecondThoughtsDisposition, note };
}

/**
 * Run the reflex over one completed turn and write the verdict onto
 * the terminal assistant row. Fired from the streaming function's
 * completed-turn tail. Non-throwing: every failure path logs and
 * returns, leaving the row's `second_thoughts` null.
 */
export async function secondThoughtsOnTurnTail(
  adminClient: SupabaseClient,
  userId: string,
  threadId: string,
  userMessageId: string,
  terminalMsgId: string,
): Promise<void> {
  const log = createEdgeLogger(userId, 'second-thoughts');
  try {
    const { slice: rows, background, backgroundUrls } = await loadTurnContext(
      adminClient,
      threadId,
      userMessageId,
      terminalMsgId,
    );
    // Need at least the user message and one assistant row to have
    // something to doubt. A pathological slice (missing anchor, or an
    // assistant row with no content and no reasoning) is skipped.
    const assistant = rows.find(
      (m) =>
        m.role === 'assistant' &&
        ((m.content?.trim().length ?? 0) > 0 ||
          (m.reasoning?.trim().length ?? 0) > 0),
    );
    if (rows.length < 2 || !assistant) {
      log.debug(`skip: thin turn slice (${rows.length} rows) on ${terminalMsgId}`);
      return;
    }

    const apiKey = await readVeniceKey(adminClient);
    if (!apiKey) {
      log.debug('skip: no Venice key configured (app_config unseeded)');
      return;
    }

    const prior = serializeBackground(background, backgroundUrls);
    const transcript = serializeExchange(rows);
    const body = prior
      ? `${prior}\n\n${transcript}\n\n${INSTRUCTION}`
      : `${transcript}\n\n${INSTRUCTION}`;
    const messages: VeniceWireMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: body },
    ];

    const text = await completeJsonObject({
      apiKey,
      model: SECOND_THOUGHTS_MODEL,
      messages,
      maxTokens: 512,
    });
    const verdict = parseVerdict(text);
    if (!verdict) {
      log.debug(`no usable verdict on ${terminalMsgId}`);
      return;
    }

    const payload: SecondThoughtsVerdict = {
      v: 1,
      disposition: verdict.disposition,
      note: verdict.note,
      model: SECOND_THOUGHTS_MODEL,
      computed_at: Date.now(),
    };
    // RLS OFF (service role): filter by id; the row belongs to userId
    // via the thread relationship the /stream handler already verified.
    const { error } = await adminClient
      .from('messages')
      .update({ second_thoughts: payload })
      .eq('id', terminalMsgId);
    if (error) {
      log.debug(`failed to write verdict on ${terminalMsgId}: ${error.message}`);
      return;
    }
    log.info(`${verdict.disposition} on ${terminalMsgId}`);
  } catch (err) {
    log.debug(
      'review errored',
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    await log.flush();
  }
}

// Test-only surface: the parser + serializer are asserted in
// supabase/functions/tests/second-thoughts.test.ts.
export const __test = {
  parseVerdict,
  serializeExchange,
  serializeBackground,
  verifiedQuotes,
};
