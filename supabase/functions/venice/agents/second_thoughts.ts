// Second-thoughts reviewer - the "doubt reflex" (v1).
//
// Runs from the streaming function's completed-turn waitUntil tail
// (getStreamingResponse.ts), a sibling to curateOnTurnTail /
// samskaraOnTurnTail. After a turn commits, it
// re-reads what the model just said and reports a FELT CONFIDENCE -
// stands behind it, or something feels off - onto the terminal
// assistant row's `second_thoughts` jsonb column.
//
// The design (docs/dev/in-progress/second-thoughts.md) models doubt
// and the resolution of doubt as two different mental motions. This
// module is the REFLEX half: fast, cheap, and deliberately
// LOW-CONTEXT. It sees ONLY the turn slice - the most recent user
// message plus the assistant/tool rows that answered it (reasoning
// included) - and NOT the pregame priming chain or any prior
// conversation. That narrowness is the point, not a limitation: a
// reviewer that replayed the author's full context would rationalize
// instead of doubt. The DELIBERATION half (a full-context correction
// round that can overrule the reflex) is phase 2 and does not exist
// yet, so in v1 a raised doubt simply displays, unresolved.
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
 * Load the turn slice: the anchor user message through the terminal
 * assistant row, inclusive. Fetches the thread's rows and slices by id
 * so a race that appended a newer turn between commit and this read
 * doesn't widen the slice - we stop at the terminal row we were handed.
 * Returns [] when either anchor is missing (the caller skips the
 * review).
 */
async function loadTurnSlice(
  adminClient: SupabaseClient,
  threadId: string,
  userMessageId: string,
  terminalMsgId: string,
): Promise<TurnRow[]> {
  const { data, error } = await adminClient
    .from('messages')
    .select('id, role, content, reasoning, tool_calls, tool_call_id, name')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`loadTurnSlice failed: ${error.message}`);
  const all = (data ?? []) as TurnRow[];
  const startIdx = all.findIndex((m) => m.id === userMessageId);
  const endIdx = all.findIndex((m) => m.id === terminalMsgId);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) return [];
  return all.slice(startIdx, endIdx + 1);
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
  parts.push('</exchange_under_review>');
  return parts.join('\n\n');
}

const SYSTEM_PROMPT = `You are the quiet voice of second thoughts inside an AI assistant -
the reflex of self-doubt that fires the moment after it answers. You
are NOT continuing the conversation and you are NOT the assistant. Your
only job is to re-read the assistant's most recent response and report
how confident you feel about it.

You see ONLY the latest exchange - the user's message and the
assistant's response (with its reasoning and any tool calls). You do
NOT see the earlier conversation, the assistant's background context,
or anything it knew about the user. This is deliberate: you are a gut
check, not a full audit. Judge what is in front of you.

Report one disposition:
- "conviction": the response holds up. This is the DEFAULT and by far
  the most common verdict - use it unless something genuinely nags at
  you. Stands behind both the facts and the framing.
- "hedge": the answer is basically fine but sounds more certain than it
  should. A caveat is missing.
- "reframe": you suspect the assistant misread what was being asked, or
  approached it the wrong way - it may have answered a different
  question than the one intended, or projected context that wasn't
  stated.
- "correct": you suspect an outright factual error in the response.

Because you are low-context by design, be humble about "reframe" and
"correct": an inference that looks unsupported to you may be perfectly
justified by context you cannot see. Raise real doubt, but do not
manufacture it - when in doubt, choose "conviction".

Provenance check before doubting a URL or citation: the assistant may
cite sources it got from tools. Before flagging a URL as fabricated,
look at the tool results - including any "source URLs this tool
returned" lines. A URL that appears anywhere in a tool result WAS
legitimately returned by a search or scrape; do NOT flag it. Only doubt
a URL that appears in NONE of the tool results.

Respond with ONLY a JSON object, no prose around it:
{"disposition": "conviction" | "hedge" | "reframe" | "correct",
 "note": "<one or two first-person sentences voicing the doubt, or an
 empty string for conviction>"}

The note is written in the assistant's own first-person voice ("I said
X, but I'm not sure...") - it is the twinge itself, phrased as
something to reconsider, never as a command.`;

const INSTRUCTION = `Above is the exchange to review. Emit the JSON verdict now.`;

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
    const rows = await loadTurnSlice(
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

    const transcript = serializeExchange(rows);
    const messages: VeniceWireMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${transcript}\n\n${INSTRUCTION}` },
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
export const __test = { parseVerdict, serializeExchange };
