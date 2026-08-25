// UI-behavior primitives for the message-card Fork button: which
// rows get the button, and which rows the hover preview outlines.
//
// Sibling of computeRegenerateRangeIds (regenerate.ts) and
// computeDeleteFromRangeIds (message-delete.ts), with one semantic
// difference the tooltip copy carries: the outlined rows are not
// doomed. Forking copies the prefix up to and including the clicked
// row into a new conversation; everything after the fork point simply
// STAYS in this one. The preview borrows the shared regen-preview
// channel (same red outline) to show which rows the fork leaves
// behind, but a fork deletes nothing.
//
// The eligibility rules themselves live in src/lib/forking.ts
// (isValidForkPoint) because the server-side whole-conversation fork
// walks the same rules; this module adapts them to the in-memory
// Message shape and adds the one browser-only concern: synthetic
// recovery rows.

import type { Message } from '$lib/supabase';
import { isValidForkPoint } from '$lib/forking';

/**
 * True when this row's card should offer the Fork button: a valid
 * fork point (user row, or settled assistant row without tool calls)
 * that actually exists in the DB. Synthetic recovery rows carry
 * sentinel ids no DB row matches - forkThread would reject the id -
 * so they never offer the button even when their role qualifies.
 */
export function canForkAtMessage(m: Message): boolean {
  if (m.synthetic) return false;
  return isValidForkPoint({
    id: m.id,
    role: m.role,
    tool_calls: m.tool_calls ?? null,
    status: m.status ?? null,
  });
}

/**
 * Compute the ids the fork-button hover preview outlines: every row
 * strictly AFTER the fork point. The fork point itself is part of the
 * copied prefix, so it stays un-outlined. Pure: same inputs return
 * the same output, no side effects.
 *
 * Returns an empty array both when the input is malformed (the id
 * isn't in the array, or the matched row can't anchor a fork) and
 * when the fork point is the transcript tail - in either case there
 * is nothing to outline, and the click handler doesn't consume the
 * range at all (the server recomputes the prefix from the fork-point
 * id), so the ambiguity is harmless.
 */
export function computeForkRangeIds(
  messages: readonly Message[],
  forkMessageId: string,
): string[] {
  const idx = messages.findIndex((m) => m.id === forkMessageId);
  if (idx === -1) return [];
  if (!canForkAtMessage(messages[idx])) return [];
  return messages.slice(idx + 1).map((m) => m.id);
}
