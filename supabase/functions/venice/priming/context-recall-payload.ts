// context-recall-payload (function-side mirror)
//
// Logic mirror of src/lib/context-recall/{types,ephemeral}.ts
// (mirror-with-pointer-comment convention; see
// tests/bias-catalog-parity.test.ts header). The two runtimes cannot
// share an import (Deno needs .ts-suffixed relative specifiers; the
// vite/tsc side forbids them), so the persisted payload shape, its
// coercer, and the ephemeral <think>-message builder live twice. Keep
// this in lockstep with the browser copies when either changes.
//
// The persisted shape (ContextRecallPayload) is what lands in
// threads.context_recall_payload jsonb. The orchestrator owns the
// coerce-from-jsonb read path; the pipeline writes the shape directly.

import { type IntuitionTrigger } from '../../_shared/priming-triggers.ts';

/**
 * One run of the context-recall pipeline, cached on the thread row.
 * Reused as-is across rounds until a trigger (cold-start, title
 * change, mood-band shift, stale fuse) invalidates it. The chat-loop
 * reconstructs the synthetic assistant <think> message at request
 * time from this payload.
 *
 * The `note` field carries the stitched first-person paragraph(s)
 * from the gathered index. Empty string is a legitimate cached state -
 * it means "nothing matched this round; cache the negative result so
 * the next trigger evaluation can debounce instead of re-running".
 */
export interface ContextRecallPayload {
  /** Schema version. Bumped when the shape changes; the coercer treats
   *  an unknown version as "no cache" and triggers a fresh refresh on
   *  the next opportunity. */
  v: 1;

  /**
   * Stitched first-person note assembled from the three gathered
   * layers. Empty string when every layer returned nothing - cached so
   * we don't re-run the pipeline on the next trigger fire when the
   * world hasn't changed.
   */
  note: string;

  /** User-message count at the time the cache was written. Used as the
   *  round-id - same value within all chat-loop iterations of one user
   *  turn, increments on every new user message. Identical semantics to
   *  IntuitionPayload.computed_at_round so the same trigger evaluator
   *  can read either cache. */
  computed_at_round: number;

  /** Mood band index at the time of the write (or null when no mood was
   *  available). Compared against the live band on subsequent rounds to
   *  detect shifts. */
  computed_at_band: number | null;

  /** Confidence column at the time of the write, or null when no mood
   *  was available. */
  computed_at_column: 'confident' | 'tentative' | null;

  /** Wall-clock timestamp (ms since epoch) of the write. Drives age
   *  comparisons in the freshness fuse and any future diagnostic UI. */
  computed_at_at: number;

  /** Why this run was scheduled. Persisted for observability. */
  trigger: IntuitionTrigger;
}

/**
 * Coerce an unknown jsonb value into a ContextRecallPayload, or null if
 * the shape doesn't match. The orchestrator's read path runs everything
 * through this so a drifting / older-version row is treated as "no
 * cache" and a fresh refresh runs on the next trigger.
 *
 * Note specifically: a zero-length `note` string is a VALID cached
 * state (= "nothing matched"). Don't mistake that for "missing" - it
 * carries information the trigger evaluator needs to debounce.
 */
export function coerceContextRecallPayload(
  raw: unknown,
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

/** Minimal message shape the <think> builder emits. Deliberately not
 *  the browser VeniceMessage - the orchestrator only needs role +
 *  content to splice the synthetic turn onto the wire. */
export interface ContextRecallThinkMessage {
  role: 'assistant';
  content: string;
}

/** Marker comment placed inside the `<think>` block so a future debug
 *  surface can identify synthetic context-recall turns. The LLM ignores
 *  HTML comments inside thought tags. */
export const CONTEXT_RECALL_THINK_MARKER = '<!-- context-recall-think -->';

/**
 * Project a cached payload into a message ready to splice into a
 * chat-loop history array. Returns null when the cached note is empty -
 * the caller should treat null identically to "no cache" (skip the
 * injection entirely; do not push an empty <think> block, which would
 * just burn tokens).
 *
 * The stitched note is wrapped in `<think>` tags and placed in an
 * assistant role so the model reads it as its own prior thought - "I
 * just remembered this before responding." The first-person voice the
 * gather emits is already in the right register; the wrapper just
 * frames it as recollection.
 */
export function buildContextRecallThinkMessage(
  payload: ContextRecallPayload,
): ContextRecallThinkMessage | null {
  if (payload.note.length === 0) return null;
  const content = `<think>\n${CONTEXT_RECALL_THINK_MARKER}\n${payload.note}\n</think>`;
  return { role: 'assistant', content };
}
