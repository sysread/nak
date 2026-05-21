/**
 * The bias-catalog key list and matching type guard.
 *
 * Split out of `./catalog` so the always-on chat-loop side (which
 * needs only `isBiasKey` to validate incoming bias strings against
 * the closed enum) doesn't drag the full BIAS_CATALOG with its
 * per-entry definition/example/nearMiss/guidance prose into the
 * main chunk. The catalog itself is needed only by the BiasProfile
 * screen (lazy) and the bias worker (separate bundle).
 *
 * BIAS_KEYS is the single source of truth for the closed enum. The
 * sibling `./catalog` types its object as
 * `Record<BiasKey, BiasEntry>`, so TS errors if a key listed here
 * is missing from the catalog, or if the catalog gains an extra
 * key not listed here. Adding a bias means editing this file AND
 * catalog.ts in the same change; the type-checker enforces the
 * pairing.
 */

export const BIAS_KEYS = [
  'confirmation_bias',
  'sunk_cost_fallacy',
  'anchoring',
  'availability_heuristic',
  'representativeness_heuristic',
  'base_rate_neglect',
  'affect_heuristic',
  'substitution',
  'framing_effect',
  'loss_aversion',
  'hindsight_bias',
  'overconfidence',
  'WYSIATI',
  'narrative_fallacy',
  'recency_bias',
  'fundamental_attribution_error',
  'negativity_bias',
  'black_and_white_thinking',
  'planning_fallacy',
] as const;

export type BiasKey = (typeof BIAS_KEYS)[number];

const KEY_SET: ReadonlySet<string> = new Set(BIAS_KEYS);

/**
 * Type-narrowing guard. The observer agent emits strings; this is
 * how we validate them at ingest before they hit the DB enum check.
 * Unknown strings are dropped with a debug log; never coerced.
 */
export function isBiasKey(s: string): s is BiasKey {
  return KEY_SET.has(s);
}
