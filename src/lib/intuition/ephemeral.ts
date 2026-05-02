/**
 * Build the ephemeral assistant message that injects the cached
 * intuition into a Venice request.
 *
 * The synthesis output is wrapped in `<think>` tags and placed in
 * an assistant role, mirroring the existing opening-recall pattern
 * in chat-loop.ts (search for "Push the opening-recall <think>
 * block"). The model reads it as its own prior thought - "I just
 * had this thought before responding" - which is exactly the
 * register the synthesis prompt produces.
 *
 * The ephemeral message is NEVER persisted. It's reconstructed
 * fresh from the cached payload at request time, on every round
 * where the cache should be visible to the model. Same payload,
 * same projection - cache is the single source of truth.
 *
 * We attach a tagged-marker prefix `<!-- intuition-think -->` so
 * the UI's message-list renderer can later distinguish a synthetic
 * intuition turn from a normal `<think>` block (we don't currently
 * render `<think>` blocks at all, but the marker is here for when
 * the inline UI lands and needs to gate). The marker is inside the
 * `<think>` block so the LLM ignores it - HTML comments in `<think>`
 * are common scratch output and the model treats them as noise.
 */
import type { VeniceMessage } from '../venice';
import type { IntuitionPayload } from './types';

/** Marker comment placed inside the `<think>` block so the UI can
 *  identify synthetic intuition turns when (later) it renders
 *  intuition cards inline. The LLM ignores HTML comments inside
 *  thought tags - see the file-level comment for rationale. */
export const INTUITION_THINK_MARKER = '<!-- intuition-think -->';

/**
 * Project a cached payload into a Venice message ready to splice
 * into a chat-loop history array. The output is always one message;
 * callers append it directly.
 */
export function buildIntuitionThinkMessage(
  payload: IntuitionPayload
): VeniceMessage {
  const content = `<think>\n${INTUITION_THINK_MARKER}\n${payload.synthesis}\n</think>`;
  return { role: 'assistant', content };
}
