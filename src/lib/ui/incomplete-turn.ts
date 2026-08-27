/**
 * Classification of an incomplete-turn tail in the chat transcript.
 * `classifyIncompleteTurnTail` is the transcript-shape verdict; the
 * matching $derived (`incompleteTurnTail` in src/screens/Chat.svelte)
 * adds the session-state gates on top and decides whether to show the
 * "response appears to have been cut off" retry banner.
 * `retryIncompleteTurn` uses the finer predicates to decide whether
 * the retry must REPLACE the tail or CONTINUE from it.
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
import { parseAskUserContent, ASK_USER_PENDING_FLAG } from '$lib/ask-user';

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

/**
 * Classify the persisted transcript tail, returning the tail message
 * when its shape means the model never got to produce a final reply
 * for the last user turn, or null for a settled transcript. Three
 * tails qualify:
 *
 *   - `tool`: a tool round completed, and the next assistant round
 *     failed before any text was persisted. This is the overload-
 *     mid-turn case: the rate-limit banner that would normally park
 *     a retry closure only lives in memory, so a page refresh wipes
 *     the in-session retry button and leaves the transcript with
 *     nothing after the tool result rows.
 *   - `assistant` with `tool_calls`: the model emitted tool_calls
 *     but the tool executions or the result-persist step failed
 *     before any tool rows landed. Rare, but leaves the same
 *     orphan-turn shape.
 *   - `user`: the user message persisted but the first assistant
 *     round never wrote anything (immediate failure, or refresh
 *     during the very first round before any persistence).
 *
 * A `user` row with `status='draft'` is NOT a cut-off tail: the
 * fork-and-edit flow intentionally leaves a draft user message at
 * the end of a fork for the user to edit and send. The draft is
 * expected, not a failed completion. Once the user sends, the draft
 * is promoted (status cleared to null) and the completion runs
 * normally.
 *
 * This is the persisted-shape half of the verdict only. The caller
 * (the `incompleteTurnTail` derived in src/screens/Chat.svelte) also
 * gates on session state - a turn in progress, an already-displayed
 * streaming error, a foreign device holding the response claim - all
 * of which suppress the banner for reasons that live outside the
 * transcript.
 */
export function classifyIncompleteTurnTail(
  messages: readonly Message[]
): Message | null {
  if (messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (last.role === 'tool') {
    // A pending ask_user sentinel is the chat loop intentionally
    // suspended waiting for the user to answer - not a cut-off
    // response. The AskUserCard already owns this interaction, so
    // offering a "response was cut off, retry?" prompt below it is
    // wrong (retrying would relaunch the turn out from under the
    // open question). The answered/abandoned sentinel is a different
    // story: that tail genuinely lacks a follow-up assistant turn and
    // stays retry-able, so only the pending shape is suppressed here.
    const parsed = parseAskUserContent(last.content);
    if (parsed && ASK_USER_PENDING_FLAG in parsed) return null;
    return last;
  }
  if (last.role === 'assistant') {
    // A user-initiated stop commits as status='aborted' (carrying the
    // interrupted marker). That is a deliberate endpoint, not a cut-off
    // turn - never offer to retry it. Checked before the tool_calls and
    // reasoning-only branches, which would otherwise flag a stop that
    // landed mid-tool-call or mid-reasoning. The status is persisted on
    // the row, so a second device that opens the thread suppresses the
    // banner the same way the device that issued the stop does.
    if (last.status === 'aborted') return null;
    if (last.tool_calls && last.tool_calls.length > 0) return last;
    // Reasoning-only stall (see isReasoningOnlyStall): the model
    // emitted chain-of-thought but no visible content and no tool
    // calls, so the card renders as a bare reasoning panel with no
    // answer. That tail genuinely lacks a follow-up, so make it
    // retry-able. A normal completed turn has content (or tool calls)
    // and is excluded; reasoning paired with either is the model
    // working as intended, not a stall.
    if (isReasoningOnlyStall(last)) return last;
    return null;
  }
  // A draft user message (status='draft') is the fork-and-edit flow
  // waiting for the user to edit and send - an expected state, not a
  // failed completion. Only a non-draft user message at the tail means
  // the completion worker failed before writing anything.
  if (last.role === 'user' && last.status === 'draft') return null;
  if (last.role === 'user') return last;
  return null;
}
