// Shared plumbing for the curation work units (auto_title, summary,
// thread_topics, memory_topics, recipe_topics - composed by
// ./curation.ts). These five units are function-side ports of the
// browser's supervised worker fleet (src/lib/agents/*); what they
// share lives here so the per-unit modules stay focused on their own
// prompt + validation logic.
//
// No lease coordinator, same rationale as ./reflection.ts: the claim
// RPCs' atomic per-row claim+TTL IS the mutual exclusion, so each unit
// claims with a fresh per-call holder id and skips the browser-era
// lease machinery entirely.

import { veniceComplete } from '../../_shared/venice.ts';
import type { StoredMessage, VeniceWireMessage } from './_recall_helpers.ts';
import { estimateWireTokens, isContextLengthError } from './_accumulator.ts';
import {
  type OpenAIToolCall,
  sanitizeToolCallIdForWire,
  sanitizeToolCallsForWire,
  sanitizeToolNameForWire,
} from './_wire.ts';

/**
 * TTL for every curation claim (threads, memories, recipes). The
 * browser supervisor passed threadClaimTtlSeconds=120 to all five
 * units, so 120 is the parity value: each unit is one non-streaming
 * Venice call against a fast model, and 120s comfortably exceeds the
 * slowest plausible completion. The only cost of the TTL is how late
 * a crashed run's row becomes claimable again.
 */
export const CURATION_CLAIM_TTL_SECONDS = 120;

/**
 * Trim a slice of messages so the last row is "complete" - i.e. not a
 * trailing `tool` row and not an `assistant` with unanswered
 * tool_calls. Port of trimToCompleteTurn in
 * src/lib/conversation-recovery.ts, retyped over the function-side
 * StoredMessage shape. Used for the head-half of condenseHistory-style
 * splits, where we'd rather drop a partial turn than synthesize one
 * (the head only needs to set up the topic, not present a coherent
 * finished exchange).
 *
 * Walks backward, dropping trailing `tool` rows and any preceding
 * `assistant` with tool_calls (which is now orphaned because we just
 * dropped its results). Stops at the first row that's a complete
 * `user`, `system`, or `assistant`-without-tool_calls.
 */
export function trimToCompleteTurn(messages: StoredMessage[]): StoredMessage[] {
  let end = messages.length;
  while (end > 0) {
    const m = messages[end - 1];
    if (m.role === 'tool') {
      end--;
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      end--;
      continue;
    }
    break;
  }
  if (end === messages.length) return messages;
  return messages.slice(0, end);
}

/**
 * Trim a slice of messages so the first row is the start of a fresh
 * round - i.e. a `user` or `system` message. Port of
 * trimToFirstUserOrSystem in src/lib/conversation-recovery.ts. Drops
 * any leading orphan `tool` rows or `assistant` rows that would
 * otherwise begin the slice mid-turn. Counterpart for the tail-half
 * of a condenseHistory-style split, where the slice can land partway
 * through an exchange.
 *
 * Returns the original array when no trim is needed.
 */
export function trimToFirstUserOrSystem(messages: StoredMessage[]): StoredMessage[] {
  let start = 0;
  while (start < messages.length) {
    const m = messages[start];
    if (m.role === 'user' || m.role === 'system') break;
    start++;
  }
  if (start === 0) return messages;
  return messages.slice(start);
}

/**
 * Project a stored Message row onto the Venice wire format WITH the
 * tool-call sanitisers applied. The curation units use this instead of
 * _recall_helpers.ts's messageToVenice because their browser
 * counterparts (src/lib/agents/summary/agent.ts and siblings) ran
 * stored ids/arguments through the wire sanitisers before resending -
 * Venice's strict validators 400 the whole request on a tool_call_id
 * outside [a-zA-Z0-9]{9} or a malformed arguments blob, and stored
 * rows can carry either. See ./_wire.ts for the sanitiser rationale.
 */
