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
    if (safe === raw) return call;
    return {
      ...call,
      function: { ...call.function, arguments: safe },
    };
  });
}
