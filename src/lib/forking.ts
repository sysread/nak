/**
 * Pure fork-point primitives for conversation forking (see
 * docs/dev/forking.md). The Supabase slice (./supabase/threads.ts)
 * queries candidate rows and delegates the actual pick to these
 * functions so the selection rules are unit-testable without a
 * client; M5's fork-from-message card buttons will reuse the same
 * validity predicate to decide which rows get a fork button.
 */

/** The projection of a message row the fork-point rules need. */
export interface ForkPointCandidate {
  id: string;
  role: string;
  tool_calls: unknown[] | null;
  status: string | null;
}

/**
 * A message can anchor a fork iff the transcript up to and including
 * it is a coherent conversation prefix: a user row, or an assistant
 * row that ends its round. Mid-round assistant rows (carrying
 * tool_calls, whose results come after them) and tool rows would
 * leave the fork's inherited prefix dangling mid-exchange, and a
 * still-streaming assistant row's content is not settled yet - the
 * fork would freeze a partial reply into its shared prefix.
 */
export function isValidForkPoint(m: ForkPointCandidate): boolean {
  if (m.status === 'streaming') return false;
  if (m.role === 'user') return true;
  if (m.role !== 'assistant') return false;
  return !Array.isArray(m.tool_calls) || m.tool_calls.length === 0;
}

/**
 * Pick the fork point for a whole-conversation fork from the thread's
 * own-segment tail, given rows in DESCENDING transcript order (newest
 * first). Walks past invalid tail rows (an in-flight streaming row, a
 * dangling tool row from an interrupted turn) to the most recent row
 * a fork can anchor on. Returns null when no candidate qualifies -
 * the caller falls back to the thread's own inherited fork point (an
 * empty-own-segment fork forks as a sibling) or reports there is
 * nothing to fork.
 */
export function pickForkPoint(
  rowsNewestFirst: readonly ForkPointCandidate[]
): ForkPointCandidate | null {
  for (const m of rowsNewestFirst) {
    if (isValidForkPoint(m)) return m;
  }
  return null;
}
