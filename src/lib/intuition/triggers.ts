/**
 * Trigger evaluation for the intuition pipeline (and, structurally,
 * the context-recall pipeline - both schedule off this one evaluator).
 *
 * One trigger site: the pre-round trigger, evaluated once at the start
 * of a chat-loop call before the first streamChat round. It fires when
 * any of these holds:
 *
 *   - cold: no cache yet, so turn 1 always gets a read.
 *   - mood: the valence band or confidence column has shifted since
 *     the cache was written.
 *   - stale: enough has elapsed without a refresh that even a
 *     steady-state conversation should be re-perceived. Staleness has
 *     two independent fuses, either of which fires: STALE_FUSE_ROUNDS
 *     user-rounds (within-session drift) OR STALE_FUSE_MS wall-clock
 *     ms (a conversation resumed after a gap - the round counter
 *     barely moves across an overnight pause, so without the
 *     wall-clock fuse a day-old pulse would inject as if it were live).
 *
 * The universal debounce primitive is `computed_at_round`: when the
 * cache was written this round already, the evaluator no-ops. Two
 * conditions landing in the same round (e.g. mood shift AND stale
 * fuse) collapse to one run; mood wins the reason since it is the
 * more specific cause.
 *
 * (A mid-turn title trigger used to exist - refresh when update_title
 * lands mid-turn - but it died when tool dispatch moved server-side;
 * the browser no longer sees the result in time to re-prime. The
 * 'title' trigger value lingers only on payloads persisted before
 * that change.)
 */
import type { IntuitionTrigger } from './types';
import { STALE_FUSE_ROUNDS, STALE_FUSE_MS } from './types';

/**
 * The minimal cache shape the trigger evaluator reads. Both
 * IntuitionPayload and ContextRecallPayload satisfy this shape - the
 * evaluator only needs the round id and mood snapshot to decide
 * whether to fire, not the payload-specific fields (synthesis vs.
 * note). Keeping this interface structural lets a single evaluator
 * schedule both subconscious-priming pipelines on the same triggers
 * without a cast at the call site.
 */
export interface RoundCacheSnapshot {
  computed_at_round: number;
  computed_at_band: number | null;
  computed_at_column: 'confident' | 'tentative' | null;
  /** Wall-clock write time, ms since epoch. Feeds the wall-clock
   *  staleness fuse - see STALE_FUSE_MS. Both IntuitionPayload and
   *  ContextRecallPayload already carry this field. */
  computed_at_at: number;
}

export interface TriggerContext {
  /** Current cache, or null on cold start. Structural shape so the
   *  evaluator works for any payload that carries the round/mood
   *  snapshot fields - see RoundCacheSnapshot above. */
  cache: RoundCacheSnapshot | null;
  /** Round id (= count of user messages in history) at evaluation
   *  time. Same value across all chat-loop iterations of one user
   *  turn. */
  round: number;
  /** Live mood snapshot, or null when no mood is available. */
  mood: { band: number; column: 'confident' | 'tentative' } | null;
  /** Current wall-clock time, ms since epoch (Date.now() at the call
   *  site). Passed in rather than read here so the evaluator stays a
   *  pure function the trigger tests can drive deterministically. */
  nowMs: number;
}

/**
 * Decide whether to refresh BEFORE the round's first streamChat
 * call. Returns the trigger reason if a refresh is warranted, or
 * null to skip.
 *
 * Order of checks matters: cold-start first (always fire on a
 * thread with no cache yet), then same-round debounce, then mood
 * comparison, then stale fuse. The stale fuse is deliberately last -
 * if mood already triggered we don't also need to count it as a
 * stale-fuse run.
 *
 * Why cold-start fires here rather than waiting for the title
 * trigger: a fresh thread CAN go through turn 1 without the model
 * calling `update_title` (a manually-titled thread, a turn that
 * doesn't trip the rename heuristic, or just a model that decided
 * not to comply). Without an unconditional cold-start fire, those
 * threads never accumulate a payload at all - the feature stays
 * invisible. The cost is ~3 fast-model roundtrips of latency on
 * turn 1; the benefit is the user reliably sees an intuition land
 * by the time the response arrives.
 */
export function evaluatePreRoundTrigger(ctx: TriggerContext): IntuitionTrigger | null {
  const { cache, round, mood, nowMs } = ctx;

  // Cold-start: no cache yet. Fire so the first response is
  // informed by an intuition rather than waiting on the title
  // tool to maybe-or-maybe-not be called this turn.
  if (!cache) return 'cold';

  // Same-round debounce: if we already wrote a payload this round,
  // anything that fires after must be a no-op until the next round.
  if (cache.computed_at_round >= round) return null;

  // Mood-shift trigger: band index OR confidence column changed
  // since the cache was written. Either is enough on its own.
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
 * The injection-side companion to the wall-clock staleness fuse:
 * decide whether a cached priming payload is fresh enough to splice
 * onto the wire as a `<think>` block. A payload at or past
 * STALE_FUSE_MS of age is suppressed rather than injected - a stale
 * intuition synthesis is an imperative aimed at a situation that no
 * longer exists, so injecting it actively steers the model wrong.
 *
 * The bound matches the wall-clock refresh trigger exactly, so "old
 * enough to refresh" and "too old to steer on" stay in lockstep: a
 * turn that trips the trigger normally recomputes and the fresh
 * payload passes here; this guard is the backstop for the turns the
 * refresh could not cover (pipeline error, inflight-dedup returning
 * null, feature off). Reads only `computed_at_at`, so both
 * IntuitionPayload and ContextRecallPayload satisfy the argument.
 */
export function isPayloadFreshForInjection(
  cache: { computed_at_at: number },
  nowMs: number
): boolean {
  return nowMs - cache.computed_at_at < STALE_FUSE_MS;
}

