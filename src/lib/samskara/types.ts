/**
 * Shared types for the samskara feature.
 *
 * The chat-loop side imports `FireResult` and `Samskara` from here so
 * its callers don't need to know about Supabase row shapes. The
 * worker side imports the same types so the formation pipeline and
 * the chat-loop integration agree on what a fired samskara looks like.
 *
 * Why a separate types module rather than re-exporting from
 * `./index.ts`: index.ts pulls in the Supabase service and the
 * embedding model constant, and we don't want every consumer of a
 * type to drag those imports along.
 */

/**
 * One samskara that fired this turn. Mirrors the
 * `samskara_fire_top_k` RPC's row shape but with camelCased fields
 * for in-app consumption.
 */
export interface FiredSamskara {
  id: string;
  prediction: string;
  innerVoice: string | null;
  valence: number | null;
  confidence: number;
  health: number;
  /** cosine^1.3 * sqrt(health * confidence) * sample-size bonus at fire time. Higher = more relevant. */
  score: number;
}

/**
 * Result of one chat-time fire query. `cohortId` is the uuid the
 * chat-loop attaches to every samskara_fires row from this turn so
 * the reaction classifier can later score the cohort as a unit.
 */
export interface FireResult {
  cohortId: string;
  fired: FiredSamskara[];
}

/**
 * Shape passed to formatPriming. The compound prose summary is the
 * always-on "current model of the user" block; `fire` is the
 * situational top-k from this specific turn. Either may be empty.
 */
export interface PrimingInput {
  compoundSummary: string | null;
  fire: FireResult | null;
}

/**
 * Hard-coded tunables. Lifted out of the schema/RPC layer so changing
 * them doesn't require a `mise run sync`. Kept tiny on purpose: these
 * are the knobs we'd want to flip during early tuning.
 *
 *   K_BASE — base of the fire-query top-k.
 *   K_BASE * log10(N + 10) gives the actual cap. Ten samskaras allow
 *   ~5 fires; one hundred allow ~10; one thousand allow ~15. Caller
 *   floors at a minimum of 1 to handle the empty-corpus case.
 *
 *   PRIMING_CHAR_BUDGET — soft upper bound on the formatted block
 *   total (compound + fire). Picked so the worst-case turn adds about
 *   600 tokens to the system prompt, well under fast-model context.
 *
 *   STALE_CEILING_HOURS — if the compound row hasn't been regenerated
 *   in this many hours, we'd rather inject nothing than something
 *   stale. Matches the "graceful degradation" gotcha in
 *   docs/dev/samskara.md.
 */
export const K_BASE = 5;
export const PRIMING_CHAR_BUDGET = 2400;
export const STALE_CEILING_HOURS = 24;
