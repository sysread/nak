// Pure UI-behavior primitives for collapsing the HISTORY groups of the
// seedling inspector modal (src/screens/Intents.svelte) - "Let go"
// intents, answered and let-go follow-ups. Shared by both halves of the
// modal ($lib/ui/intents-inspector, $lib/ui/followups-inspector) because
// the two features present the same reading problem: the live groups are
// what the user came to see, and the closed ones accumulate for the life
// of the account with nothing pruning them.
//
// The design constraint is honesty, same as the rest of the inspector: a
// truncated list must say how much it is hiding. A silent cap reads as
// "Nak let go of 5 things" when the real number is 40. So the collapsed
// view always carries the remaining count, and expanding is one click
// with no refetch - every row is already in memory.
//
// Unit-tested in tests/history-disclosure.test.ts.

/**
 * Rows shown per history group before the user expands it. Five is
 * enough to establish what the group holds (and to see whether the tail
 * is recent or ancient) without the closed groups dwarfing the live ones
 * in a modal the user opened to read what Nak is working on now.
 */
export const HISTORY_PREVIEW = 5;

/** A history group split into what renders and what stays hidden. */
export interface HistoryView<T> {
  /** The rows to render, in the order given. */
  shown: readonly T[];
  /** How many rows are being withheld; 0 when nothing is hidden. */
  hidden: number;
}

/**
 * Slice a history group for rendering. Callers pass the group already
 * sorted (the inspectors sort by `updated_at` descending), so the
 * preview is the most recently touched rows.
 */
export function visibleHistory<T>(
  rows: readonly T[],
  expanded: boolean,
): HistoryView<T> {
  if (expanded || rows.length <= HISTORY_PREVIEW) {
    return { shown: rows, hidden: 0 };
  }
  return {
    shown: rows.slice(0, HISTORY_PREVIEW),
    hidden: rows.length - HISTORY_PREVIEW,
  };
}

/**
 * Label for the disclosure button. Names the count when collapsed so the
 * hidden tail is visible as a number even before the user expands it.
 */
export function disclosureLabel(hidden: number): string {
  if (hidden === 0) return 'Show fewer';
  if (hidden === 1) return 'Show 1 more';
  return `Show ${hidden} more`;
}
