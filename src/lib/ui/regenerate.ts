// UI-behavior primitive for the Regenerate button's "what gets
// replaced" computation.
//
// Walks the messages array backward from the clicked assistant row
// to find the user message that opened the turn, then returns every
// row after that user message - the assistant turn itself plus any
// tool rows it spawned, plus all later turns. The chat-loop reissues
// the request anchored on the user message, so everything in that
// range gets replaced when the new completion lands.
//
// Two callers in Chat.svelte:
//   - regenerateFrom() commits the range to `pendingDeleteIds` and
//     fires runExchange. Rows greyed via .regen-target stay greyed
//     until the new turn lands cleanly (or the abort/error restores).
//   - the hover-preview handler on the Regenerate button writes the
//     range to `hoverRegenerateIds` so the same .regen-target class
//     paints the affected rows while the user hovers, without
//     committing.
//
// Returns an empty array when the input is malformed (no preceding
// user message, the clicked id isn't in the array, the user message
// is the tail and no rows follow). Callers no-op on empty.

import type { Message } from '$lib/supabase';

/**
 * Compute the would-be-replaced message ids for a Regenerate click on
 * `assistantMessageId`. Pure: same inputs return the same output, no
 * side effects on the messages array.
 */
export function computeRegenerateRangeIds(
  messages: readonly Message[],
  assistantMessageId: string,
): string[] {
  const clickedIdx = messages.findIndex((m) => m.id === assistantMessageId);
  if (clickedIdx === -1) return [];
  // Walk back to the user message that opened this turn. Skip
  // assistant + tool rows from the same and earlier rounds. The first
  // user row we see anchors the regenerate; everything after it
  // (inclusive of intermediate tool/assistant rows AND any later
  // turns) is the replace range.
  let userIdx = -1;
  for (let i = clickedIdx; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      userIdx = i;
      break;
    }
  }
  if (userIdx === -1) return [];
  const replaceRange = messages.slice(userIdx + 1);
  return replaceRange.map((m) => m.id);
}
