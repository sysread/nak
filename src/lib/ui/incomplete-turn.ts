/**
 * Predicates for classifying an incomplete-turn tail in the chat
 * transcript. The matching $derived (`incompleteTurnTail` in
 * src/screens/Chat.svelte) decides whether to show the "response
 * appears to have been cut off" retry banner; `retryIncompleteTurn`
 * uses the same predicate to decide whether the retry must REPLACE the
 * tail or CONTINUE from it.
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
 */
export function isReasoningOnlyStall(message: Message): boolean {
  if (message.role !== 'assistant') return false;
  if (message.tool_calls && message.tool_calls.length > 0) return false;
  const hasContent = message.content.trim().length > 0;
  const hasReasoning = (message.reasoning ?? '').trim().length > 0;
  return !hasContent && hasReasoning;
}
