// Shared recency gate for detached manual-run outcome recovery.
//
// Every recoverable fleet (memory librarian's rem/deep-sleep, the wiki
// librarian) persists its terminal result to a sticky `*_last_run_outcome`
// profiles column with NO expiry, then recovers it on mount + via the
// profiles realtime UPDATE (see createLastRunOutcomeWatcher). The recovery
// exists for the reload-after-finish case: kick a run, reload, land back,
// see the summary the live Broadcast already delivered and lost.
//
// Because the column never clears, an unbounded recovery re-applies the
// last run ever on EVERY cold app load - which in the Memories panel
// buried the changelog default surface behind a stale "Rem finished" card
// from a run that ran hours or days ago. The outcome envelope carries
// `finishedAt`, so gate on it: only outcomes that finished recently count
// as a reload-after-finish recovery. A fresh realtime outcome (a run
// finishing while the tab is open) has `finishedAt ~= now`, so it always
// passes; the legit recovery path is untouched.

// 10 min comfortably covers a reload round-trip plus the longest plausible
// run, while a genuinely new session never trips it.
export const MAX_RECOVERED_OUTCOME_AGE_MS = 10 * 60 * 1000;

/**
 * Whether a recovered outcome finished recently enough to auto-surface its
 * result. An absent or unparseable `finishedAt` is treated as fresh so a
 * legacy envelope without the field still recovers - the recency bound is a
 * guard against stale sticky values, not a hard requirement on the shape.
 */
export function recoveredOutcomeIsFresh(
  finishedAt: string | undefined,
  nowMs: number,
): boolean {
  if (!finishedAt) return true;
  const finishedMs = Date.parse(finishedAt);
  if (Number.isNaN(finishedMs)) return true;
  return nowMs - finishedMs <= MAX_RECOVERED_OUTCOME_AGE_MS;
}
