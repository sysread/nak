/**
 * Display helpers for the age and staleness of a cached priming payload
 * (intuition or context-recall). Shared by the Intuition and Recall
 * diagnostics modals so both render age and the "stale" badge the same
 * way.
 *
 * The staleness verdict deliberately reuses isPayloadFreshForInjection -
 * the exact predicate the chat-loop uses to decide whether to inject a
 * payload onto the wire - so the badge a user sees in the modal ("stale")
 * means precisely "old enough that the chat-loop would suppress it rather
 * than steer on it." One threshold (STALE_FUSE_MS), one source of truth.
 */
import { isPayloadFreshForInjection } from '$lib/intuition';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * A compact relative age like "just now", "5m ago", "3h ago", "2d ago".
 * Coarse on purpose - the modal wants "how fresh is this" at a glance,
 * not a precise duration. A negative delta (clock skew, a payload stamped
 * slightly in the future) reads as "just now" rather than a nonsense
 * negative age.
 */
export function formatRelativeAge(computedAtMs: number, nowMs: number): string {
  const diff = nowMs - computedAtMs;
  if (diff < MINUTE_MS) return 'just now';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h ago`;
  return `${Math.floor(diff / DAY_MS)}d ago`;
}

/**
 * Whether a payload of this age would be suppressed at injection time -
 * the same bound the chat-loop applies. Drives the "stale" badge.
 */
export function isStaleForDisplay(computedAtMs: number, nowMs: number): boolean {
  return !isPayloadFreshForInjection({ computed_at_at: computedAtMs }, nowMs);
}
