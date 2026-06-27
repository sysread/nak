/**
 * Browser-side model price caps: the project-wide per-1M-token USD
 * ceilings stored on the app_config row (max_input_usd_per_m /
 * max_output_usd_per_m), read here to hide over-cap models from the
 * Settings model picker.
 *
 * This mirrors the edge-side enforcement in
 * supabase/functions/_shared/price-cap.ts - the coercion (0 = no limit,
 * PostgREST numeric-as-string) and the over-cap comparison are duplicated
 * across the Deno-island boundary because the edge bundle cannot import
 * from src/lib and vice versa. The browser copy is UX only: it keeps a
 * user from PICKING a model the server would reject. The server check is
 * the actual boundary; if the two ever disagree, the server wins (a 403 at
 * send time), so the cost of drift is a confusing-but-safe picker, not an
 * over-budget call.
 */

import type { CatalogModel } from './catalog';

/** A per-1M-token USD ceiling. null on a dimension means "no cap there". */
export interface ModelPriceCaps {
  readonly maxInputUsdPerM: number | null;
  readonly maxOutputUsdPerM: number | null;
}

/** The "no ceiling on either side" caps, used to seed state before load. */
export const NO_PRICE_CAPS: ModelPriceCaps = {
  maxInputUsdPerM: null,
  maxOutputUsdPerM: null,
};

// Coerce a stored cap to an active ceiling (positive number) or null ("no
// cap"). 0 is the schema's no-limit sentinel, so it maps to null - as does
// a negative or malformed value. Accepts a numeric string because
// PostgREST serializes a `numeric` column as a JSON string to preserve
// precision, so a cap arrives here as e.g. "3.00" or "0".
function capValue(v: unknown): number | null {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
  else return null;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Coerce a raw app_config row (the two cap columns) into ModelPriceCaps.
 * Total + defensive: any absent / null / non-numeric / zero column reads
 * as "no cap on that side", so an unseeded row yields NO_PRICE_CAPS.
 */
export function coercePriceCaps(row: unknown): ModelPriceCaps {
  const rec = typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {};
  return {
    maxInputUsdPerM: capValue(rec.max_input_usd_per_m),
    maxOutputUsdPerM: capValue(rec.max_output_usd_per_m),
  };
}

/** True when at least one dimension carries a ceiling. */
export function capsConfigured(caps: ModelPriceCaps): boolean {
  return caps.maxInputUsdPerM !== null || caps.maxOutputUsdPerM !== null;
}

/**
 * True when a model's published price breaches either ceiling. An unpriced
 * side (Venice omits pricing on free / internal models) never breaches -
 * a model with no published price cannot exceed a price cap, matching the
 * server's fail-open posture.
 */
export function isModelOverCap(
  model: Pick<CatalogModel, 'inputUsdPerM' | 'outputUsdPerM'>,
  caps: ModelPriceCaps
): boolean {
  const overInput =
    caps.maxInputUsdPerM !== null &&
    model.inputUsdPerM !== null &&
    model.inputUsdPerM > caps.maxInputUsdPerM;
  const overOutput =
    caps.maxOutputUsdPerM !== null &&
    model.outputUsdPerM !== null &&
    model.outputUsdPerM > caps.maxOutputUsdPerM;
  return overInput || overOutput;
}

/**
 * Drop over-cap models from a catalog list so the picker never offers a
 * model the server would reject. A no-op (returns the list as given) when
 * no cap is configured, so the common uncapped case adds no work.
 */
export function filterCatalogByCaps(
  catalog: readonly CatalogModel[],
  caps: ModelPriceCaps
): CatalogModel[] {
  if (!capsConfigured(caps)) return [...catalog];
  return catalog.filter((m) => !isModelOverCap(m, caps));
}
