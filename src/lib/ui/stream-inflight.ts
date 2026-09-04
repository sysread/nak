/**
 * Freshness rule for the server-side liveness heartbeat
 * (threads.stream_heartbeat_at). The venice /stream orchestrator stamps
 * it at turn entry - before the priming stage, and before the streaming
 * assistant row exists - refreshes it every 15s while the turn runs,
 * and clears it at terminal. The chat screen reads it to arm the
 * reconnect poll and to suppress the "response was interrupted / cut
 * off" recovery banners while a turn is still alive server-side, and -
 * because a hard-killed function never clears it - to notice within a
 * minute that a turn died: the heartbeat simply stops refreshing, the
 * freshness verdict flips, and the recovery banners come back on.
 *
 * Interacts with: src/screens/Chat.svelte (selectThread's reconnect
 * arming + the incompleteTurnTail gate), resolveStreamContext in
 * supabase/functions/venice/stream-probe.ts (the server-side twin of
 * this staleness rule), and nak_sweep_stale_streams in
 * supabase/schema.sql (the cron twin).
 */

/**
 * A heartbeat older than this is a dead turn: the function stopped
 * refreshing it (container kill, CPU-time budget exceeded, hard crash)
 * before its finally could clear it. Four missed 15s beats - the same
 * ceiling the server probe and the cron sweep use, so every reader
 * flips its verdict within the same minute.
 */
const STALE_HEARTBEAT_MS = 60_000;

/**
 * True when `heartbeatAt` says a server-side turn is plausibly still
 * running. Null / unparseable stamps read as "no turn". A
 * slightly-future stamp (clock skew between the edge runtime and this
 * device) still counts as fresh; only a stamp past the staleness
 * ceiling reads as dead.
 */
export function streamLikelyInFlight(
  heartbeatAt: string | null | undefined,
  nowMs: number,
): boolean {
  if (typeof heartbeatAt !== 'string') return false;
  const beatMs = Date.parse(heartbeatAt);
  if (Number.isNaN(beatMs)) return false;
  return nowMs - beatMs <= STALE_HEARTBEAT_MS;
}
