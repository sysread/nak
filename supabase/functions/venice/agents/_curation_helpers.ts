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
import {
  type OpenAIToolCall,
  sanitizeToolCallIdForWire,
  sanitizeToolCallsForWire,
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
      ...(m.name ? { name: m.name } : {}),
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
export async function completeJsonObject(opts: {
  apiKey: string;
  model: string;
  messages: readonly VeniceWireMessage[];
  maxTokens: number;
  /**
   * Optional reasoning_effort knob, forwarded verbatim to Venice. The
   * topics units omit it (they take the model default); the manual
   * wiki agent pins 'low' to match its browser-era completion. Left
   * absent the wire body carries no reasoning_effort field at all.
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
}): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    max_completion_tokens: opts.maxTokens,
    response_format: { type: 'json_object' },
  };
  if (opts.reasoningEffort !== undefined) {
    body.reasoning_effort = opts.reasoningEffort;
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
  const message = (choices[0]?.message as Record<string, unknown> | undefined) ?? {};
  return typeof message.content === 'string' ? message.content : '';
}
