/**
 * UI-behavior primitives for the subconscious-priming checklist shown
 * in the streaming bubble while the chat-loop's three pre-response
 * pipelines run for a turn (samskara fire, intuition, context recall).
 *
 * Pure functions only - no runes, no Svelte imports, no DOM access. The
 * reactive status map lives on ExchangeSlot; this module owns the op ->
 * label map, the running/done row shape, and the stable render ordering
 * so the .svelte template stays glue (it picks a value, it doesn't
 * derive one).
 *
 * The `SubconsciousOp` type import from `$lib/chat-loop` is the signal
 * vocabulary the chat-loop emits; importing it here keeps the label map
 * keyed off the same union the producer uses, so adding a fourth
 * pipeline is a compile error here until its label is supplied.
 */
import type { SubconsciousOp } from '../chat-loop';

/**
 * A pipeline is 'running' from its onSubconsciousStart until its
 * onSubconsciousEnd, then 'done'. The checklist renders a spinner for
 * 'running' and a checkmark for 'done' - the row persists through the
 * transition so the user sees the item check off, rather than vanish.
 */
export type SubconsciousStatus = 'running' | 'done';

export interface SubconsciousRow {
  op: SubconsciousOp;
  status: SubconsciousStatus;
}

/**
 * Human-readable status line for each pipeline. A single bare gerund -
 * the spinner carries "in progress" and the checkmark carries "done",
 * so the label stays a constant one-word activity as the icon swaps
 * (the classic checklist read). The wording describes the felt
 * activity, not the implementation ("Recalling", not "Running memory +
 * conversation recall").
 */
export function subconsciousLabel(op: SubconsciousOp): string {
  switch (op) {
    case 'samskara':
      return 'Reacting';
    case 'intuition':
      return 'Predicting';
    case 'recall':
      return 'Recalling';
  }
}

// Stable display order, matching the order the chat-loop injects the
// pipelines' synthetic <think> blocks (recall is read first by the
// model, but the fire is the earliest to start, so the rows read
// fire -> intuition -> recall as a rough start-time order). Without an
// explicit sort the rows would reorder as the map's iteration order
// shifts across set/delete, making the checklist jump mid-turn.
const ORDER: readonly SubconsciousOp[] = ['samskara', 'intuition', 'recall'];

/**
 * The pipelines that have fired this turn, in stable display order,
 * each carrying its current running/done status. Filtering ORDER
 * (rather than iterating the map) is what pins the row order regardless
 * of the sequence starts/ends arrived in.
 */
export function orderedSubconsciousRows(
  status: ReadonlyMap<SubconsciousOp, SubconsciousStatus>
): SubconsciousRow[] {
  return ORDER.flatMap((op) => {
    const s = status.get(op);
    return s ? [{ op, status: s }] : [];
  });
}
