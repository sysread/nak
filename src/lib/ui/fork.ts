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

/**
 * Ids of the rows in the SHARED region of a transcript: the prefix
 * other conversations depend on. A row is shared when it is inherited
 * (owned by an ancestor thread) or sits at-or-before the latest fork
 * point any child thread minted from this one. Destructively editing
 * a shared row would rewrite those other conversations' history, so
 * delete-from-here and regenerate switch to the edit-fork flow when
 * their range touches this set; edits strictly inside the private
 * tail stay destructive, exactly as before forks existed.
 *
 * `childForkPointIds` is the set of fork-point message ids of every
 * child thread, HIDDEN CHILDREN INCLUDED: a hidden child awaiting GC
 * may still carry live descendants that resolve their history through
 * this prefix, and when it doesn't, counting it costs at most an
 * unnecessary fork - conservative in the direction that can never
 * corrupt another timeline. Child fork points are by construction
 * own-segment rows (the reparent rule points a fork at the thread
 * that OWNS its fork-point message), so every id in the set is
 * expected to appear in `messages`; unknown ids are simply inert.
 */
export function sharedRowIds(
  messages: ReadonlyArray<{ id: string; thread_id?: string | null }>,
  threadId: string,
  childForkPointIds: ReadonlySet<string>,
): Set<string> {
  let boundary = -1;
  for (let i = 0; i < messages.length; i++) {
    const tid = messages[i].thread_id;
    const inherited = typeof tid === 'string' && tid !== threadId;
    if (inherited || childForkPointIds.has(messages[i].id)) boundary = i;
  }
  return new Set(messages.slice(0, boundary + 1).map((m) => m.id));
}

/**
 * The row a delete-from-here edit-fork anchors on: the closest row
 * BEFORE the deleted range that can anchor a fork, walking past rows
 * a fork cannot cut at (a dangling tool row, a mid-round assistant,
 * a synthetic recovery row). Walking past an unanchorable row drops
 * it from the fork too, which matches what the anchor rules exist
 * for - a prefix ending mid-exchange is not a coherent conversation.
 *
 * Returns null when nothing before the range qualifies; the caller
 * degrades to "fresh thread + hide the old one" (a fork with an
 * empty prefix is just a new thread - no parent link needed).
 */
export function deleteForkAnchor(
  messages: readonly Message[],
  userMessageId: string,
): Message | null {
  const idx = messages.findIndex((m) => m.id === userMessageId);
  if (idx <= 0) return null;
  for (let i = idx - 1; i >= 0; i -= 1) {
    if (canForkAtMessage(messages[i])) return messages[i];
  }
  return null;
}

/**
 * Tooltip copy for the delete-from-here button. In a shared region
 * the visible outcome is identical - this message and everything
 * after it disappear from the conversation the user is looking at -
 * but the mechanism is a fork-and-hide, and the copy says so. The
 * outline stays the same red in both cases on purpose: one danger
 * language for "this range is affected".
 */
export function deleteFromTitle(shared: boolean): string {
  return shared
    ? 'Delete this message and everything after it - the conversation continues in a new fork'
    : 'Delete this message and everything after it';
}

/** Tooltip copy for the regenerate button; same rule as deleteFromTitle. */
export function regenerateTitle(shared: boolean): string {
  return shared
    ? 'Regenerate this response - the conversation continues in a new fork'
    : 'Regenerate this response (replaces this and any following messages)';
}