export function messageToWire(m: StoredMessage): VeniceWireMessage {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      content: m.content,
      ...(m.tool_call_id != null
        ? { tool_call_id: sanitizeToolCallIdForWire(m.tool_call_id) }
        : {}),
      // Sanitized for the same reason as the assistant side's
      // tool_calls[].function.name: MCP-routed names carry colons
      // that strict backends 400 on in undeclared replays.
      ...(m.name ? { name: sanitizeToolNameForWire(m.name) } : {}),
    };
  }
  const out: VeniceWireMessage = { role: m.role, content: m.content };
  if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
    out.tool_calls = sanitizeToolCallsForWire(m.tool_calls as OpenAIToolCall[]);
  }
  return out;
}

// Visible body for synthesized tool-result rows injected during repair.
// Plain parens, not markdown italic, because tool content travels as a
// JSON string on the wire - italic underscores inside that string have
// caused render glitches in tool-call cards when read back.
const RECOVERY_TOOL_BODY = '(tool execution was interrupted - no result available)';

// Visible body for the synthesized assistant turn that closes an
// interrupted exchange. Mirrors the browser constant in
// src/lib/conversation-recovery.ts so the model sees the same phrasing
// regardless of which path assembled the thread.
const RECOVERY_ASSISTANT_BODY =
  '*(The previous response was interrupted before I finished. Picking up from here.)*';

function makeRecoveryTool(call: OpenAIToolCall): StoredMessage {
  return {
    id: `synthetic-recovery-tool-${call.id}`,
    role: 'tool',
    content: RECOVERY_TOOL_BODY,
    tool_calls: null,
    tool_call_id: call.id,
    name: call.function?.name ?? null,
  };
}

function makeRecoveryAssistant(): StoredMessage {
  return {
    id: 'synthetic-recovery-asst',
    role: 'assistant',
    content: RECOVERY_ASSISTANT_BODY,
    tool_calls: null,
    tool_call_id: null,
    name: null,
  };
}

/**
 * Rebuild a StoredMessage slice into a tool-call fan-in that Venice's
 * strict validators accept. Three wire-shape errors drove this, all
 * arising when a tool-using round is interrupted between persisting the
 * assistant-with-tool_calls row and persisting (in the right place) its
 * tool-result rows:
 *
 *   - "Not the same number of function calls and responses" - an
 *     assistant's tool_calls has more ids than the tool rows that
 *     immediately follow it.
 *   - "Unexpected tool call id <id> in tool results" - a tool-result
 *     row carries an id with no matching call in the assistant block it
 *     sits in (or no assistant-with-tool_calls anchor at all).
 *   - "Unexpected role 'user' after role 'tool'" - a tool block runs
 *     straight into a user turn with no assistant reply between.
 *
 * The invariant enforced: every tool-result row must sit in the block
 * immediately after the assistant that called its id, and every such
 * block must be followed by an assistant turn. So for each
 * assistant-with-tool_calls we keep only the following tool rows whose
 * id is one of THAT assistant's calls (de-duped), synthesize a stub
 * result for every unanswered call, and append a recovery assistant
 * when the block would otherwise be followed by a non-assistant row or
 * end of slice. Tool rows with no matching preceding call - including
 * the late, misplaced results a crash can leave stranded after a text
 * turn (see thread a0e7940e: A1/A2 results persisted at the end, after
 * the assistant's text replies, so they sort as orphans) - are dropped.
 *
 * Diverges from synthesizeRecoveryMessages in
 * src/lib/conversation-recovery.ts: the browser KEEPS orphan/mismatched
 * tool rows because it has to render them and heal the thread on the
 * next persist. This path only builds a throwaway wire copy and never
 * writes back, so dropping the wire-invalid rows is both correct and
 * simpler than trying to re-anchor them.
 *
 * Returns the same array by reference when no repair is needed.
 */
