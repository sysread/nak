// priming-triggers -----------------------------------------------------------
//
// Deno mirror of the intuition/context-recall trigger evaluator. Both
// subconscious-priming pipelines schedule off this one evaluator, and
// both now run server-side in the venice edge function's priming stage,
// so the evaluator needs a Deno copy.
//
// Logic twin of src/lib/intuition/triggers.ts (plus the STALE_FUSE_*
// constants and countUserRounds, which live in src/lib/intuition/
// types.ts on the browser side). Mirror-with-pointer-comment convention
// (see tests/bias-catalog-parity.test.ts): the two runtimes cannot
// share an import, so this logic lives twice. Keep the fuse constants
// and the fire/inject decisions in lockstep with the browser file.
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
 *  read eventually. Mirrors STALE_FUSE_ROUNDS in src/lib/intuition/
 *  types.ts. */
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
