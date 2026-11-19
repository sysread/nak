// Second-thoughts reviewer - the "doubt reflex" (v2: decision-model
// verdict).
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
// v2: the DISPOSITION VERDICT is a Decisions API call (veniceDecision,
// model clef-api, private tier) - one `choice` question over the
// serialized turn slice, returning the pick with a full probability
// distribution and a confidence. No prose generation for the verdict
// means the chain-of-thought-leak failure class (an earlier reasoning
// model produced usable verdicts on ~40% of turns) is structurally
// impossible. The prose NOTE - the twinge itself - is the one part a
// decision model cannot produce, so on a doubt verdict a small chat
// completion writes it; conviction is behaviorally inert - the
// isDoubt gate hides the panel, samskara's doubt filter drops it, and
// replay ignores un-acted rows - so it writes an empty note and skips
// the chat call entirely.
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
//   1. the turn slice is serialized into ONE fenced document carried
//      as decision-call state, NOT replayed as role-tagged messages
//      (role replay is what triggers continuation - same reason the
//      chat path fences the user turn; see chat.md);
//   2. the decision call returns typed judgments, not generated text -
//      there is no schema slot for a conversational reply.
//
// Best-effort and non-throwing end to end: a decision-call failure
// leaves the row without a verdict (the card just shows nothing); a
// note-call failure writes the doubt with an empty note (the UI's
// fallback copy owns that shape) - never breaks the turn.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger } from '../../_shared/edge-log.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import { veniceComplete, veniceDecision } from '../../_shared/venice.ts';
import { DECISION_CALL_TIMEOUT_MS } from './_decision_state.ts';
import { SECOND_THOUGHTS_MODEL } from '../../_shared/agent-models.ts';

// The verdict's model: the decision model that answers the disposition
// question. The doubt NOTE (when one is written) is authored by
// SECOND_THOUGHTS_MODEL below - the `model` field records the verdict's
// producer, and no reader consumes it today (the browser coercer drops
// it); it is diagnostics for a debugger tracing a bad note.
const VERDICT_MODEL = 'clef-api';

// The note-call model: the same fast instruct model the reflex has
// always ridden (thinking pinned at the call site - it can reason, and
// an unsuppressed thinking pass broke this exact agent before). Repoint
// here to retune the note voice.
const NOTE_MODEL = SECOND_THOUGHTS_MODEL;

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
 * carried as decision-call STATE (data, not a chat turn), so nothing
 * invites the model to answer as a fourth voice.
 *
 * `toolResultChars` is the per-result body cap; the budget guard
 * re-serializes with a tighter cap rather than dropping rows (D7 in
 * the plan) - the row structure, the anchor question, and the
 * URL-surfacing survive every pass, only tool-result bodies thin out.
 */
