/**
 * Draft-message support for the fork-and-edit flow. Pure functions
 * only - no runes, no Svelte imports, no side effects.
 *
 * A draft is a user message row with status='draft' that exists only
 * in the fork-and-edit flow, between the click and the send. The
 * composer reads from it; on send it is promoted to status=null and
 * the completion runs normally. See
 * docs/dev/in-progress/user-message-editing.md for the full design.
 */
import type { Message } from '../supabase';

/**
 * Scan a message list for a row with status='draft'. Returns the
 * draft row (there should be at most one - the invariant is "drafts
 * are always user messages at the end of the conversation") or null
 * when no draft exists.
 *
 * The scan reads every row rather than assuming the draft is last:
 * the invariant is maintained by construction (only the
 * fork-and-edit handler creates drafts, and it always creates them
 * at the tail), but a defensive full scan costs nothing and is
 * robust against a future caller that violates the invariant.
 */
export function findDraftMessage(
  messages: readonly Message[]
): Message | null {
  for (const m of messages) {
    if (m.status === 'draft') return m;
  }
  return null;
}
