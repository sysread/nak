// Project-global model price-cap enforcement (edge side).
//
// The deployment owner ("root") sets an optional ceiling on the per-1M-
// token input/output USD price of any model a user-triggered chat may
// run. This module reads that ceiling from the embedded global root
// config (./root-config.json) and rejects an over-cap model before the
// venice function relays the turn to Venice.
//
// Why it lives in _shared and embeds the JSON: the cap has to be enforced
// server-side because the browser is fully user-controlled, and the only
// build-time channel into the deployed edge bundle is a relative import
// the deploy bundler (esbuild) can follow. The JSON sits beside this
// module so `supabase functions deploy` inlines it; nothing reaches
// outside the functions tree (the deploy bundles per-function and does
// not pull in repo-root files). One file is the single source of truth -
// the browser-side picker filter, when it lands, reads the same JSON by
// importing upward into here (Vite resolves any path), so the two halves
// can never disagree.
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

import rootConfig from './root-config.json' with { type: 'json' };
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

// A cap value is only meaningful as a finite, non-negative number; any
// other shape (a hand-edit typo, a string, a negative) reads as "no cap"
// so a malformed config degrades to inert rather than blocking everything.
function capValue(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Read and validate the caps off the embedded root config. Defensive
 * because the JSON is hand-edited config, not trusted internal data -
 * validating here is the boundary check.
 */
export function readCaps(raw: unknown): ModelPriceCaps {
  const caps = asRecord(asRecord(raw)?.modelPriceCaps) ?? {};
  return {
    maxInputUsdPerM: capValue(caps.maxInputUsdPerM),
    maxOutputUsdPerM: capValue(caps.maxOutputUsdPerM),
  };
}

/** The caps from the embedded config, read once at module load. */
const rootCaps: ModelPriceCaps = readCaps(rootConfig);

/** True when at least one dimension carries a ceiling. */
export function capsConfigured(caps: ModelPriceCaps = rootCaps): boolean {
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
  caps?: ModelPriceCaps;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const caps = opts.caps ?? rootCaps;
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

// Test-only hooks: reset the module-scope cache between cases and reach
// the embedded caps without re-reading the file. Kept out of the
// production surface per CLAUDE.md's test-hook convention.
export const __test = {
  resetCache(): void {
    priceCache = null;
    priceCacheAt = 0;
  },
  rootCaps,
};
