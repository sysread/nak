// context-recall-payload (function-side payload shape + coercer)
//
// The persisted ContextRecallPayload shape and its coercer, plus the
// ephemeral <think>-message builder the orchestrator splices onto the
// wire. The payload TYPE + coercer shape are shared with the surviving
// browser copy in src/lib/context-recall/types.ts: the browser coerces
// realtime echo payloads off the stream channel, the server coerces the
// jsonb DB row, so both runtimes read the same persisted shape and must
// agree on it (mirror-with-pointer-comment convention; see
// tests/bias-catalog-parity.test.ts header). The two runtimes cannot
// share an import (Deno needs .ts-suffixed relative specifiers; the
// vite/tsc side forbids them), so the shape lives twice - keep them in
// lockstep when either changes.
//
// The persisted shape (ContextRecallPayload) is what lands in
// threads.context_recall_payload jsonb. The orchestrator owns the
// coerce-from-jsonb read path; the pipeline writes the shape directly.

import { type IntuitionTrigger } from '../../_shared/priming-triggers.ts';

/**
 * One citation resolved from a `^N^` superscript in the recall note.
 * `index` is 1-based and matches the superscript; `kind` + `id` point
 * at the source row so the UI can link to the in-app route and the
 * model can drill down to verify. Mirror of ContextRecallCitation in
 * src/lib/context-recall/types.ts - keep the two in lockstep.
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
  /** Schema version. Bumped when the shape changes; the coercer treats
   *  an unknown version as "no cache" and triggers a fresh refresh on
   *  the next opportunity. */
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
   * when the note is empty or the smoothing pass cited nothing. Rows
   * are keyed by `index`, not by array position.
   */
  citations: ContextRecallCitation[];

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
 * Mirror of the browser coercer in src/lib/context-recall/types.ts.
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