export function repairToolCallFanIn(messages: StoredMessage[]): StoredMessage[] {
  if (messages.length === 0) return messages;
  const result: StoredMessage[] = [];
  let modified = false;
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];

    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      result.push(m);
      const calls = m.tool_calls as OpenAIToolCall[];
      const callIds = new Set(calls.map((c) => c.id));

      // Walk the consecutive tool block, keeping only rows that answer
      // one of THIS assistant's calls (first occurrence per id).
      // Mismatched or duplicate tool rows are dropped - emitting them is
      // what triggers "Unexpected tool call id <id> in tool results".
      const answered = new Set<string>();
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        const tcid = messages[j].tool_call_id;
        if (tcid && callIds.has(tcid) && !answered.has(tcid)) {
          answered.add(tcid);
          result.push(messages[j]);
        } else {
          modified = true;
        }
        j++;
      }

      for (const call of calls) {
        if (!answered.has(call.id)) {
          result.push(makeRecoveryTool(call));
          modified = true;
        }
      }

      // The block is never empty (>=1 call, each answered by a kept or
      // synthesized row), so the only question is whether an assistant
      // follows it. Venice rejects `tool -> user` and `tool -> EOF`.
      const next = j < messages.length ? messages[j] : null;
      if (next === null || next.role !== 'assistant') {
        result.push(makeRecoveryAssistant());
        modified = true;
      }
      i = j;
      continue;
    }

    if (m.role === 'tool') {
      // Orphan tool run with no assistant-with-tool_calls anchor. Every
      // such row is wire-invalid (a tool result with no preceding call),
      // so drop the whole run. Dropping can't create a `tool -> x`
      // violation, and the row before the run was not an
      // assistant-with-tool_calls (or it would have consumed this run),
      // so no recovery assistant is needed.
      let j = i;
      while (j < messages.length && messages[j].role === 'tool') j++;
      modified = true;
      i = j;
      continue;
    }

    result.push(m);
    i++;
  }
  return modified ? result : messages;
}

/**
 * Cap on how many messages of a thread go to a curation model. Very
 * long threads (500+ messages) would stretch the fast model's context;
 * neither a summary nor a topic list benefits from every turn, so we
 * send the earliest + most-recent messages and let a gap in the middle
 * carry the missing span. The first turns establish topic, the last
 * turns establish outcome - the middle is usually refinement that
 * neither output needs.
 */
const MAX_INPUT_MESSAGES = 120;
const HEAD_MESSAGES = 40;
const TAIL_MESSAGES = 80;

/**
 * Estimated-token ceiling for the transcript a curation unit sends.
 *
 * The message-count cap above bounds turns, not bytes: 120 turns of a
 * tool-heavy thread (search dumps, article bodies, file reads) is
 * routinely six figures of tokens. That is what a thread-topics call
 * died on with "This model's maximum context length is 128000 tokens
 * ... your prompt contains 131949 input tokens".
 *
 * 64k is deliberately half the smallest ceiling observed in
 * production (128000, on the backend then serving summary and the
 * three topics units). Two reasons for the wide margin:
 * estimateWireTokens assumes 4 chars/token, which is right for
 * English prose and badly optimistic for the JSON and code that fills
 * tool results; and the ceiling belongs to whatever backend is
 * serving the model id, which moves under us (see CLAUDE.md on the
 * model registry's contextWindow not being a contract). Truncating a
 * transcript costs a little fidelity on threads that were already
 * being truncated by message count; a 400 costs the whole cycle.
 */
export const CURATION_INPUT_TOKEN_BUDGET = 64_000;

/**
 * Floor for the shrink-retry loop below. Under this the transcript is
 * too small to describe the thread at all, so a unit is better off
 * reporting an error (and retrying on a later cycle) than saving a
 * summary or tag set derived from a handful of turns.
 */
const MIN_INPUT_TOKEN_BUDGET = 8_000;

/**
 * Share of the budget reserved for the most recent messages. Mirrors
 * the 40/80 head/tail split of the message cap, for the same reason:
 * outcomes carry more weight than origins, but origin is what tells
 * the model what the thread was launched into.
 */
const TAIL_BUDGET_SHARE = 2 / 3;

/**
 * Per-message content caps. Tool results are mostly environmental
 * (search dumps, page bodies the chat already read) and a single one
 * can outweigh a dozen user turns, so they get the tighter cap - same
 * value and rationale as TOOL_RESULT_EXCERPT_CHARS in ./_accumulator.ts.
 * Prose gets a looser cap that only bites on pasted blobs.
 *
 * These also guarantee the budget walk below can make progress: with
 * every row bounded, no single message can exceed the budget on its
 * own and wedge the loop.
 */
const TOOL_RESULT_CHARS = 2_000;
const PROSE_CHARS = 8_000;

