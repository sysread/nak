/**
 * Shared types for the intuition feature.
 *
 * The persisted shape (IntuitionPayload) is what lands in
 * `threads.intuition_payload` jsonb. The cache module owns the
 * coerce-from-jsonb path; everywhere else reads / writes the shape
 * directly.
 *
 * Keep this module dependency-free of Supabase / Venice so the
 * worker bundle (and tests that don't want to drag those in) can
 * import it cheaply.
 */
import type { DriveName } from './prompts';

/**
 * One run of the pipeline, cached on the thread row. Reused as-is
 * across rounds until a trigger (title change, mood-band shift,
 * stale-fuse) invalidates it. The chat-loop reconstructs the
 * ephemeral assistant message at request time from the same payload
 * the modal reads.
 */
export interface IntuitionPayload {
  /** Schema version. Bumped when the shape changes; the cache loader
   *  treats an unknown version as "no cache" and triggers a fresh
   *  refresh on the next opportunity. */
  v: 1;

  /** The objective-observer read of the conversation. Begins with
   *  "Classification: <category>" - normalized to "ambiguous" if the
   *  model elided the prefix. */
  perception: string;

  /** First-person reactions from each drive, keyed by DriveName. A
   *  drive that failed (rate-limit, parse error) is omitted; the
   *  modal renders its slot as an "unavailable" placeholder rather
   *  than erroring. */
  drives: Partial<Record<DriveName, string>>;

  /** The synthesized internal monologue. This is what gets injected
   *  as `<think>` content on the ephemeral assistant message. */
  synthesis: string;

  /** User-message count at the time the cache was written. Used as
   *  the round-id - same value within all chat-loop iterations of
   *  one user turn, increments on every new user message. */
  computed_at_round: number;

  /** Mood band index at the time of the write (0..4 in MOOD_TABLE
   *  order, or null when no mood was available). Compared against
   *  the live band on subsequent rounds to detect shifts. */
  computed_at_band: number | null;

  /** Confidence column at the time of the write
   *  (`'confident' | 'tentative'`), or null when no mood was
   *  available. Compared against the live column to detect
   *  confidence flips. */
  computed_at_column: 'confident' | 'tentative' | null;

  /** Wall-clock timestamp (ms since epoch) of the write. Drives the
   *  modal's "computed at HH:MM" timestamp and the human-readable
   *  age in the inline card. */
  computed_at_at: number;

  /** Which trigger ran the pipeline. Surface in the modal so the
   *  user can see whether the most recent refresh was a topic-
   *  change ('title') or an affective shift ('mood'), and whether
   *  the fuse fired ('stale'). 'cold' marks the very first
   *  population on a thread. */
  trigger: IntuitionTrigger;
}

/** Why an intuition refresh ran. Persisted on the payload for
 *  observability; also returned from the trigger evaluator so
 *  the chat-loop can log the cause. 'title' is legacy-only: the
 *  mid-turn title trigger died when tool dispatch moved server-side
 *  (the browser no longer sees update_title results mid-turn), but
 *  payloads persisted before that still carry it, so the coercion
 *  below keeps accepting it. */
export type IntuitionTrigger = 'title' | 'mood' | 'stale' | 'cold';

/** Configurable cap on the staleness fuse. Forces a refresh after
 *  this many user-rounds without one, so a slow conversation that
 *  drifts under both the title and mood thresholds still gets a
 *  fresh read eventually. */
export const STALE_FUSE_ROUNDS = 8;

/** Wall-clock companion to STALE_FUSE_ROUNDS. The round fuse only
 *  counts user turns, so a conversation resumed hours or days later
 *  with a couple of fresh turns never trips it - and the cached
 *  payload is a snapshot of a moment (perception, drives, synthesis
 *  aimed at the situation as it stood), which goes stale the instant
 *  the user steps away and comes back to a different context. One
 *  hour: long enough that triggering a response and wandering off
 *  mid-turn (the common single-user pattern) does not force a
 *  needless recompute, short enough that a next-day resume
 *  re-perceives instead of injecting yesterday's pulse as if it were
 *  live. Both the refresh trigger and the injection guard read this
 *  same bound, so "old enough to refresh" and "too old to steer on"
 *  stay in lockstep. */
export const STALE_FUSE_MS = 60 * 60 * 1000;

