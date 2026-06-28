/**
 * UI-behavior primitives for the streaming reasoning panel.
 *
 * Pure functions only - no runes, no Svelte imports, no DOM. The
 * companion `src/components/ReasoningPanel.svelte` composes these with
 * its own reactivity (the bindable `open` state, the click handler) and
 * the markup; the live timing/state lives on ExchangeSlot and is
 * threaded in by Chat.svelte.
 *
 * Two concerns live here:
 *
 *   - WHEN the panel auto-collapses mid-stream (reasoningShouldCollapse).
 *   - The two header pills shown while reasoning streams: an elapsed-ms
 *     counter (mirrors the tool-call duration pill) and a running
 *     character count.
 */

/**
 * Lower bound (chars) before an auto-collapse can fire. Below this the
 * panel stays open no matter what: a short thought is worth reading in
 * full, and the early bytes of reasoning are where false sentence
 * boundaries cluster - a numbered list ("1. ") or an abbreviation
 * ("e.g. ", "i.e. ", "vs. ") would otherwise trip the boundary regex
 * and collapse the panel before the user has read anything. Holding off
 * until FLOOR chars have streamed skips those early hits.
 */
const FLOOR = 80;

/**
 * Upper bound (chars). Past this we collapse even with no clean sentence
 * boundary in sight - run-on reasoning, or a wall of bullet fragments
 * with no terminal punctuation, would otherwise stay fully expanded for
 * the entire (long) stream, which is exactly the case the collapse is
 * meant to tame.
 */
const CEILING = 600;

/**
 * A sentence terminator followed by whitespace: a word char, then one of
 * . ? !, an optional closing quote/paren, then a space or newline. The
 * trailing-whitespace requirement means a terminator at the very tail of
 * the buffer ("...done.") isn't detected until the next delta carries
 * the following space - an acceptable one-delta lag, and the right call
 * during streaming since end-of-buffer isn't a real sentence break yet.
 */
const BOUNDARY = /\w[.?!]["')\]]?\s/;

/**
 * Whether the streaming reasoning panel should auto-collapse given the
 * text so far. Bounded on both sides: never below FLOOR, always at/above
 * CEILING, and in between at the first sentence boundary that lands past
 * the floor. The slice starts one char before FLOOR so a boundary whose
 * word char sits exactly at FLOOR still counts.
 *
 * Fires once - the caller gates on a "user hasn't touched it" flag and
 * stops checking after the first true, so the monotonically-growing
 * buffer re-satisfying the predicate on later deltas is harmless.
 */
export function reasoningShouldCollapse(text: string): boolean {
  if (text.length >= CEILING) return true;
  if (text.length < FLOOR) return false;
  return BOUNDARY.test(text.slice(FLOOR - 1));
}

/**
 * Elapsed-time pill for the streaming reasoning header. Null when
 * reasoning hasn't started (no pill to show). While reasoning streams
 * it counts up against the parent's monotonic `nowMs`; once `endedAt`
 * is set (the first answer delta of the round, or a reasoning-only
 * round closing) it freezes at the final duration. Milliseconds, for
 * parity with the tool-call duration pill - the same "how long did this
 * take" signal in the same unit.
 */
export function reasoningElapsedPill(
  startedAt: number | null,
  endedAt: number | null,
  nowMs: number
): string | null {
  if (startedAt === null) return null;
  const end = endedAt ?? nowMs;
  const ms = Math.max(0, Math.round(end - startedAt));
  return `${ms} ms`;
}

/**
 * Character-count pill for the streaming reasoning header. Null below
 * one char (nothing to count yet); otherwise the grouped count with a
 * pluralized noun. Reads straight off the live reasoning buffer length,
 * so it ticks up with every flushed delta.
 */
export function reasoningCharPill(count: number): string | null {
  if (count < 1) return null;
  return `${count.toLocaleString()} ${count === 1 ? 'char' : 'chars'}`;
}
