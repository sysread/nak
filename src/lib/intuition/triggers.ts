/**
 * Injection-side freshness guard for cached priming payloads.
 *
 * Pre-turn priming (the trigger scheduling and the pipeline runs) now
 * lives in the venice edge function. What remains client-side is the
 * UI's staleness verdict: deciding whether a cached payload is fresh
 * enough to splice onto the wire / render as live rather than stale.
 */
import { STALE_FUSE_MS } from './types';

/**
 * Decide whether a cached priming payload is fresh enough to splice
 * onto the wire as a `<think>` block. A payload at or past
 * STALE_FUSE_MS of age is suppressed rather than injected - a stale
 * intuition synthesis is an imperative aimed at a situation that no
 * longer exists, so injecting it actively steers the model wrong.
 *
 * Reads only `computed_at_at`, so both IntuitionPayload and
 * ContextRecallPayload satisfy the argument.
 */
export function isPayloadFreshForInjection(
  cache: { computed_at_at: number },
  nowMs: number
): boolean {
  return nowMs - cache.computed_at_at < STALE_FUSE_MS;
}