/**
 * Count user messages in a history array. The user requested that the
 * round-id correspond to user-message rounds, not chat-loop streaming
 * rounds (which inflate to 3+ on tool-using turns). This count is the
 * canonical round id - 1 for the first user turn, increments on every
 * subsequent user message. Tool-result rows, assistant text, and
 * system messages are all ignored.
 */
export function countUserRounds(
  history: readonly { role: string }[]
): number {
  let n = 0;
  for (const m of history) {
    if (m.role === 'user') n++;
  }
  return n;
}

/**
 * Pick the fresher of two persisted-payload values. Used at every
 * thread-replacement site (refreshThreads, the realtime onUpdate
 * handler, etc.) to keep a fresher in-memory payload from being
 * clobbered by a server snapshot that hasn't caught up yet.
 *
 * Two races motivate this:
 *
 *   - The chat-loop patches the in-memory thread the instant a fresh
 *     payload arrives, then awaits writeIntuitionCache. Even with
 *     the await, a second tab on the same account can have a stale
 *     snapshot in flight when our patch lands - we want to keep our
 *     freshly-computed payload over the stale row.
 *   - A persistence failure (network blip, RLS hiccup) leaves the
 *     in-memory payload set but the DB row null. Any later thread
 *     UPDATE (samskara worker, archive flip, manual rename) fires a
 *     realtime echo whose row.intuition_payload is null. Without
 *     this merge, the echo silently wipes the icon.
 *
 * Comparison is by computed_at_at - the wall-clock timestamp at the
 * pipeline's success. A null incoming or existing value behaves as
 * computed_at_at = -Infinity, so a real payload always beats null.
 * Drift / unknown-version rows coerce to null and lose to anything
 * valid, which is the right default - we never want to "preserve" a
 * malformed payload over a clean one.
 */
export function pickFresherIntuitionPayload(
  existing: unknown,
  incoming: unknown
): unknown {
  const existingP = coerceIntuitionPayload(existing);
  const incomingP = coerceIntuitionPayload(incoming);
  if (!existingP) return incoming;
  if (!incomingP) return existing;
  return incomingP.computed_at_at >= existingP.computed_at_at
    ? incoming
    : existing;
}

/**
 * Coerce an unknown jsonb value into an IntuitionPayload, or null if
 * the shape doesn't match. The cache module's read path runs
 * everything through this so a drifting / older-version row is
 * treated as "no cache" and a fresh refresh runs on the next
 * trigger - same posture as the rest of the project's jsonb columns.
 */
export function coerceIntuitionPayload(raw: unknown): IntuitionPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (typeof r.perception !== 'string' || r.perception.length === 0) return null;
  if (typeof r.synthesis !== 'string' || r.synthesis.length === 0) return null;
  // Reject payloads where the synthesis is the synthesis prompt
  // itself. A live regression (fast-tier model echoing the system
  // prompt as its content when the conversation ended with an
  // assistant message) shipped bad payloads to the database with
  // the prompt body sitting in the synthesis field. The pipeline
  // shape was fixed in pipeline.ts, but threads with the bad cache
  // would otherwise keep rendering the prompt until a refresh
  // trigger fired - rejecting it here makes the next chat-loop
  // opportunity treat the row as a cold cache and run a clean
  // pipeline. The signature phrase pairs two terms from the
  // SYNTHESIS_PROMPT first sentence ("AI agent" + "Subconsciousness")
  // that no genuine synthesis output should ever contain - the
  // prompt explicitly forbids the synthesis from referring to its
  // own process.
  if (r.synthesis.includes('You are the Subconsciousness')) return null;
  if (typeof r.computed_at_round !== 'number' || !Number.isFinite(r.computed_at_round)) {
    return null;
  }
  if (typeof r.computed_at_at !== 'number' || !Number.isFinite(r.computed_at_at)) {
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
  const drivesIn = r.drives;
  const drives: Partial<Record<DriveName, string>> = {};
  if (drivesIn && typeof drivesIn === 'object') {
    for (const [k, v] of Object.entries(drivesIn)) {
      if (
        (k === 'attunement' ||
          k === 'candor' ||
          k === 'curiosity' ||
          k === 'pragmatism' ||
          k === 'standing') &&
        typeof v === 'string' &&
        v.length > 0
      ) {
        drives[k as DriveName] = v;
      }
    }
  }
  return {
    v: 1,
    perception: r.perception,
    drives,
    synthesis: r.synthesis,
    computed_at_round: r.computed_at_round,
    computed_at_band,
    computed_at_column,
    computed_at_at: r.computed_at_at,
    trigger,
  };
}
