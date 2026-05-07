/**
 * Wire helpers for tool calls. Pure utilities that handle the
 * OpenAI/Venice wire format in both directions - projecting stored or
 * in-loop tool calls back onto the wire (sanitizeToolCallsForWire,
 * sanitizeToolCallIdForWire), and parsing the inbound arguments JSON
 * string into a usable args object (parseToolArguments). No other
 * dependencies, so anyone touching tool-call wire data - the chat
 * loop, the headless agent loop in `./run.ts`, every agent that
 * replays a stored thread (reflection, journal, recall,
 * conversation_recall, summary) - can call in without dragging
 * chat-loop along. Keeping the helpers here means a fix or extension
 * lands in one place rather than five copies.
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

/**
 * Parse a tool-call `arguments` JSON string into a plain args object,
 * recovering from a known LLM bug where smaller models double-escape
 * special characters in free-form string fields.
 *
 * Failure mode: a model emits a tool call whose arguments JSON looks
 * like `{"data": "line1\\nline2"}` when it meant `{"data":
 * "line1\nline2"}`. JSON.parse decodes `\\n` to a literal backslash-n
 * (2 chars), not a newline. The string is stored as-is and shows up
 * with literal `\n` everywhere a newline should be - the screenshot
 * that prompted this fix had a multi-paragraph memory body with a
 * dozen `\n` sequences and no real newlines anywhere.
 *
 * Detection rule: only unescape `\n`, `\r`, `\t` when the string
 * contains the literal escape AND has no actual newline / CR / tab.
 * A mixed string (some real, some literal) is left alone - the
 * literal `\n` could be intentional (e.g. a memory discussing JS
 * escape syntax) and we have no way to disambiguate. Pure
 * double-escape, the common failure mode, is unambiguous and safe to
 * fix. The walker recurses through arrays and nested objects so a
 * tool whose schema nests free-form fields under a wrapper still
 * benefits.
 *
 * Throws on invalid JSON. Callers (chat-loop.ts, tools/run.ts) catch
 * the throw and surface it as a tool error so the next round sees
 * the parse failure instead of a silent default.
 */
export function parseToolArguments(raw: string): Record<string, unknown> {
  if (raw.length === 0) return {};
  const parsed = JSON.parse(raw) as unknown;
  return recoverDoubleEscapedStrings(parsed) as Record<string, unknown>;
}

function recoverDoubleEscapedStrings(value: unknown): unknown {
  if (typeof value === 'string') return recoverEscapesInString(value);
  if (Array.isArray(value)) return value.map(recoverDoubleEscapedStrings);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = recoverDoubleEscapedStrings(v);
    }
    return out;
  }
  return value;
}

function recoverEscapesInString(s: string): string {
  // Two-step gate: the string must carry at least one literal escape
  // sequence (otherwise nothing to do) AND zero real whitespace
  // characters of the same kinds (otherwise we'd be guessing whether
  // a literal `\n` was intentional).
  const hasLiteral =
    s.includes('\\n') || s.includes('\\r') || s.includes('\\t');
  if (!hasLiteral) return s;
  if (s.includes('\n') || s.includes('\r') || s.includes('\t')) return s;
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}
