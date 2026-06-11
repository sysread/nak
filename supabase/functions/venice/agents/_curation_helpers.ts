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
}): Promise<string> {
  const raw = await veniceComplete({
    apiKey: opts.apiKey,
    body: {
      model: opts.model,
      messages: opts.messages,
      max_completion_tokens: opts.maxTokens,
      response_format: { type: 'json_object' },
    },
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
