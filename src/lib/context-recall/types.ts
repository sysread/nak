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
 * One citation resolved from a `^N^` superscript in the recall note.
 * `index` is 1-based and matches the superscript; `kind` + `id` point
 * at the source row so the UI can link to the in-app route (a memory,
 * a prior conversation, or a wiki article) and the model can drill
 * down to verify the recollection. Parallel in spirit to the web
 * `Citation` shape, but internal-route oriented (no URL).
 */
export interface ContextRecallCitation {
  index: number;
  kind: 'memory' | 'conversation' | 'wiki';
  id: string;
  label: string;
}

/**
 * One run of the context-recall pipeline, cached on the thread row.
 * Reused as-is across rounds until a trigger (cold-start, title
 * change, mood-band shift, stale fuse) invalidates it. The chat-loop
 * reconstructs the synthetic assistant <think> message at request
 * time from this payload.
 *
 * The `note` field carries the smoothing pass's first-person
 * recollection (with `^N^` citation superscripts). Empty string is a
 * legitimate cached state - it means "nothing relevant surfaced this
 * round; cache the negative result so the next trigger evaluation can
 * debounce instead of re-running".
 */
export interface ContextRecallPayload {
  /** Schema version. Bumped when the shape changes; the cache loader
   *  treats an unknown version as "no cache" and triggers a fresh
   *  refresh on the next opportunity. */
  v: 2;

  /**
   * The smoothing pass's first-person recollection - compressed,
   * past-anchored, relevance-bridged, with `^N^` superscripts keyed
   * into `citations`. Empty string when nothing relevant surfaced -
   * cached so we don't re-run the pipeline on the next trigger fire
   * when the world hasn't changed.
   */
  note: string;

  /**
   * The sources the `^N^` superscripts in `note` resolve to. Empty
   * when the note is empty or the smoothing pass cited nothing. Order
   * is not significant; rows are keyed by `index`.
   */
  citations: ContextRecallCitation[];

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
  if (r.v !== 2) return null;
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
    v: 2,
    note: r.note,
    citations: coerceContextRecallCitations(r.citations),
    computed_at_round: r.computed_at_round,
    computed_at_band,
    computed_at_column,
    computed_at_at: r.computed_at_at,
    trigger,
  };
}

/**
 * Coerce the persisted `citations` value into a clean array. Unlike
 * `note` (a hard reject if malformed), citations are best-effort
 * metadata: a glitch in one row must not invalidate the whole payload
 * and drop the recollection, so a missing / non-array value reads as
 * "no citations" ([]) and individual malformed entries are dropped.
 */
function coerceContextRecallCitations(raw: unknown): ContextRecallCitation[] {
  if (!Array.isArray(raw)) return [];
  const out: ContextRecallCitation[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const c = entry as Record<string, unknown>;
    if (typeof c.index !== 'number' || !Number.isFinite(c.index)) continue;
    if (c.kind !== 'memory' && c.kind !== 'conversation' && c.kind !== 'wiki') {
      continue;
    }
    if (typeof c.id !== 'string' || c.id.length === 0) continue;
    if (typeof c.label !== 'string') continue;
    out.push({ index: c.index, kind: c.kind, id: c.id, label: c.label });
  }
  return out;
}
