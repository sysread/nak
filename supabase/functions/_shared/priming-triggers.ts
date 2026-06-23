// priming-triggers -----------------------------------------------------------
//
// The trigger evaluator both subconscious-priming pipelines
// (intuition + context-recall) schedule off, run as part of the venice
// edge function's priming stage. This is the canonical home for the
// scheduling decision: evaluatePreRoundTrigger and the STALE_FUSE_ROUNDS
// round fuse live ONLY here (the browser no longer schedules priming).
//
// Two members here keep a browser twin and must stay in agreement with
// it - the runtimes cannot share an import (Deno needs .ts-suffixed
// relative specifiers; the vite/tsc side forbids them):
//   - isPayloadFreshForInjection - twin in src/lib/intuition/triggers.ts,
//     the UI's injection-side freshness verdict.
//   - STALE_FUSE_MS + countUserRounds - twins in
//     src/lib/intuition/types.ts (the browser keeps the wall-clock bound
//     for the injection guard and the round-id counter for display).
//
// Pure - no Supabase / Venice. The trigger tests drive it
// deterministically by passing nowMs in.

/** Why an intuition/context-recall refresh ran. 'title' is legacy-only
 *  (the mid-turn title trigger died when tool dispatch moved
 *  server-side); payloads persisted before that still carry it, so the
 *  coercers keep accepting it. */
export type IntuitionTrigger = 'title' | 'mood' | 'stale' | 'cold';

/** Forces a refresh after this many user-rounds without one, so a slow
 *  conversation that drifts under the mood threshold still gets a fresh
 *  read eventually. Server-only - the round fuse feeds the scheduling
 *  decision, which lives here; the browser keeps only the wall-clock
 *  bound (STALE_FUSE_MS) for its injection guard. */
export const STALE_FUSE_ROUNDS = 8;

/** Wall-clock companion to STALE_FUSE_ROUNDS (one hour). The round fuse
 *  only counts user turns, so a conversation resumed hours later with a
 *  couple of fresh turns never trips it - and the cached payload is a
 *  snapshot of a moment that goes stale the instant the user steps away.
 *  Both the refresh trigger and the injection guard read this same
 *  bound, so "old enough to refresh" and "too old to steer on" stay in
 *  lockstep. Mirrors STALE_FUSE_MS in src/lib/intuition/types.ts. */
export const STALE_FUSE_MS = 60 * 60 * 1000;

/**
 * The minimal cache shape the trigger evaluator reads. Both
 * IntuitionPayload and ContextRecallPayload satisfy this shape - the
 * evaluator only needs the round id and mood snapshot to decide whether
 * to fire, not the payload-specific fields (synthesis vs. note).
 */
export interface RoundCacheSnapshot {
  computed_at_round: number;
  computed_at_band: number | null;
  computed_at_column: 'confident' | 'tentative' | null;
  /** Wall-clock write time, ms since epoch. Feeds the wall-clock
   *  staleness fuse - see STALE_FUSE_MS. */
  computed_at_at: number;
}

export interface TriggerContext {
  /** Current cache, or null on cold start. */
  cache: RoundCacheSnapshot | null;
  /** Round id (= count of user messages in history) at evaluation
   *  time. Same value across all iterations of one user turn. */
  round: number;
  /** Live mood snapshot, or null when no mood is available. */
  mood: { band: number; column: 'confident' | 'tentative' } | null;
  /** Current wall-clock time, ms since epoch. Passed in rather than
   *  read here so the evaluator stays a pure function. */
  nowMs: number;
}

/**
 * Decide whether to refresh BEFORE the round's first completion.
 * Returns the trigger reason if a refresh is warranted, or null to
 * skip. Order of checks: cold-start first, then same-round debounce,
 * then mood comparison, then stale fuse (last - if mood already
 * triggered we don't also count it as a stale-fuse run).
 */
export function evaluatePreRoundTrigger(
  ctx: TriggerContext,
): IntuitionTrigger | null {
  const { cache, round, mood, nowMs } = ctx;

  // Cold-start: no cache yet. Fire so the first response is informed.
  if (!cache) return 'cold';

  // Same-round debounce: if we already wrote a payload this round,
  // anything that fires after must be a no-op until the next round.
  if (cache.computed_at_round >= round) return null;

  // Mood-shift trigger: band index OR confidence column changed since
  // the cache was written. Either is enough on its own.
  if (mood) {
    const bandChanged = cache.computed_at_band !== mood.band;
    const columnChanged = cache.computed_at_column !== mood.column;
    if (bandChanged || columnChanged) return 'mood';
  }

  // Staleness fuse, two independent triggers. Rounds catch
  // within-session drift; wall-clock catches a conversation resumed
  // after a pause, where the round counter barely advanced but the
  // cached pulse is aimed at a situation that is hours or days gone.
  const roundsStale = round - cache.computed_at_round >= STALE_FUSE_ROUNDS;
  const wallClockStale = nowMs - cache.computed_at_at >= STALE_FUSE_MS;
  if (roundsStale || wallClockStale) return 'stale';

  return null;
}

/**
 * Injection-side companion to the wall-clock staleness fuse: decide
 * whether a cached priming payload is fresh enough to splice onto the
 * wire as a <think> block. A payload at or past STALE_FUSE_MS of age is
 * suppressed - a stale synthesis is an imperative aimed at a situation
 * that no longer exists, so injecting it actively steers the model
 * wrong. The bound matches the wall-clock refresh trigger exactly so
 * "old enough to refresh" and "too old to steer on" stay in lockstep.
 */
export function isPayloadFreshForInjection(
  cache: { computed_at_at: number },
  nowMs: number,
): boolean {
  return nowMs - cache.computed_at_at < STALE_FUSE_MS;
}

/**
 * Count user messages in a history array. The round-id corresponds to
 * user-message rounds, not streaming rounds (which inflate to 3+ on
 * tool-using turns). 1 for the first user turn, increments on every
 * subsequent user message. Mirrors countUserRounds in
 * src/lib/intuition/types.ts.
 */
export function countUserRounds(
  history: readonly { role: string }[],
): number {
  let n = 0;
  for (const m of history) {
    if (m.role === 'user') n++;
  }
  return n;
}
