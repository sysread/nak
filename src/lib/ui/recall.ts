/**
 * UI-behavior primitives for the Recall diagnostic modal. Pure
 * functions only - no runes, no Svelte imports, no DOM access. The
 * companion `src/screens/Recall.svelte` composes these with its own
 * runes ($derived for `payload` and `entries`, $props for the
 * threads / history / userMessageByRound props) and renders the
 * result; Chat.svelte mirrors the history map mutator on its
 * Svelte $state. A port to React would re-use this module untouched.
 *
 * The decisions encoded here are the ones the README in this
 * directory enumerates as primary candidates: how raw inputs
 * become a visible list (buildRecallEntries), what label an enum
 * value gets in the UI (formatRecallTrigger), how a timestamp
 * renders (formatRecallTimestamp), the next-state computation for
 * the per-thread history Map (appendContextRecallHistory), the
 * dedup guard at the chat-loop callback site (shouldRetainDisplaced),
 * and the walk that pairs a round number with the user message
 * that triggered the injection (buildUserMessageByRound).
 *
 * Type imports from `$lib/context-recall` and `$lib/supabase` are
 * fine - the payload and message shapes are domain types, not
 * framework types. A React port would still consume them.
 */
import type { ContextRecallPayload } from '../context-recall';
import type { Message } from '../supabase';

/**
 * Assemble the descending-by-turn list the Recall modal body
 * renders. The current payload (if any) leads; the in-memory
 * history follows in reverse-landing order (most recent first).
 *
 * Empty-note entries are dropped at both layers: an injection that
 * resolved to "nothing to say" - the cached negative result the
 * trigger evaluator uses to debounce a re-run - carries no
 * diagnostic value here and just produces a hollow row. The
 * current payload is the caller's responsibility to gate on
 * non-empty before passing in (Recall.svelte's `payload` derived
 * already does that for the active thread's row); this function
 * still filters defensively in case a future caller wires it
 * differently.
 */
export function buildRecallEntries(
  current: ContextRecallPayload | null,
  history: readonly ContextRecallPayload[]
): readonly ContextRecallPayload[] {
  const out: ContextRecallPayload[] = [];
  if (current !== null && current.note.trim().length > 0) {
    out.push(current);
  }
  for (let i = history.length - 1; i >= 0; i--) {
    const p = history[i];
    if (p.note.trim().length > 0) out.push(p);
  }
  return out;
}

/**
 * Map a context-recall trigger enum value to its user-facing label.
 * Same taxonomy as intuition (cold / title / mood / stale); the
 * labels here are tuned for the Recall modal's voice (sentence-
 * fragment phrases that sit comfortably in a meta line next to a
 * timestamp).
 */
export function formatRecallTrigger(
  t: ContextRecallPayload['trigger']
): string {
  switch (t) {
    case 'title':
      return 'topic shift (title changed)';
    case 'mood':
      return 'mood shift';
    case 'stale':
      return 'staleness fuse';
    case 'cold':
      return 'first read on this thread';
  }
}

/**
 * Format a wall-clock ms timestamp for the per-entry meta line.
 * Falls back to the raw number when toLocaleString throws (which
 * shouldn't happen for finite numbers, but the original inline
 * helper guarded against it and the contract stays the same).
 */
export function formatRecallTimestamp(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

/**
 * Decide whether a payload that's about to be displaced by a fresher
 * one is worth retaining in this tab's in-memory history. The guard
 * fires at the chat-loop's onContextRecallUpdate callback site, NOT
 * at rebucketThread - cross-tab realtime echoes carrying the SAME
 * payload our optimistic patch already applied would otherwise
 * cause a duplicate push. Comparing computed_at_at is sufficient:
 * the chat-loop's writer stamps the field at write time and two
 * distinct injections always have different stamps.
 */
export function shouldRetainDisplaced(
  displaced: ContextRecallPayload,
  incoming: ContextRecallPayload
): boolean {
  return displaced.computed_at_at !== incoming.computed_at_at;
}

/**
 * Next-state computation for the per-thread history Map. Returns a
 * fresh Map (the caller is responsible for assigning it into Svelte
 * $state to trigger reactivity). The displaced payload is appended
 * to the existing per-thread list - landing order, oldest first -
 * matching what buildRecallEntries expects on the way back out.
 */
export function appendContextRecallHistory(
  history: ReadonlyMap<string, readonly ContextRecallPayload[]>,
  threadId: string,
  displaced: ContextRecallPayload
): Map<string, ContextRecallPayload[]> {
  const next = new Map<string, ContextRecallPayload[]>();
  for (const [k, v] of history) next.set(k, [...v]);
  const prior = next.get(threadId) ?? [];
  next.set(threadId, [...prior, displaced]);
  return next;
}

/**
 * Walk the thread's messages in transcript order and build a map
 * keyed by user-round (1..N counting only user rows) pointing at
 * the user Message that opened that round. Same counting rule the
 * chat-loop's countUserRounds() uses at fire time, so the keys
 * here line up 1:1 with ContextRecallPayload.computed_at_round.
 *
 * Tool and assistant rows do not advance the counter; an edited or
 * deleted user message produces a gap (the round number whose
 * message has been removed will simply be absent from the map),
 * which the modal renders as a "(user message no longer available)"
 * fallback rather than dropping the entry.
 */
export function buildUserMessageByRound(
  messages: readonly Message[]
): Map<number, Message> {
  const map = new Map<number, Message>();
  let n = 0;
  for (const m of messages) {
    if (m.role === 'user') {
      n += 1;
      map.set(n, m);
    }
  }
  return map;
}