export function serializeExchange(
  rows: readonly TurnRow[],
  toolResultChars: number = MAX_TOOL_RESULT_CHARS,
): string {
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
      const truncated = m.content.length > toolResultChars;
      const body = truncated
        ? `${m.content.slice(0, toolResultChars)}\n...[truncated]`
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

// The reviewer brief: persona, grounding discipline, and provenance
// rules - carried as decision-call STATE so the verdict-shaping rules
// travel with the verdict (plan D5). The disposition list + JSON
// contract that used to close the chat prompt died with the chat
// transport; the dispositions live on as choice criteria.
const REVIEWER_BRIEF = `You are the quiet voice of second thoughts inside an AI assistant -
the reflex of self-doubt that fires the moment after it answers. You
are NOT continuing the conversation and you are NOT the assistant. Your
only job is to re-read the assistant's most recent response and report
how confident you feel about it.

You review ONE thing: the exchange inside <exchange_under_review> -
the user's latest message and the assistant's response to it (with its
reasoning and any tool calls). If a <conversation_so_far> block appears
with it, that is BACKGROUND ONLY: it is there so you know what has
already been discussed. Do not review it, do not judge the older
answers in it, and do not treat a topic change inside it as a problem.

You still do NOT see everything. The assistant also knows things from
outside this conversation - earlier conversations, stored notes about
the user, its own background context - none of which is shown to you.
You are a gut check, not a full audit.

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
anywhere in the exchange.`;

// The decision question's instruction: the decision rule the
// evaluator applies. The dispositions' meanings live in the choice
// criteria; the conviction bias is restated here because it is the
// single most load-bearing instruction the old prompt carried.
const VERDICT_INSTRUCTION =
  `Review the exchange in <exchange_under_review> only; anything in ` +
  `<conversation_so_far> is background. Apply the reviewer brief and ` +
  `pick the one disposition that fits. When in doubt, choose ` +
  `"conviction" - it is the default and by far the most common verdict.`;

/** The choice criteria: each disposition's meaning from the old
 *  prompt, carried verbatim-ish so the decision model judges the same
 *  spectrum the chat prompt asked for. */
const DISPOSITION_CRITERIA: Record<SecondThoughtsDisposition, string> = {
  conviction:
    'The response holds up. The DEFAULT and by far the most common ' +
    'verdict - use it unless something genuinely nags at you. Stands ' +
    'behind both the facts and the framing.',
  hedge:
    'The answer is basically fine but sounds more certain than it ' +
    'should. A caveat is missing.',
  reframe:
    'You suspect the assistant misread what was being asked, or ' +
    'approached it the wrong way - it may have answered a different ' +
    'question than the one the user was asking.',
  correct:
    'You suspect an outright factual error in the response. This ' +
    'means "I suspect this is wrong" - verification happens later, in ' +
    'the user-triggered refinement.',
};

// Serialized-state budget (D7): clef-api's state cap is 32k tokens;
// the serialized exchange's row count is uncapped and assistant
// reasoning rides untrimmed. On overflow the guard re-serializes with
// a tighter tool-result cap (dropping the background fence first) so
// tool-heavy turns thin out instead of dying on an upstream 400 -
// exactly the turns the provenance machinery exists for. ~4 chars per
// token puts 96k chars at ~24k tokens: comfortable headroom.
const STATE_BUDGET_CHARS = 96_000;
const TOOL_RESULT_CAP_PASSES = [MAX_TOOL_RESULT_CHARS, 1000, 250];

/**
 * Assemble the POST /decisions body: the reviewer brief + the fenced
 * exchange/background as state, one `choice` question carrying the
 * disposition semantics + grounding rules. The budget guard (D7)
 * tightens tool-result caps and drops the background before it ever
 * lets the state overflow the model's cap.
 */
export function buildVerdictRequest(
  rows: readonly TurnRow[],
  background: string,
): Record<string, unknown> {
  let backgroundFence = background;
  let exchange = serializeExchange(rows);
  if ((exchange.length + backgroundFence.length) > STATE_BUDGET_CHARS) {
    backgroundFence = '';
    for (const cap of TOOL_RESULT_CAP_PASSES.slice(1)) {
      exchange = serializeExchange(rows, cap);
      if (exchange.length <= STATE_BUDGET_CHARS) break;
    }
  }
  const state: Record<string, unknown> = {
    reviewer_brief: REVIEWER_BRIEF,
    exchange_under_review: exchange,
  };
  if (backgroundFence) state.conversation_so_far = backgroundFence;
  return {
    model: VERDICT_MODEL,
    state,
    questions: {
      disposition: {
        type: 'choice',
        instructions: VERDICT_INSTRUCTION,
        criteria: DISPOSITION_CRITERIA,
      },
    },
  };
}

/**
 * Coerce the /decisions response into the verdict's disposition and
 * the answer's confidence, or null on any drift (fail-open input -
 * the caller treats null as "no verdict written"). The confidence is
 * diagnostics only (plan D6 - no gating in v1).
 */
export function coerceDisposition(payload: unknown): {
  disposition: SecondThoughtsDisposition;
  confidence: number;
} | null {
  if (!payload || typeof payload !== 'object') return null;
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object') return null;
  const answer = (answers as Record<string, unknown>).disposition;
  if (!answer || typeof answer !== 'object') return null;
  const a = answer as { choice?: unknown; confidence?: unknown };
  if (
    typeof a.choice !== 'string' ||
    !DISPOSITIONS.includes(a.choice as SecondThoughtsDisposition)
  ) {
    return null;
  }
  const confidence =
    typeof a.confidence === 'number' && Number.isFinite(a.confidence)
      ? a.confidence
      : 0;
  return {
    disposition: a.choice as SecondThoughtsDisposition,
    confidence,
  };
}

// The note prompt (M2): the reviewer persona + the exchange + the
// drawn verdict, asking for the twinge itself. The falsification /
// provenance rules are NOT here - the verdict is already drawn; this
// call only voices it.
const NOTE_PROMPT = `You are the quiet voice of second thoughts inside an AI assistant -
the reflex of self-doubt that fires the moment after it answers. You
are NOT continuing the conversation and you are NOT the assistant.

A reviewer pass has already drawn its verdict about your most recent
answer; your job is to voice that doubt in your own first-person voice.

Respond with ONLY the note: one or two first-person sentences voicing
the doubt ("I said X, but I'm not sure...") - the twinge itself,
phrased as something to reconsider, never as a command. No preamble,
no lists, no markdown.`;

/**
 * The doubt-note call's instruction: the disposition is already drawn;
 * the exchange carries the specifics.
 */
function buildNoteRequest(
  exchange: string,
  disposition: SecondThoughtsDisposition,
): string {
  return (
    `${exchange}\n\nThe verdict was "${disposition}". ` +
    `Voice the note now.`
  );
}

/**
 * Shape-check the note text before it is persisted (D4): trimmed,
 * capped at 800, and guarded against the two known leak shapes - a
 * thinking-pass riding the content channel (`<think>` tags) and a
 * prompt echo (the compound-summary guard's signature-phrase
 * precedent). A failed check returns '' - the empty-note doubt shape
 * the UI already handles.
 */
export function sanitizeNote(raw: string): string {
  let note = raw.trim();
  if (note.length > MAX_NOTE_CHARS) note = note.slice(0, MAX_NOTE_CHARS);
  if (note.includes('<think>')) return '';
  if (/^You are the\b/i.test(note)) return '';
  // A list-line leak: the note is one or two sentences of prose, so a
  // line starting with a markdown bullet is a reasoning dump, not a
  // twinge.
  if (/\n\s*[-*]\s/.test(note)) return '';
  return note;
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

    // The verdict: one decision call over the serialized slice. A
    // failure (transport, non-OK, malformed answer) = no verdict
    // written - never a fabricated one (D3). The timeout matters: a
    // STALLED fetch is not an error fail-open can catch - it would
    // stall the completed-turn waitUntil tail; 10s degrades a hang
    // into the ordinary no-verdict path.
    const decisionPayload = await veniceDecision({
      apiKey,
      body: buildVerdictRequest(
        rows,
        serializeBackground(background, backgroundUrls),
      ),
      signal: AbortSignal.timeout(DECISION_CALL_TIMEOUT_MS),
    });
    const drawn = coerceDisposition(decisionPayload);
    if (!drawn) {
      log.debug(`no usable verdict on ${terminalMsgId}`);
      return;
    }
    const { disposition, confidence } = drawn;

    // Conviction is behaviorally inert: the isDoubt gate hides the
    // panel, samskara's doubt filter drops it, replay ignores un-acted
    // rows - so the note call is skipped entirely (D1). A doubt gets its note voiced by the fast chat
    // model; a note-call failure degrades to the empty-note doubt the
    // UI's fallback copy already owns (D3).
    let note = '';
    if (disposition !== 'conviction') {
      try {
        const noteText = await veniceComplete({
          apiKey,
          body: {
            model: NOTE_MODEL,
            messages: [
              { role: 'system', content: NOTE_PROMPT },
              {
                role: 'user',
                content: buildNoteRequest(
                  serializeExchange(rows),
                  disposition,
                ),
              },
            ],
            // Prose generation, but the model can reason and its
            // serving default effort is high - the pin is load-bearing
            // (an unpinned call burns the small budget on a thinking
            // pass).
            venice_parameters: { disable_thinking: true },
            max_completion_tokens: 256,
          },
        });
        const text = extractContentText(noteText);
        note = text === null ? '' : sanitizeNote(text);
      } catch (err) {
        log.debug(`note call failed on ${terminalMsgId}; writing empty-note doubt`, err);
        note = '';
      }
      log.info(
        `note for ${disposition} on ${terminalMsgId}: ` +
          `${note.length > 0 ? `${note.length} chars` : '(empty - fallback copy owns it)'}`,
      );
    }

    const payload: SecondThoughtsVerdict = {
      v: 1,
      disposition,
      note,
      model: VERDICT_MODEL,
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
    log.info(
      `${disposition} on ${terminalMsgId} (confidence ${confidence.toFixed(2)})`,
    );
  } catch (err) {
    log.debug(
      'review errored',
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    await log.flush();
  }
}

/**
 * Pull the assistant's text out of a /chat/completions response
 * (veniceComplete returns the parsed body verbatim). Null when the
 * shape drifts - the caller's shape check treats that as an empty
 * note.
 */
function extractContentText(payload: unknown): string | null {
  const choices = (payload as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const content = (choices[0] as { message?: { content?: unknown } })?.message
    ?.content;
  return typeof content === 'string' ? content : null;
}

// Test-only surface: the serializer + verdict-request shaping +
// coercer are asserted in supabase/functions/tests/second-thoughts.test.ts.
export const __test = {
  buildVerdictRequest,
  coerceDisposition,
  sanitizeNote,
  serializeExchange,
  serializeBackground,
  verifiedQuotes,
};
