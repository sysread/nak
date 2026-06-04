// Wire-shape helpers for the agent loop. Mirror of src/lib/tools/wire.ts
// minus the parts that drag in browser-side types - same regex, same
// hashing constants, same double-escape recovery rule. Used by the
// function-side agent driver (./run.ts) when projecting in-loop tool
// calls back onto the wire shape Venice's strict validators expect.

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// Pattern Venice's strict tool_call_id validator accepts: alphanumeric
// only, exactly 9 chars. Some Venice-routed model backends 400 the
// whole request with the message "Tool call id was X but must be a-z,
// A-Z, 0-9, with a length of 9" when an id violates this - including
// ids of the shape `call_a031` that those same backends generate.
const WIRE_ID_PATTERN = /^[a-zA-Z0-9]{9}$/;

const WIRE_ID_ALPHABET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Map an arbitrary tool-call id to a stable 9-char alphanumeric string
 * for the Venice wire. Idempotent: an id that already matches
 * WIRE_ID_PATTERN passes through unchanged. The assistant turn's
 * tool_calls[].id and the matching tool-result row's tool_call_id MUST
 * land at the same value after sanitisation - OpenAI-compatible
 * providers reject a message list where a tool result doesn't pair
 * with a preceding assistant call by id. Hashing the original id lets
 * both sides produce the same output without any shared state.
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
    h = (h ^ (h >>> 16)) >>> 0;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return out;
}

/**
 * Normalise a tool-call's arguments JSON string for the wire and
 * sanitise its id. Parse-and-restringify when the blob is valid JSON
 * (canonicalises whitespace; does not change semantics); substitute
 * "{}" when it isn't. Venice (and OpenAI-compatible providers
 * generally) parse the arguments string on their side to validate the
 * request body, so a malformed JSON blob coming back from the model -
 * an unescaped quote inside a free-form string parameter is the usual
 * culprit - would 400 every subsequent round.
 */
export function sanitizeToolCallsForWire(
  calls: readonly OpenAIToolCall[],
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
 * Parse a tool-call arguments JSON string into a plain args object,
 * recovering from a known LLM bug where smaller models double-escape
 * special characters in free-form string fields. Throws on invalid
 * JSON; the agent driver catches the throw and surfaces it as a tool
 * error so the next round sees the parse failure instead of a silent
 * empty-args default.
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
  // sequence AND zero real whitespace characters of the same kinds.
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
 * Encode a tool's return value (or error) into the string content
 * field that OpenAI's tool-result messages expect. Always JSON so the
 * model sees structured data rather than a toString rendering.
 */
export function encodeToolContent(
  result: { ok: true; value: unknown } | { ok: false; error: Error },
): string {
  if (result.ok) {
    try {
      return JSON.stringify(result.value ?? null);
    } catch {
      return JSON.stringify({ error: 'result not serializable' });
    }
  }
  return JSON.stringify({
    error: result.error.message || String(result.error),
  });
}