function excerptOversized(m: StoredMessage): StoredMessage {
  const cap = m.role === 'tool' ? TOOL_RESULT_CHARS : PROSE_CHARS;
  const content = m.content ?? '';
  if (content.length <= cap) return m;
  return {
    ...m,
    content: `${content.slice(0, cap)}\n[... ${content.length - cap} more chars omitted]`,
  };
}

/**
 * Drop messages from the middle until the transcript fits `budget`.
 * Walks backward from the newest message filling the tail share, then
 * forward from the oldest filling whatever is left, and re-trims both
 * halves to safe wire boundaries (the seam can otherwise land on a
 * `tool` row followed by a `user` row, which providers reject - see
 * repairToolCallFanIn above).
 *
 * The newest message is always kept: a thread whose final turn alone
 * exceeds the budget still gets tagged off that turn rather than
 * failing the cycle forever.
 */
function fitToTokenBudget(messages: StoredMessage[], budget: number): StoredMessage[] {
  if (messages.length === 0) return messages;
  // Cost each row exactly as it will be sent, tool-call JSON included.
  const costs = messages.map((m) => estimateWireTokens([messageToWire(m)]));
  const total = costs.reduce((a, b) => a + b, 0);
  if (total <= budget) return messages;

  const tailBudget = Math.floor(budget * TAIL_BUDGET_SHARE);
  let tailStart = messages.length - 1;
  let tailSpent = costs[tailStart];
  while (tailStart > 0 && tailSpent + costs[tailStart - 1] <= tailBudget) {
    tailStart--;
    tailSpent += costs[tailStart];
  }

  const headBudget = budget - tailSpent;
  let headEnd = 0;
  let headSpent = 0;
  while (headEnd < tailStart && headSpent + costs[headEnd] <= headBudget) {
    headSpent += costs[headEnd];
    headEnd++;
  }

  return [
    ...trimToCompleteTurn(messages.slice(0, headEnd)),
    ...trimToFirstUserOrSystem(messages.slice(tailStart)),
  ];
}

/**
 * Condense a thread slice into the transcript a curation unit sends:
 * cap the message count, excerpt oversized rows, then drop from the
 * middle until the whole thing fits the token budget. Each stage is a
 * no-op on a slice already inside its limit, so a short thread comes
 * back with its rows intact (in a fresh array - the excerpt pass
 * copies, unlike repairToolCallFanIn above).
 */
function condenseForCuration(
  all: StoredMessage[],
  budget = CURATION_INPUT_TOKEN_BUDGET,
): StoredMessage[] {
  // The naive count split lands the seam wherever index 40 /
  // length-80 fall, which on a tool-using thread can put a `tool` row
  // at the end of head and a `user` row at the start of tail - the
  // wire then serialises as `tool -> user`, which providers reject
  // with "Unexpected role 'user' after role 'tool'". Trim each half to
  // a safe boundary before concatenating.
  const capped =
    all.length <= MAX_INPUT_MESSAGES
      ? all
      : [
          ...trimToCompleteTurn(all.slice(0, HEAD_MESSAGES)),
          ...trimToFirstUserOrSystem(all.slice(-TAIL_MESSAGES)),
        ];
  return fitToTokenBudget(capped.map(excerptOversized), budget);
}

/**
 * Run one curation completion over a thread slice: condense the slice
 * to something the model can accept, repair the tool-call fan-in,
 * append the unit's instruction as the final user turn, and hand the
 * wire messages to `send`.
 *
 * On a context-length rejection the budget is halved and the whole
 * thing rebuilt - the proactive budget is an estimate over a
 * chars-per-token ratio that no tokenizer actually honours, so the
 * reactive half is what covers content dense enough to beat it (CJK,
 * base64, minified payloads). Below MIN_INPUT_TOKEN_BUDGET the error
 * propagates and the unit's own catch folds it into an 'error'
 * outcome. Any other failure propagates immediately - retrying a
 * transport error at a smaller size buys nothing.
 *
 * Returns the send's result plus how many transcript messages went
 * out, which the units report in their completion breadcrumb.
 */
