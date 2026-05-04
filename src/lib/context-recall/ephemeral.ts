/**
 * Build the ephemeral assistant message that injects the cached
 * context-recall note into a Venice request.
 *
 * Same shape as opening-recall and intuition: the stitched note is
 * wrapped in `<think>` tags and placed in an assistant role, so the
 * model reads it as its own prior thought - "I just remembered this
 * before responding." The first-person voice the child agents emit
 * ("I remember...", "Last time we talked about this, we...") is
 * already in the right register; the wrapper just frames it as
 * recollection rather than dialog.
 *
 * Empty-note short-circuit: a payload with `note === ''` represents
 * a cached "both children returned empty this round" result. Callers
 * are expected to skip injection in that case rather than push an
 * empty <think> block (which would just burn tokens). We return
 * `null` to signal "nothing to inject"; the caller treats null
 * exactly like a missing cache.
 *
 * The marker comment matches the intuition pattern - it lets a
 * future UI surface (a debug drawer rendering ephemeral synthetic
 * turns) distinguish a context-recall <think> block from an
 * intuition one. The LLM ignores HTML comments inside thought tags;
 * this is purely for tooling.
 */
import type { VeniceMessage } from '../venice';
import type { ContextRecallPayload } from './types';

/** Marker comment placed inside the `<think>` block so a future debug
 *  surface can identify synthetic context-recall turns. The LLM
 *  ignores HTML comments inside thought tags. */
export const CONTEXT_RECALL_THINK_MARKER = '<!-- context-recall-think -->';

/**
 * Project a cached payload into a Venice message ready to splice
 * into a chat-loop history array. Returns null when the cached note
 * is empty - the caller should treat null identically to "no cache"
 * (skip the injection entirely; do not push an empty <think> block).
 */
export function buildContextRecallThinkMessage(
  payload: ContextRecallPayload
): VeniceMessage | null {
  if (payload.note.length === 0) return null;
  const content = `<think>\n${CONTEXT_RECALL_THINK_MARKER}\n${payload.note}\n</think>`;
  return { role: 'assistant', content };
}
