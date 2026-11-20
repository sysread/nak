/**
 * UI-behavior primitives for the clarity notice (B8) + the composite
 * smoothing check (B9).
 *
 * Owns the jsonb coercion + the notice-to-display transform so the
 * Chat.svelte rendering holds only composition (the second-thoughts
 * precedent). The verdict is written server-side by the post-message
 * stage (supabase/functions/venice/getStreamingResponse.ts) onto the
 * ORIGINAL row before the rewrite streams; this is the read side.
 * Coercion delegates to the shared module's coerceClarityChip - the
 * ONE v1->v2 mapping owner (src/lib/ui never re-implements the
 * shape logic; the browser resolves $shared - vite.config.ts).
 *
 * The connective into replay (why the next turn's model sees a
 * <think> line between the two answers) is assembled at replay time
 * from this same field - see prompt-assembly.ts.
 */

import { coerceClarityChip, type ClarityCheck } from '$shared/clarity';

export interface ClarityVerdict {
  /** Per-check scores (null = drifted/unparseable; fail-open). */
  checks: { clarity: number | null; smoothing: number | null };
  /** Which checks failed and drove the rewrite. */
  failed: ClarityCheck[];
  /** Assistant-voiced notice copy shown between the two messages. */
  notice: string;
  /** The id of the rewrite message this verdict produced. */
  rewrite_id: string;
}

/**
 * Coerce the raw `messages.clarity` jsonb into a verdict, or null
 * when it is absent / the wrong shape / an unknown schema version.
 * Null is the "render nothing" signal. v1 chips (the B8 shape) map
 * forward with their stored notice preserved.
 */
export function coerceClarity(raw: unknown): ClarityVerdict | null {
  return coerceClarityChip(raw);
}

/**
 * The UPDATE-echo backstop predicate (B9 D10): a row carrying ANY
 * decision payload - the second-thoughts verdict or the clarity chip -
 * must re-enter the transcript when fetched fresh, because the
 * realtime echo that usually delivers it can drop (a backgrounded
 * tab). The backfill's skip guard and apply gate share this
 * predicate; splitting them is how the chip-only row got dropped
 * (the skip guard treated either field as delivered while the apply
 * gate re-entered on second-thoughts only).
 */
export function rowCarriesDecisionPayload(
  row: { second_thoughts?: unknown; clarity?: unknown } | null | undefined,
): boolean {
  return row?.second_thoughts != null || row?.clarity != null;
}
