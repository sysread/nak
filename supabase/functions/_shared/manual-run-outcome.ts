// Persist the terminal outcome of a detached manual agent run to the
// user's profiles row, so any client can recover "what the last run
// did" after a browser reload.
//
// Why this exists: a detached manual run (detachedManualRunHandler in
// the venice function) reports its result as a fire-and-forget `result`
// event on the per-user agent-runs Broadcast topic. A tab that reloaded
// mid-run never re-subscribes to that runId, so the result is lost even
// though the in-flight lease still recovers the "is it running" signal.
// Writing the outcome to a profiles column closes that gap: the column
// is a durable server fact the client reads on mount and watches via the
// profiles realtime UPDATE (the same row the in-flight lease lives on).
//
// One column per fleet, NOT per run kind: the memory librarian's two
// passes (rem, deep-sleep) share one in-flight lease and one Memories
// panel strip, so they share one outcome column too; `source` in the
// payload records which pass produced it.

import type { SupabaseClient } from '@supabase/supabase-js';

// Map a detached-run log source to the profiles column that holds its
// last-run outcome. A source with no entry here is not recoverable and
// is silently skipped (e.g. a future fleet that hasn't opted in).
const OUTCOME_COLUMN: Record<string, string> = {
  'wiki-librarian': 'wiki_librarian_last_run_outcome',
  rem: 'memory_librarian_last_run_outcome',
  'deep-sleep': 'memory_librarian_last_run_outcome',
};

export interface ManualRunOutcome {
  /** The client-minted runId the run was kicked with. */
  runId: string;
  /** The detached-run source: 'wiki-librarian' | 'rem' | 'deep-sleep'. */
  source: string;
  /** ISO timestamp the outcome was recorded. */
  finishedAt: string;
  /** The fleet's own result union (WikiLibrarianRunResult / Rem / DeepSleep). */
  result: unknown;
}

/**
 * Pure planner for the persist write: returns the target column and the
 * payload, or null when the outcome should NOT be persisted. Factored out
 * of the DB call so the column mapping and skip rules are unit-testable
 * without a client.
 *
 * Skips a `busy` result: busy means the in-flight guard turned the run
 * away before it ran, so there is no outcome - persisting it would
 * clobber the real prior outcome with a non-event. An unknown source is
 * also skipped (not recoverable).
 */
export function buildManualRunOutcome(
  source: string,
  runId: string,
  result: unknown,
  nowIso: string,
): { column: string; payload: ManualRunOutcome } | null {
  const column = OUTCOME_COLUMN[source];
  if (!column) return null;
  if (
    result !== null &&
    typeof result === 'object' &&
    (result as { kind?: unknown }).kind === 'busy'
  ) {
    return null;
  }
  return { column, payload: { runId, source, finishedAt: nowIso, result } };
}

/**
 * Write the run's terminal outcome to the owner's profiles row.
 * Best-effort: a failed write only costs reload-recovery of the outcome,
 * not the live run (the result still rides the Broadcast), so it logs and
 * swallows rather than throwing into the detached handler.
 */
export async function persistManualRunOutcome(
  admin: SupabaseClient,
  userId: string,
  source: string,
  runId: string,
  result: unknown,
): Promise<void> {
  const planned = buildManualRunOutcome(source, runId, result, new Date().toISOString());
  if (!planned) return;
  const { error } = await admin
    .from('profiles')
    .update({ [planned.column]: planned.payload })
    .eq('user_id', userId);
  if (error) {
    console.error(`[manual-run-outcome] persist failed (${source}): ${error.message}`);
  }
}