export async function completeOverThreadSlice<T>(
  slice: StoredMessage[],
  instruction: string,
  send: (messages: VeniceWireMessage[]) => Promise<T>,
): Promise<{ result: T; messageCount: number }> {
  let budget = CURATION_INPUT_TOKEN_BUDGET;
  for (;;) {
    const condensed = repairToolCallFanIn(condenseForCuration(slice, budget));
    const convo: VeniceWireMessage[] = condensed.map(messageToWire);
    convo.push({ role: 'user', content: instruction });
    try {
      return { result: await send(convo), messageCount: condensed.length };
    } catch (err) {
      const next = Math.floor(budget / 2);
      if (!isContextLengthError(err) || next < MIN_INPUT_TOKEN_BUDGET) throw err;
      budget = next;
    }
  }
}

/**
 * Non-streaming completion pinned to JSON-object output. The topics
 * units (thread/memory/recipe) need `response_format: {type:
 * "json_object"}` for parity with their browser counterparts - the
 * pin is what stops fast models from wrapping the object in prose -
 * and toolComplete (the usual sub-completion helper in
 * ../tools/_venice_complete.ts) carries no response_format knob, so
 * this helper builds the wire body directly against veniceComplete.
 * Returns the model's text content; throws on transport failure or a
 * non-object response body (callers fold the throw into their
 * 'error' outcome).
 */
export async function completeJsonObject(opts: CompleteJsonObjectOpts): Promise<string> {
  const { content } = await completeJsonObjectWithMeta(opts);
  return content;
}

type CompleteJsonObjectOpts = {
  apiKey: string;
  model: string;
  messages: readonly VeniceWireMessage[];
  maxTokens: number;
  /**
   * Optional reasoning_effort knob, forwarded verbatim to Venice. Left
   * absent the wire body carries no reasoning_effort field at all -
   * but on a reasoning-capable model that means the MODEL's default
   * effort, so every caller should pin this or disableThinking.
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /**
   * Maps to venice_parameters.disable_thinking - kills the thinking
   * pass entirely rather than shrinking it. The classification-shaped
   * callers (topics, second thoughts) pin this: their model can
   * reason, and an unsuppressed CoT pass burns the JSON output budget
   * (the truncation trap CLAUDE.md's Venice sub-completions section
   * records). Mutually exclusive with reasoningEffort on the wire.
   */
  disableThinking?: boolean;
};

/**
 * completeJsonObject plus the completion's finish_reason. A JSON-object
 * completion that stops on 'length' is truncated mid-object - the text
 * usually fails JSON.parse, but a caller that must distinguish "the
 * model produced garbage" from "the token budget cut the model off"
 * needs the finish_reason (the samskara evaluation judge treats
 * 'length' as a retryable non-verdict rather than a judged-empty
 * thread). finishReason is null when the response carries none.
 */
export async function completeJsonObjectWithMeta(
  opts: CompleteJsonObjectOpts,
): Promise<{ content: string; finishReason: string | null }> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    max_completion_tokens: opts.maxTokens,
    response_format: { type: 'json_object' },
  };
  if (opts.reasoningEffort !== undefined) {
    body.reasoning_effort = opts.reasoningEffort;
  }
  if (opts.disableThinking === true) {
    body.venice_parameters = { disable_thinking: true };
  }
  const raw = await veniceComplete({
    apiKey: opts.apiKey,
    body,
    // Every caller of this helper is a server-side curation agent with no
    // browser rate-limit loop behind it, so ride out a transient 429
    // rather than failing the whole cycle on one "model overloaded".
    retryRateLimit: true,
  });
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Venice completion response was not an object.');
  }
  const obj = raw as Record<string, unknown>;
  const choices = Array.isArray(obj.choices)
    ? (obj.choices as Array<Record<string, unknown>>)
    : [];
  const choice = choices[0] ?? {};
  const message = (choice.message as Record<string, unknown> | undefined) ?? {};
  return {
    content: typeof message.content === 'string' ? message.content : '',
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
  };
}

// Test-only surface: condenseForCuration is exercised directly in
// supabase/functions/tests/curation.test.ts (seam safety, message cap,
// token budget) but has no production caller outside
// completeOverThreadSlice above.
export const __test = { condenseForCuration };
