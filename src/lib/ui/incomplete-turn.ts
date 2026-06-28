/**
 * Predicates for classifying an incomplete-turn tail in the chat
 * transcript. The matching $derived (`incompleteTurnTail` in
 * src/screens/Chat.svelte) decides whether to show the "response
 * appears to have been cut off" retry banner; `retryIncompleteTurn`
 * uses these predicates to decide whether the retry must REPLACE the
 * tail or CONTINUE from it.
 *
 * REPLACE vs CONTINUE: a tail is a continuation point when its
 * persisted rows are exactly what the model needs to pick up - an
 * orphaned tool round (the tool results are the fuel) or a bare user
 * message. A tail is a DEAD turn when there's nothing coherent to
 * build on - a reasoning-only stall (isReasoningOnlyStall) or a
 * visible answer the stream cut off mid-sentence (isCutOffPartialText).
 * Retry replaces a dead turn (red-outline + atomic delete on commit,
 * the same machinery the Regenerate button uses) rather than appending
 * a continuation beneath it.
 *
 * Interacts with: src/screens/Chat.svelte (the banner derived + the
 * retry handler), src/lib/supabase.ts (the Message shape).
 */

import type { Message } from '$lib/supabase';

/**
 * True when `message` is a reasoning-only stall: an assistant row that
 * carries chain-of-thought but no visible content and no tool calls.
 * Seen when a model fences its tool call in a non-standard syntax (e.g.
 * DSML markers) the parser doesn't recognize - the whole turn lands in
 * `reasoning`, `content` stays empty, and `tool_calls` is null, so the
 * row renders as a bare reasoning panel with no answer.
 *
 * This shape is a DEAD turn, not a continuation point: unlike an
 * orphaned tool round (where the persisted tool result is exactly what
 * the model needs to pick up), there's nothing here for a continuation
 * to build on. Retrying it must delete the row and re-roll, otherwise
 * the empty bubble lingers above the fresh answer.
 *
 * Excludes status='aborted' for the same reason isCutOffPartialText
 * does: a user-initiated stop is a deliberate endpoint we leave alone,
 * never a stall to retry. The aborted terminal appends the interrupted
 * marker to content (so the common stop-after-some-text case already
 * fails the !hasContent test), but a stop that landed during a
 * reasoning-only stretch produces a marker-only row whose reasoning
 * survives - the status gate, not the incidental marker, is what keeps
 * that off the retry path. The gate also holds across devices: the
 * status rides the persisted row, so a second device classifies the
 * stop the same way the device that issued it would.
 */
export function isReasoningOnlyStall(message: Message): boolean {
  if (message.role !== 'assistant') return false;
  if (message.status === 'aborted') return false;
  if (message.tool_calls && message.tool_calls.length > 0) return false;
  const hasContent = message.content.trim().length > 0;
  const hasReasoning = (message.reasoning ?? '').trim().length > 0;
  return !hasContent && hasReasoning;
}

/**
 * True when `message` is a partial-text cutoff: an assistant row the
 * streaming function marked `status='error'` mid-reply, carrying the
 * visible text it accumulated up to the break but no tool calls. The
 * edge function persists whatever it streamed before the failure (the
 * terminal write in getStreamingResponse.ts), so the half-finished
 * answer survives as a real DB row and renders as a normal card with
 * the error banner beneath it - rather than vanishing the way the old
 * browser-owned streaming buffer did.
 *
 * Like a reasoning-only stall this is a DEAD turn for retry purposes:
 * continuing from a sentence that stops mid-thought reads disjointly,
 * so Retry REPLACES the row (red-outline while the re-roll runs, atomic
 * delete when the fresh answer commits) instead of appending a second
 * card beneath it.
 *
 * The `status='error'` gate is load-bearing: a legitimately short reply
 * that finished on its own commits as `'complete'` and must stay a
 * continuation point, never a replace target. A user-initiated stop
 * commits as `'aborted'` (carrying the interrupted marker) and is a
 * deliberate endpoint we leave alone. Only the error terminal means the
 * visible answer was genuinely cut off.
 */
export function isCutOffPartialText(message: Message): boolean {
  if (message.role !== 'assistant') return false;
  if (message.tool_calls && message.tool_calls.length > 0) return false;
  if (message.status !== 'error') return false;
  return message.content.trim().length > 0;
}
