/**
 * UI-behavior primitives for the subconscious-priming status throbbers
 * shown in the streaming bubble while the chat-loop's three pre-response
 * pipelines run for a turn (samskara fire, intuition, context recall).
 *
 * Pure functions only - no runes, no Svelte imports, no DOM access. The
 * reactive set of in-flight ops lives on ExchangeSlot; this module owns
 * the op -> label map and the stable render ordering so the .svelte
 * template stays glue (it picks a value, it doesn't derive one).
 *
 * The `SubconsciousOp` type import from `$lib/chat-loop` is the signal
 * vocabulary the chat-loop emits; importing it here keeps the label map
 * keyed off the same union the producer uses, so adding a fourth
 * pipeline is a compile error here until its label is supplied.
 */
import type { SubconsciousOp } from '../chat-loop';

/**
 * Human-readable status line for each pipeline. Phrased as a bare
 * present-progressive activity ("Predicting outcomes") so the row reads
 * as the model's own pre-response thinking rather than a system log
 * line; the template appends the trailing ellipsis. The wording
 * deliberately describes the felt activity, not the implementation -
 * "Remembering past interactions", not "Running memory + conversation
 * recall".
 */
export function subconsciousLabel(op: SubconsciousOp): string {
  switch (op) {
    case 'samskara':
      return 'Reacting to the situation';
    case 'intuition':
      return 'Predicting outcomes';
    case 'recall':
      return 'Remembering past interactions';
  }
}

// Stable display order, matching the order the chat-loop injects the
// pipelines' synthetic <think> blocks (recall is read first by the
// model, but the fire is the earliest to start, so the throbbers read
// fire -> intuition -> recall as a rough start-time order). Without an
// explicit sort the rows would reorder as the set's iteration order
// shifts across add/delete, making the throbber list jump mid-turn.
const ORDER: readonly SubconsciousOp[] = ['samskara', 'intuition', 'recall'];

/**
 * The in-flight ops in stable display order. Filtering ORDER (rather
 * than iterating the set) is what pins the row order regardless of the
 * sequence starts/ends arrived in.
 */
export function orderedOps(active: ReadonlySet<SubconsciousOp>): SubconsciousOp[] {
  return ORDER.filter((op) => active.has(op));
}
