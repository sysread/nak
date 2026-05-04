/**
 * Shared types for the context-recall feature.
 *
 * The persisted shape (ContextRecallPayload) is what lands in
 * `threads.context_recall_payload` jsonb. The cache module owns the
 * coerce-from-jsonb path; everywhere else reads / writes the shape
 * directly.
 *
 * Same trigger taxonomy as intuition (`'cold' | 'title' | 'mood' |
 * 'stale'`); we re-export the type rather than re-defining it so the
 * trigger evaluator stays single-sourced. The two payloads ride the
 * same chat-loop trigger fire by design - if you find yourself
 * diverging the trigger reasons, that's a design smell that the two
 * pipelines have different cadences and should not share the
 * evaluator.
 *
 * Keep this module dependency-free of Supabase / Venice so the worker
 * bundle (and tests that don't want to drag those in) can import it
 * cheaply - same posture as src/lib/intuition/types.ts.
 */
import type { IntuitionTrigger } from '../intuition/types';

/**
 * One run of the context-recall pipeline, cached on the thread row.
 * Reused as-is across rounds until a trigger (cold-start, title
 * change, mood-band shift, stale fuse) invalidates it. The chat-loop
 * reconstructs the synthetic assistant <think> message at request
 * time from this payload.
 *
 * The `note` field carries the stitched first-person paragraph(s)
 * from the memory-recall and conversation-recall children. Empty
 * string is a legitimate cached state - it means "the children both
 * returned the empty signal this round; cache the negative result so
 * the next trigger evaluation can debounce instead of re-running".
 */
export interface ContextRecallPayload {
  /** Schema version. Bumped when the shape changes; the cache loader
   *  treats an unknown version as "no cache" and triggers a fresh
   *  refresh on the next opportunity. */
  v: 1;

  /**
   * Stitched first-person note assembled from the two child agents.
   * One paragraph if only one child returned a note; two sentences /
   * a single combined paragraph if both did. Empty string when both
   * children returned the empty signal - cached so we don't re-run
   * the pipeline on the next trigger fire when the world hasn't
   * changed.
   */
  note: string;

  /** User-message count at the time the cache was written. Used as
   *  the round-id - same value within all chat-loop iterations of one
   *  user turn, increments on every new user message. Identical
   *  semantics to IntuitionPayload.computed_at_round so the same
   *  trigger evaluator can read either cache. */
  computed_at_round: number;

  /** Mood band index at the time of the write (or null when no mood
   *  was available). Compared against the live band on subsequent
   *  rounds to detect shifts; the trigger evaluator uses this the
   *  same way it uses intuition's value. */
  computed_at_band: number | null;

  /** Confidence column at the time of the write, or null when no
   *  mood was available. */
  computed_at_column: 'confident' | 'tentative' | null;

  /** Wall-clock timestamp (ms since epoch) of the write. Drives age
   *  comparisons in `pickFresherContextRecallPayload` and any future
   *  diagnostic UI. */
  computed_at_at: number;

  /** Why this run was scheduled. Persisted for observability and to
   *  give a future debug surface a reason to display. */
  trigger: IntuitionTrigger;
}

/**
 * Pick the fresher of two persisted-payload values. Sibling of
 * pickFresherIntuitionPayload - same race motivations, same compare-
 * by-computed_at_at posture, same null-loses-to-real semantics.
 *
 * Two races motivate this:
 *
 *   - The chat-loop patches the in-memory thread the instant a fresh
 *     payload arrives, then awaits writeContextRecallCache. Even
 *     with the await, a second tab on the same account can have a
 *     stale snapshot in flight when our patch lands - we want to
 *     keep our freshly-computed payload over the stale row.
 *   - A persistence failure (network blip, RLS hiccup) leaves the
 *     in-memory payload set but the DB row null. Any later thread
 *     UPDATE (samskara worker, archive flip, manual rename) fires a
 *     realtime echo whose row.context_recall_payload is null.
 *     Without this merge, the echo silently wipes the cached note.
 *
 * Drift / unknown-version rows coerce to null and lose to anything
 * valid - we never want to "preserve" a malformed payload over a
 * clean one.
 */
export function pickFresherContextRecallPayload(
  existing: unknown,
  incoming: unknown
): unknown {
  const existingP = coerceContextRecallPayload(existing);
  const incomingP = coerceContextRecallPayload(incoming);
  if (!existingP) return incoming;
  if (!incomingP) return existing;
  return incomingP.computed_at_at >= existingP.computed_at_at
    ? incoming
    : existing;
}

/**
 * Coerce an unknown jsonb value into a ContextRecallPayload, or null
 * if the shape doesn't match. The cache module's read path runs
 * everything through this so a drifting / older-version row is
 * treated as "no cache" and a fresh refresh runs on the next
 * trigger - same posture as the rest of the project's jsonb columns.
 *
 * Note specifically: a zero-length `note` string is a VALID cached
 * state (= "both children returned empty"). Don't mistake that for
 * "missing" - it carries information the trigger evaluator needs
 * to debounce.
 */
export function coerceContextRecallPayload(
  raw: unknown
): ContextRecallPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (typeof r.note !== 'string') return null;
  if (
    typeof r.computed_at_round !== 'number' ||
    !Number.isFinite(r.computed_at_round)
  ) {
    return null;
  }
  if (
    typeof r.computed_at_at !== 'number' ||
    !Number.isFinite(r.computed_at_at)
  ) {
    return null;
  }
  const band = r.computed_at_band;
  const computed_at_band =
    band === null
      ? null
      : typeof band === 'number' && Number.isFinite(band)
        ? band
        : undefined;
  if (computed_at_band === undefined) return null;
  const col = r.computed_at_column;
  const computed_at_column =
    col === null
      ? null
      : col === 'confident' || col === 'tentative'
        ? col
        : undefined;
  if (computed_at_column === undefined) return null;
  const trigger = r.trigger;
  if (
    trigger !== 'title' &&
    trigger !== 'mood' &&
    trigger !== 'stale' &&
    trigger !== 'cold'
  ) {
    return null;
  }
  return {
    v: 1,
    note: r.note,
    computed_at_round: r.computed_at_round,
    computed_at_band,
    computed_at_column,
    computed_at_at: r.computed_at_at,
    trigger,
  };
}
