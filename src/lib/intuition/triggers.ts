/**
 * Trigger evaluation for the intuition pipeline.
 *
 * Two trigger sites in the chat-loop:
 *
 *   1. Pre-round trigger: evaluated once at the start of a chat-loop
 *      call, before the first streamChat round. Compares the cached
 *      payload's mood snapshot against the current mood; if the
 *      valence band or confidence column has shifted, refresh.
 *      Also catches the staleness fuse - after STALE_FUSE_ROUNDS
 *      user-rounds without a refresh, run one regardless of mood.
 *
 *   2. Mid-turn trigger: evaluated after a successful update_title
 *      tool call lands its result in the history. A title change
 *      means the topic has meaningfully shifted, so we refresh and
 *      inject the new intuition into the next streamChat round of
 *      this same turn.
 *
 * The universal debounce primitive is `computed_at_round`: when the
 * cache was written this round already, every trigger no-ops. Two
 * triggers landing in the same round (e.g. mood threshold crossed
 * AND title changed) collapse to one run; the second sees the
 * cache's round id matching the live round and skips.
 *
 * The cold-start case is special: with no cache and no trigger
 * having fired yet, the pre-round evaluator returns null (skip),
 * not 'cold'. The first refresh on a thread typically lands during
 * turn 1 via the title trigger - a fresh thread starts with the
 * placeholder title, so the model is prompted to call update_title
 * on the first turn, and the intuition pipeline runs as that title
 * lands. The fall-through stale fuse picks up any thread that
 * somehow misses both triggers.
 */
import type { IntuitionTrigger } from './types';
import { STALE_FUSE_ROUNDS } from './types';

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
  const { cache, round, mood } = ctx;

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

  // Staleness fuse: enough rounds have passed without a refresh
  // that even a steady-state conversation should be re-perceived.
  if (round - cache.computed_at_round >= STALE_FUSE_ROUNDS) return 'stale';

  return null;
}

/**
 * Decide whether to refresh after a mid-turn `update_title` tool
 * landed. The title trigger always wins on a different round
 * (topic shift is the strongest signal we have), but skips when the
 * current round has already produced a payload - either via the
 * pre-round trigger that fired earlier this same turn, or via a
 * prior in-turn title call (rare; the model could rename twice in
 * one turn).
 *
 * Cold-start lands here too: with no cache, a title call always
 * triggers. This is how turn-1 typically gets its first intuition.
 */
export function evaluateTitleTrigger(ctx: TriggerContext): IntuitionTrigger | null {
  const { cache, round } = ctx;
  if (!cache) return 'cold';
  if (cache.computed_at_round >= round) return null;
  return 'title';
}
