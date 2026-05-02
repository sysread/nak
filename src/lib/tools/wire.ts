/**
 * Wire-projection helpers for tool calls. Pure utilities that operate
 * on `OpenAIToolCall` and have no other dependencies, so anyone
 * projecting stored or in-loop tool calls onto the OpenAI/Venice wire
 * format can call in without dragging the chat-loop module along.
 *
 * The chat loop, the headless agent loop in `./run.ts`, and every
 * agent that replays a stored thread to a model (reflection, journal,
 * recall, conversation_recall, summary) all need this projection.
 * Keeping the sanitiser here means a fix or extension lands in one
 * place rather than five copies.
 */

import type { OpenAIToolCall } from './types';

/**
 * Pattern Venice's strict tool_call_id validator accepts: alphanumeric
 * only, exactly 9 chars. Some Venice-routed model backends 400 the
 * whole request with the message "Tool call id was X but must be a-z,
 * A-Z, 0-9, with a length of 9" when an id violates this - including
 * ids of the shape `call_a031` that those same backends generate. The
 * mismatch shows up most often on the headless agent loops (reflection,
 * journal, summary) and on the main chat-loop's multi-round tool
 * dispatch, where a sanitised id has to be paired across the assistant
 * `tool_calls[].id` slot and the matching tool message's
 * `tool_call_id` slot.
 */
const WIRE_ID_PATTERN = /^[a-zA-Z0-9]{9}$/;

const WIRE_ID_ALPHABET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Map an arbitrary tool-call id to a stable 9-char alphanumeric string
 * for the Venice wire. Idempotent: an id that already matches
 * {@link WIRE_ID_PATTERN} passes through unchanged, so applying the
 * sanitiser twice produces the same output.
 *
 * Determinism is the load-bearing property here. The assistant turn's
 * `tool_calls[].id` and the matching tool-result row's `tool_call_id`
 * MUST land at the same value after sanitisation - OpenAI-compatible
 * providers reject a message list where a tool result doesn't pair
 * with a preceding assistant call by id. Hashing the original id lets
 * both sides produce the same output without any shared state.
 *
 * The hash is FNV-1a 32-bit with a per-output-digit mixing step that
 * spreads the 32 bits across 9 base62 positions. 32 bits gives a
 * collision space of ~4.3e9 - vastly more headroom than the <10 tool
 * calls in any single conversation turn ever needs. We don't try to
 * preserve any of the original id's characters even when they happen
 * to be alphanumeric, because a partial-preserve strategy
 * ("strip then pad") collides on similar prefixes (`call_a` and
 * `call_b` both stripping to a 5-char string and getting padded the
 * same way).
 */
export function sanitizeToolCallIdForWire(id: string): string {
  if (WIRE_ID_PATTERN.test(id)) return id;
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let out = '';
  for (let i = 0; i < 9; i++) {
    out += WIRE_ID_ALPHABET[h % 62];
    // Re-mix between digits. A single FNV-1a output is only 32 bits
    // (~5.3 base62 chars of entropy) but we need 9 positions; the
    // xor-shift + multiply step here is the same finalizer xxHash and
    // murmur use, and it spreads the available bits across the output
    // uniformly enough that distinct inputs yield distinct strings in
    // practice. Each step coerces back to an unsigned 32-bit int via
    // `>>> 0`; without that, the JS XOR operator would re-introduce a
    // signed top bit and the next `% 62` would yield a negative
    // index, producing an `undefined` character in the output.
    h = (h ^ (h >>> 16)) >>> 0;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return out;
}

/**
 * Normalise a tool-call's `arguments` JSON string for the wire. Venice
 * (and OpenAI-compatible providers generally) parse the arguments string
 * on their side to validate the request body, so a malformed JSON blob
 * coming back from the model's stream - an unescaped quote inside a
 * free-form string parameter is the usual culprit - surfaces as a Venice
 * HTTP 400 with a Python `json.loads` error message like
 * "Expecting ',' delimiter: line 1 column N (char N-1)". That error blocks
 * every subsequent round and every future turn that replays the offending
 * assistant row from the DB, because the bad arguments string rides along
 * unchanged. The `activity` param required of every tool call (see
 * ACTIVITY_PARAM_SCHEMA in tools/dispatch.ts) is a free-form sentence the
 * model writes itself, which is exactly the shape most prone to this.
 *
 * Parse-and-restringify when the blob is valid JSON (canonicalises
 * whitespace; does not change semantics); substitute `"{}"` when it is
 * not. The locally-stored DB row and the UI render path keep the
 * original string so the user can still see what the model tried to
 * emit - only the copy that goes back to Venice is rewritten. An empty
 * arguments object is a safe substitute because the tool itself already
 * failed locally (the loop catches the JSON.parse error and emits a
 * tool-error result row), so the next round's model sees the failure
 * via the tool result regardless of what the echoed arguments say.
 *
 * Used by:
 *   - chat-loop.ts (toVeniceMessage + the in-loop history push)
 *   - tools/run.ts (the headless agent loop's in-loop history push)
 *   - every agent's messageToVenice helper that projects a stored
 *     Message onto a VeniceMessage (reflection, journal, recall,
 *     conversation_recall, summary).
 */
export function sanitizeToolCallsForWire(
  calls: readonly OpenAIToolCall[]
): OpenAIToolCall[] {
  return calls.map((call) => {
    const raw = call.function.arguments;
    let safe: string;
    if (raw.length === 0) {
      safe = '{}';
    } else {
      try {
        safe = JSON.stringify(JSON.parse(raw));
      } catch {
        safe = '{}';
      }
    }
    const safeId = sanitizeToolCallIdForWire(call.id);
    if (safe === raw && safeId === call.id) return call;
    return {
      ...call,
      id: safeId,
      function: { ...call.function, arguments: safe },
    };
  });
}
