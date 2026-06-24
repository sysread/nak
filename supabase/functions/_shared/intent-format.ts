// intent-format -----------------------------------------------------------
//
// The canonical renderer for the "Working intentions" block that rides
// in the main chat LLM's system prompt, built from the minter-maintained
// `intents` rows. Priming runs server-side, so a future
// applyIntentPriming (venice/priming.ts) will call this to render the
// block and append it to the system message before the first round,
// right after the bias-profile block (see docs/dev/prompt-augmentation.md
// and docs/dev/in-progress/intents.md).
//
// Self-contained (no relative imports) so the Deno island, vitest
// (tests/intent-format.test.ts), and tsc can all load it - same
// constraint bias-format.ts and intent-math.ts carry.
//
// This module is where TWO load-bearing design decisions live, both of
// which exist to keep a normative layer from issuing directives that
// fight the descriptive layer or the user:
//
//   1. Dispositional framing. Intents render as longer-arc LEANS
//      ("when natural, incline toward X"), never as turn-level
//      commands. Bias compensation is an in-the-moment imperative;
//      framing intents as leans lets the two coexist (the model can
//      name a contrary view AND do it in a way that affirms the user's
//      capacity) instead of colliding. The minter is supposed to write
//      dispositional statements; this block's preamble is the second
//      line of defense if it slips.
//   2. Explicit precedence. The block STATES the order - the user's
//      explicit instructions first, then in-the-moment accuracy /
//      compensation guidance, then these intentions last - rather than
//      leaving it to prose proximity. An intent must never override
//      what the user explicitly asks for; that is the brake on the
//      normative layer.

/**
 * Max intents rendered into the system-prompt block on their own. The
 * minter is expected to keep the active set at or below this, so the
 * cap here is mostly a safety belt.
 */
export const INTENT_RENDER_CAP = 3;

/**
 * The shared ceiling across the bias appendix AND the intent block,
 * which ride in the same region of the system prompt. The bias doc
 * found that more than ~four behavioral rules crowd out the actual
 * instruction surface; stacking a second feature's block into the same
 * region must not silently double that load. The priming orchestrator
 * computes the intent block's effective cap as
 * `min(INTENT_RENDER_CAP, COMBINED_APPENDIX_CEILING - biasRendered)`
 * and passes it as `opts.cap` so intents yield to bias when both are
 * full (bias is evidence-backed; intents are aspirational).
 */
export const COMBINED_APPENDIX_CEILING = 6;

/** Status vocabulary for intents rows. Mirrors the DB check constraint. */
export type IntentStatus = 'active' | 'dormant' | 'retired';

/**
 * The minimal shape this renderer needs from an `intents` row. The
 * caller reads the full rows and maps to this; the renderer only needs
 * the statement and the status. Caller passes rows in the order it
 * wants them to appear (recency order in practice); a stable sort here
 * preserves that for the cap's drop decision.
 */
export interface IntentRenderRow {
  statement: string;
  status: IntentStatus;
}

/**
 * Pick the renderable subset: active rows only, capped. `cap` defaults
 * to INTENT_RENDER_CAP; the orchestrator passes a smaller value when
 * the bias appendix has already consumed part of the combined ceiling.
 * A non-positive cap yields an empty list (intents fully yielded to
 * bias this turn).
 */
export function pickRenderable(
  rows: readonly IntentRenderRow[],
  cap: number = INTENT_RENDER_CAP,
): IntentRenderRow[] {
  if (cap <= 0) return [];
  return rows.filter((r) => r.status === 'active').slice(0, cap);
}

/**
 * Render the system-prompt block. Returns null when no active intents
 * survive the cap - same null-means-omit convention bias-format and the
 * samskara compound summary use. The caller omits the section entirely
 * rather than rendering a placeholder.
 */
export function formatIntentsBlock(
  rows: readonly IntentRenderRow[],
  opts: { cap?: number } = {},
): string | null {
  const picks = pickRenderable(rows, opts.cap ?? INTENT_RENDER_CAP);
  if (picks.length === 0) return null;

  const bullets = picks.map((r) => `- ${r.statement.trim()}`);

  return [
    '# Working intentions',
    '',
    "These are longer-arc directions you are quietly working toward with this user, formed from patterns across past conversations. They are dispositional leans, NOT instructions for this turn: when it is natural, incline toward them; otherwise let them rest. Never force one, never announce them as an agenda, and never let one steer you away from what the user is actually asking for right now.",
    '',
    ...bullets,
    '',
    "Order of precedence when anything conflicts: the user's explicit instructions come first, always; then in-the-moment accuracy and any compensation guidance above; then these intentions, last. Where an intention would pull against the user's stated wishes or against being accurate and useful this turn, set it aside - it is a gentle long-term lean, not a mandate. These are also suspended in jokes, banter, fiction, role-play, and hypotheticals, the same as the framing rules above.",
  ].join('\n');
}
