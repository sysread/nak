/**
 * Freshness rule for the server-side in-flight stamp
 * (threads.stream_started_at). The venice /stream orchestrator writes
 * the stamp at turn entry - before the priming stage, and before the
 * streaming assistant row exists - and clears it at terminal. The chat
 * screen reads it to arm the reconnect poll and to suppress the
 * "response was interrupted / cut off" recovery banners while a turn
 * is still alive server-side, closing the window where a page refresh
 * during the pre-response "pregame" (predicting / recalling / etc.)
 * found no streaming row and wrongly offered a retry.
 *
 * Interacts with: src/screens/Chat.svelte (selectThread's reconnect
 * arming + the incompleteTurnTail gate), resolveStreamContext in
 * supabase/functions/venice/index.ts (the server-side twin of this
 * staleness rule).
 */

/**
 * A stamp older than this is residue from a function that died before
 * its finally could clear it (container kill, hard crash). Mirrors the
 * server probe's stale-row janitor threshold: twice the orchestrator's
 * 380s wall deadline, so a legitimately long turn never trips it.
 */
const STALE_THRESHOLD_MS = 2 * 380_000;

/**
 * True when `streamStartedAt` says a server-side turn is plausibly
 * still running. Null / unparseable stamps read as "no turn" (the old
 * behavior for rows predating the column). A slightly-future stamp
 * (clock skew between the edge runtime and this device) still counts
 * as fresh; only a stamp past the staleness ceiling reads as dead.
 */
export function streamLikelyInFlight(
  streamStartedAt: string | null | undefined,
  nowMs: number,
): boolean {
  if (typeof streamStartedAt !== 'string') return false;
  const startedMs = Date.parse(streamStartedAt);
  if (Number.isNaN(startedMs)) return false;
  return nowMs - startedMs <= STALE_THRESHOLD_MS;
}
