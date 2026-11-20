/**
 * UI-behavior primitives for the B8 clarity notice.
 *
 * Owns the jsonb coercion + the notice-to-display transform so the
 * Chat.svelte rendering holds only composition (the second-thoughts
 * precedent). The verdict is written server-side by the clarity stage
 * (supabase/functions/venice/getStreamingResponse.ts) onto the
 * ORIGINAL row before the rewrite streams; this is the read side.
 * Coercion is defensive: a row predating the column, a drifting
 * shape, or a failed rewrite (the stage clears the chip on failure)
 * all read as null and the UI renders nothing.
 *
 * The connective into replay (why the next turn's model sees a
 * <think> line between the two answers) is assembled at replay time
 * from this same field - see prompt-assembly.ts.
 */

export interface ClarityVerdict {
  /** The judge's clarity score (0-indexed rubric, 0 = riddled). */
  score: number;
  /** Assistant-voiced notice copy shown between the two messages. */
  notice: string;
  /** The id of the rewrite message this verdict produced. */
  rewrite_id: string;
}

/**
 * Coerce the raw `messages.clarity` jsonb into a verdict, or null
 * when it is absent / the wrong shape / an unknown schema version.
 * Null is the "render nothing" signal.
 */
export function coerceClarity(raw: unknown): ClarityVerdict | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.v !== 1) return null;
  const score = obj.score;
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  const notice = obj.notice;
  if (typeof notice !== 'string' || notice.trim().length === 0) return null;
  const rewriteId = obj.rewrite_id;
  if (typeof rewriteId !== 'string' || rewriteId.length === 0) return null;
  return { score, notice: notice.trim(), rewrite_id: rewriteId };
}
