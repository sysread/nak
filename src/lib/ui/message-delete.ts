// UI-behavior primitive for the user message's "delete from here"
// button's range computation.
//
// Returns the clicked user message plus every row after it - the
// assistant reply it opened, any tool rows that turn spawned, and all
// later turns. Deleting that range reverts the thread to the state it
// was in just before the user sent the clicked message.
//
// Sibling of computeRegenerateRangeIds in regenerate.ts: regenerate
// anchors on the user message and replaces everything AFTER it (the
// user message survives, the turn re-runs); delete-from-here includes
// the user message itself and re-runs nothing. Both narrow the range
// to persisted rows via persistedRowIds before issuing a DB mutation -
// synthetic recovery rows have sentinel ids that no DB row matches.
//
// Returns an empty array when the input is malformed (the id isn't in
// the array, or the matched row isn't a user message - the button only
// renders on user rows, but the guard keeps the contract honest).
// Callers no-op on empty.

import type { Message } from '$lib/supabase';

/**
 * Compute the ids to delete for a "delete from here" click on
 * `userMessageId`: that row and everything after it, in order. Pure:
 * same inputs return the same output, no side effects.
 */
export function computeDeleteFromRangeIds(
  messages: readonly Message[],
  userMessageId: string,
): string[] {
  const idx = messages.findIndex((m) => m.id === userMessageId);
  if (idx === -1) return [];
  if (messages[idx].role !== 'user') return [];
  return messages.slice(idx).map((m) => m.id);
}
