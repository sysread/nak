// Project-global model price-cap enforcement (edge side).
//
// The deployment owner sets an optional ceiling on the per-1M-token
// input/output USD price of any model a user-triggered chat may run. The
// ceiling lives on the project-global app_config row (the same singleton
// that holds the shared Venice key), written only by `mise run setup` via
// the service role - there is no in-app editor and no write policy. The
// venice function reads it (see readPriceCaps in venice/index.ts) and
// hands it to assertModelWithinCap, which rejects an over-cap model before
// relaying the turn to Venice.
//
// Why server-side: the cap has to be enforced where the browser cannot
// reach it, since the browser is fully user-controlled. app_config is
// readable by any authenticated member, so the browser-side picker filter
// (when it lands) reads the SAME caps to hide over-cap models, but that is
// UX only - this check is the boundary.
//
// Pricing is read from Venice's live /models catalog (veniceFetchModels),
// TTL-cached at module scope so enforcement adds no Venice round trip to
// the chat hot path in steady state. Using the live catalog - rather than
// the curated src/lib/models registry, which carries no pricing - is what
// lets the cap price the built-in tier defaults too.
//
// Posture: this is a COST guardrail, not a security boundary. It fails
// OPEN on anything it cannot evaluate (catalog unreachable, model absent
// from the catalog, pricing block omitted) - a Venice hiccup must never
// take down all chat, and a model with no published price cannot exceed a
// price cap. The only hard stop is a model whose published price is
// above a configured ceiling.

import { VeniceError, veniceFetchModels } from './venice.ts';

/** A per-1M-token USD ceiling. null on a dimension means "no cap there". */
export interface ModelPriceCaps {
  readonly maxInputUsdPerM: number | null;
  readonly maxOutputUsdPerM: number | null;
}

