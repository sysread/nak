// The persisted intuition payload shape + coercer, plus the ephemeral
// <think>-message builder the orchestrator splices onto the wire.
//
// The persisted shape (IntuitionPayload) lands in
// `threads.intuition_payload` jsonb; coerceIntuitionPayload is the
// read-side coercion for a drifting / older-version row. The
// IntuitionPayload TYPE + coercer shape are shared with the surviving
// browser copy in src/lib/intuition/types.ts: the browser coerces
// realtime echo payloads off the stream channel, the server coerces the
// jsonb DB row, so both runtimes read the same persisted shape and must
// agree on it. The two runtimes cannot share an import, so the shape
// lives twice - keep them in lockstep when either changes.

import { type DriveName } from './intuition-prompts.ts';
import { type IntuitionTrigger } from '../../_shared/priming-triggers.ts';

/**
 * One run of the pipeline, cached on the thread row. Reused as-is across
 * rounds until a trigger invalidates it. The orchestrator reconstructs
 * the ephemeral assistant message at request time from this payload.
 */
export interface IntuitionPayload {
  /** Schema version. An unknown version coerces to "no cache". */
  v: 1;

  /** The objective-observer read of the conversation. Begins with
   *  "Classification: <category>" - normalized to "ambiguous" if the
   *  model elided the prefix. */
  perception: string;

  /** First-person reactions from each drive, keyed by DriveName. A drive
   *  that failed (rate-limit, parse error) is omitted. */
  drives: Partial<Record<DriveName, string>>;

  /** The synthesized internal monologue. This is what gets injected as
   *  `<think>` content on the ephemeral assistant message. */
  synthesis: string;

  /** User-message count at the time the cache was written. */
  computed_at_round: number;

  /** Mood band index at the time of the write (0..4, or null). */
  computed_at_band: number | null;

  /** Confidence column at the time of the write, or null. */
  computed_at_column: 'confident' | 'tentative' | null;

  /** Wall-clock timestamp (ms since epoch) of the write. */
  computed_at_at: number;

  /** Which trigger ran the pipeline. */
  trigger: IntuitionTrigger;
}

/**
 * Coerce an unknown jsonb value into an IntuitionPayload, or null if the
 * shape doesn't match. The orchestrator's read path runs everything
 * through this so a drifting / older-version row is treated as "no
 * cache" and a fresh refresh runs on the next trigger.
 */
export function coerceIntuitionPayload(raw: unknown): IntuitionPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (typeof r.perception !== 'string' || r.perception.length === 0) return null;
  if (typeof r.synthesis !== 'string' || r.synthesis.length === 0) return null;
  // Reject payloads where the synthesis is the synthesis prompt itself.
  // A live regression (fast-tier model echoing the system prompt as its
  // content when the conversation ended with an assistant message)
  // shipped bad payloads to the database with the prompt body sitting in
  // the synthesis field. Rejecting it here makes the next opportunity
  // treat the row as a cold cache and run a clean pipeline. The
  // signature phrase pairs two terms from the SYNTHESIS_PROMPT first
  // sentence ("AI agent" + "Subconsciousness") that no genuine synthesis
  // output should ever contain - the prompt explicitly forbids the
  // synthesis from referring to its own process.
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

/** Minimal Venice assistant-message shape. Defined locally rather than
 *  imported from the browser VeniceMessage union - the orchestrator only
 *  ever splices a string-content assistant turn here. */
interface IntuitionThinkMessage {
  role: 'assistant';
  content: string;
}

/** Marker comment placed inside the `<think>` block so the UI can
 *  identify synthetic intuition turns when (later) it renders intuition
 *  cards inline. The LLM ignores HTML comments inside thought tags. */
export const INTUITION_THINK_MARKER = '<!-- intuition-think -->';

/**
 * Project a cached payload into a Venice message ready to splice into a
 * history array. The output is always one assistant message; callers
 * append it directly. The synthesis is wrapped in `<think>` tags so the
 * model reads it as its own prior thought.
 */
export function buildIntuitionThinkMessage(
  payload: IntuitionPayload,
): IntuitionThinkMessage {
  const content = `<think>\n${INTUITION_THINK_MARKER}\n${payload.synthesis}\n</think>`;
  return { role: 'assistant', content };
}
