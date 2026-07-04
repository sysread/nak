// Follow-ups: pure selection logic for the context-recall gather's
// date-due arm, plus the shared caps the tool boundary enforces.
//
// A follow-up is a pending question the assistant saved for itself
// ("Ask how the lasagna turned out"). The gather surfaces open rows two
// ways: semantically (vector match, handled in SQL) and date-due (rows
// whose relevant_after has passed, selected here). This module owns the
// due-side judgment - cooldown, expiry, cap - as pure functions so the
// anti-nag behavior is vitest-pinned without a DB. The DB I/O wrapper
// lives in supabase/functions/venice/priming/context-recall.ts; the
// write tools live in supabase/functions/venice/tools/followup_*.ts.

// Tool-boundary caps. Mirrored in the browser wire schemas
// (src/lib/tools/followup_*.schema.ts) - the schema numbers are
// advisory prompt text; these are what the edge validators enforce.
export const MAX_FOLLOWUP_QUESTION_CHARS = 200;
export const MAX_FOLLOWUP_CONTEXT_CHARS = 500;
export const MAX_FOLLOWUP_RESOLUTION_CHARS = 500;

// Due-surfacing knobs. LAUNCH PLACEHOLDERS tuned for feel, not data -
// revisit against the QA date-due walkthrough once real usage exists.
//
// At most this many due asks ride one gather - a backlog of overdue
// loops must not turn a thread-open into an interrogation.
export const DUE_SURFACE_CAP = 2;
// A due loop surfaced within this window is skipped by the next due
// pull, so consecutive threads in one day don't repeat the ask. 20h
// rather than 24h so a same-time-tomorrow conversation is eligible
// again. Semantic surfacing is NOT cooldown-gated - if the user brings
// the topic up, the unresolved status is always relevant.
export const DUE_SURFACE_COOLDOWN_MS = 20 * 60 * 60 * 1000;
// Expiry: a dated loop unanswered after this many proactive asks, or
// this long past its relevant_after, flips to 'expired' and never
// surfaces again. Undated loops (relevant_after null) are never asked
// proactively and never expire - "outcome unknown" stays true until
// the user resolves it, so semantic surfacing stays honest.
export const MAX_UNANSWERED_SURFACINGS = 3;
export const DUE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/** The columns the due-side selection reasons over. */
export interface DueCandidateRow {
  id: string;
  /** ISO timestamptz; null = never proactively surfaced. */
  last_surfaced_at: string | null;
  /** ISO timestamptz; callers only pass rows where this is non-null
   *  (the due pull's SQL filter), but null is tolerated as not-due. */
  relevant_after: string | null;
  surface_count: number;
}

export interface DueSelection<Row extends DueCandidateRow> {
  /** Rows to surface this gather, oldest relevant_after first, capped. */
  due: Row[];
  /** Rows past the expiry policy - the caller flips these to 'expired'. */
  expiredIds: string[];
}

function parseMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** A dated loop whose relevant_after has passed. */
export function isDue(row: DueCandidateRow, nowMs: number): boolean {
  const at = parseMs(row.relevant_after);
  return at !== null && at <= nowMs;
}

/**
 * Expiry policy for dated loops: asked MAX_UNANSWERED_SURFACINGS times
 * with no resolution, or DUE_EXPIRY_MS past relevant_after. Only ever
 * true for due rows - a future-dated loop cannot expire.
 */
export function isExpiredByPolicy(row: DueCandidateRow, nowMs: number): boolean {
  const at = parseMs(row.relevant_after);
  if (at === null || at > nowMs) return false;
  if (row.surface_count >= MAX_UNANSWERED_SURFACINGS) return true;
  return nowMs - at > DUE_EXPIRY_MS;
}

/** Surfaced recently enough that another ask would read as nagging. */
export function isCoolingDown(row: DueCandidateRow, nowMs: number): boolean {
  const last = parseMs(row.last_surfaced_at);
  return last !== null && nowMs - last < DUE_SURFACE_COOLDOWN_MS;
}

/**
 * Partition open dated candidates into the due set to surface now and
 * the ids to expire. Expiry is checked BEFORE cooldown on purpose: a
 * loop that hit its ask budget expires even while cooling down, so it
 * can't linger in a surfaced-cooled-surfaced cycle past the budget.
 * The due set is ordered oldest relevant_after first (the longest-
 * waiting question wins the cap).
 */
export function selectDueFollowups<Row extends DueCandidateRow>(
  rows: readonly Row[],
  nowMs: number,
): DueSelection<Row> {
  const due: Row[] = [];
  const expiredIds: string[] = [];
  for (const row of rows) {
    if (!isDue(row, nowMs)) continue;
    if (isExpiredByPolicy(row, nowMs)) {
      expiredIds.push(row.id);
      continue;
    }
    if (isCoolingDown(row, nowMs)) continue;
    due.push(row);
  }
  due.sort((a, b) => (parseMs(a.relevant_after) ?? 0) - (parseMs(b.relevant_after) ?? 0));
  return { due: due.slice(0, DUE_SURFACE_CAP), expiredIds };
}