/** A model's published per-1M-token USD price. null when Venice omits it. */
export interface ModelPrice {
  readonly inputUsdPerM: number | null;
  readonly outputUsdPerM: number | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

// Coerce a stored cap to "an active ceiling" (a positive number) or null
// ("no cap on this side"). 0 is the schema's no-limit sentinel, so it maps
// to null and flows through the rest of the module as an uncapped
// dimension - the same shape a malformed or negative value degrades to.
// Accepts a numeric STRING as well as a number: PostgREST serializes a
// `numeric` column as a JSON string to preserve arbitrary precision, so a
// cap set in app_config arrives here as e.g. "3.00" or "0".
function capValue(v: unknown): number | null {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
  else return null;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Coerce a raw app_config row into caps. Defensive because the values are
 * operator-entered config (via `mise run setup`), not trusted internal
 * data - validating here is the boundary check. A non-number / negative /
 * absent column reads as "no cap on that side."
 */
export function coercePriceCaps(row: unknown): ModelPriceCaps {
  const rec = asRecord(row) ?? {};
  return {
    maxInputUsdPerM: capValue(rec.max_input_usd_per_m),
    maxOutputUsdPerM: capValue(rec.max_output_usd_per_m),
  };
}

/** True when at least one dimension carries a ceiling. */
export function capsConfigured(caps: ModelPriceCaps): boolean {
  return caps.maxInputUsdPerM !== null || caps.maxOutputUsdPerM !== null;
}

function usdFrom(block: unknown): number | null {
  const usd = asRecord(block)?.usd;
  return typeof usd === 'number' && Number.isFinite(usd) ? usd : null;
}

/**
 * Flatten Venice's GET /models response into an id -> price map. Mirrors
 * the pricing read in src/lib/models/catalog.ts (coerceModel / usdFrom);
 * duplicated rather than imported because the edge bundle cannot pull from
 * src/lib (the Deno-island split). Accepts the `{ data: [...] }` envelope
 * or a bare array. Venice's `model_spec.pricing.input.usd` is already
 * denominated per 1,000,000 tokens, so it compares directly to the caps.
 */
export function extractModelPrices(raw: unknown): Map<string, ModelPrice> {
  const envelope = asRecord(raw);
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(envelope?.data)
      ? (envelope!.data as unknown[])
      : [];
  const out = new Map<string, ModelPrice>();
  for (const item of list) {
    const entry = asRecord(item);
    if (!entry) continue;
    const id = entry.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const pricing = asRecord(asRecord(entry.model_spec)?.pricing);
    out.set(id, {
      inputUsdPerM: usdFrom(pricing?.input),
      outputUsdPerM: usdFrom(pricing?.output),
    });
  }
  return out;
}

/**
 * The reason a price breaches the caps, or null when it's within them.
 * A null price on either side is "unpriced", which never breaches (see
 * the fail-open posture in the file header). Pure - the testable core of
 * the cap decision.
 */
export function overCapReason(price: ModelPrice, caps: ModelPriceCaps): string | null {
  if (
    caps.maxInputUsdPerM !== null &&
    price.inputUsdPerM !== null &&
    price.inputUsdPerM > caps.maxInputUsdPerM
  ) {
    return `input $${price.inputUsdPerM}/1M exceeds the $${caps.maxInputUsdPerM}/1M cap`;
  }
  if (
    caps.maxOutputUsdPerM !== null &&
    price.outputUsdPerM !== null &&
    price.outputUsdPerM > caps.maxOutputUsdPerM
  ) {
    return `output $${price.outputUsdPerM}/1M exceeds the $${caps.maxOutputUsdPerM}/1M cap`;
  }
  return null;
}

// Mirror the browser catalog's 15-min staleness window (CATALOG_STALE_MS
// in src/lib/models-catalog.svelte.ts) so the server and the picker age
// pricing on the same clock. Module-scope so it survives across requests
// in a warm isolate; a cold start just refetches.
const PRICE_CACHE_TTL_MS = 15 * 60 * 1000;
let priceCache: Map<string, ModelPrice> | null = null;
let priceCacheAt = 0;

async function loadPrices(apiKey: string, fetchImpl?: typeof fetch): Promise<Map<string, ModelPrice>> {
  const now = Date.now();
  if (priceCache && now - priceCacheAt < PRICE_CACHE_TTL_MS) return priceCache;
  const raw = await veniceFetchModels({ apiKey, fetchImpl });
  priceCache = extractModelPrices(raw);
  priceCacheAt = now;
  return priceCache;
}

/**
 * Reject a model whose live Venice price breaches the project caps.
 * Throws a 403 VeniceError on breach (the handler relays it as a clean
 * pre-stream error); returns silently otherwise - including every
 * fail-open case. Inert when no cap is configured, so the default
 * (all-null) root config adds nothing to the hot path.
 */
export async function assertModelWithinCap(opts: {
  model: unknown;
  apiKey: string;
  caps: ModelPriceCaps;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const caps = opts.caps;
  if (!capsConfigured(caps)) return;
  if (typeof opts.model !== 'string' || opts.model.length === 0) return;

  let prices: Map<string, ModelPrice>;
  try {
    prices = await loadPrices(opts.apiKey, opts.fetchImpl);
  } catch (err) {
    // Fail-open: a Venice /models hiccup must not block every chat turn.
    // The 15-min cache makes this rare in steady state.
    console.warn(
      `[venice/price-cap] catalog fetch failed, skipping cap check: ${(err as Error).message}`,
    );
    return;
  }

  const price = prices.get(opts.model);
  // Unknown / uncatalogued id: free or internal models drop the pricing
  // block, and a curated edge id may not appear under ?type=text. Cannot
  // price it -> cannot exceed a price cap -> allow. A genuinely bogus id
  // is Venice's to reject at completion, not ours.
  if (!price) return;

  const reason = overCapReason(price, caps);
  if (reason) {
    throw new VeniceError(
      `Model "${opts.model}" is blocked by the project price cap: ${reason}.`,
      'http',
      403,
    );
  }
}

// Test-only hook: reset the module-scope price cache between cases. Kept
// out of the production surface per CLAUDE.md's test-hook convention.
export const __test = {
  resetCache(): void {
    priceCache = null;
    priceCacheAt = 0;
  },
};
