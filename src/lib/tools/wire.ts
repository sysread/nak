/**
 * Wire helpers for tool calls. Pure utilities that handle the
 * OpenAI/Venice wire format in both directions - projecting ToolDefs
 * and stored tool calls onto the wire (toOpenAIToolDef,
 * sanitizeToolCallsForWire, sanitizeToolCallIdForWire), and parsing
 * the inbound arguments JSON string into a usable args object
 * (parseToolArguments). No other dependencies, so anyone touching
 * tool-call wire data - the chat loop, the no-tool completion agents
 * (summary, topics) that replay stored threads - can call in without
 * dragging chat-loop along. Keeping the helpers here means a fix or
 * extension lands in one place rather than five copies.
 */

import type { OpenAIToolCall, OpenAIToolDef, ToolDef } from './types';

/**
 * Pattern Venice's strict tool_call_id validator accepts: alphanumeric
 * only, exactly 9 chars. Some Venice-routed model backends 400 the
 * whole request with the message "Tool call id was X but must be a-z,
 * A-Z, 0-9, with a length of 9" when an id violates this - including
 * ids of the shape `call_a031` that those same backends generate. The
 * mismatch shows up most often on the headless agent loops (reflection,
 * wiki, summary) and on the main chat-loop's multi-round tool
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
 * ACTIVITY_PARAM_SCHEMA below) is a free-form sentence the
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
 * Used by chat/loop.ts (toVeniceMessage + the in-loop history push)
 * and the no-tool completion agents' messageToVenice helpers that
 * project a stored Message onto a VeniceMessage (summary, topics).
 * The venice function's agent runner carries its own mirror of this
 * discipline.
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
 * Throws on invalid JSON. The caller (chat/loop.ts) catches the
 * throw and surfaces it as a tool error so the next round sees the
 * parse failure instead of a silent default.
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

/**
 * Schema for the `activity` parameter we inject into every tool's
 * arguments. The LLM fills it with a short present-tense sentence
 * narrating what this specific call is doing; the chat UI surfaces the
 * sentence above the tool name while the call is in flight and after
 * it completes, so the user sees a plain-language trace of the model's
 * moves instead of a wall of schema calls. Kept deliberately terse so
 * the model doesn't pad it into a paragraph.
 *
 * Parameter name `activity` rather than `note` to avoid colliding with
 * memory_relate's existing `note` argument (the edge annotation). Names
 * this module owns are invisible to tool handlers - injected into the
 * wire schema here, ignored by every handler that reads specific keys.
 * (The venice function's agent runner injects the same parameter for
 * progress-observed agent runs; see supabase/functions/venice/agents/
 * _run.ts.)
 */
const ACTIVITY_PARAM_SCHEMA = {
  type: 'string',
  description:
    'REQUIRED. One short present-tense sentence, addressed to the user, ' +
    'narrating what you are doing with this specific call - e.g. ' +
    '"Searching your memories for notes about the dishwasher", ' +
    '"Saving that pancake recipe to your cookbook". Keep it under ' +
    '100 characters. Surfaced prominently in the UI above the tool ' +
    "name so the user can see what's happening without opening the " +
    'call details.',
} as const;

/**
 * Merge the shared `activity` property into a tool's JSON Schema
 * without mutating the original. We inject at the wire-projection
 * layer rather than forcing every ToolDef to declare it, so adding a
 * new tool doesn't require remembering the convention. `activity` is
 * added to `required` so the model can't silently omit it, and the
 * rest of the schema (including `additionalProperties: false`) rides
 * through untouched.
 */
function injectActivityParam(
  parameters: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...parameters };
  const existing = (out.properties as Record<string, unknown> | undefined) ?? {};
  out.properties = { ...existing, activity: ACTIVITY_PARAM_SCHEMA };
  const required = Array.isArray(out.required)
    ? [...(out.required as unknown[])]
    : [];
  if (!required.includes('activity')) required.push('activity');
  out.required = required;
  // If the tool's schema didn't declare `type`, default it to 'object'
  // so `properties` / `required` are meaningful to the model. Tools in
  // this codebase all declare `type: 'object'`, but test fixtures
  // sometimes ship `parameters: {}` - keep them valid.
  if (out.type === undefined) out.type = 'object';
  return out;
}

/**
 * Translate a ToolDef into the OpenAI / Venice request shape. Venice
 * mirrors OpenAI's `/chat/completions` `tools` parameter exactly.
 *
 * We project an `activity` string into every tool's parameters at this
 * seam so the model must narrate what it's doing on every call; see
 * `injectActivityParam` above for the rationale.
 */
export function toOpenAIToolDef(t: ToolDef): OpenAIToolDef {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: injectActivityParam(t.parameters),
    },
  };
}
