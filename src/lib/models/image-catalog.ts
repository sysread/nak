/**
 * Venice image-model catalog: the wire shape Venice returns from
 * `GET /api/v1/models?type=image` and the defensive coercion that turns
 * it into the flat `ImageCatalogModel` the Settings image-generation
 * picker reads.
 *
 * Sibling of ./catalog.ts (the text slice), kept separate because the
 * `model_spec` shape differs by model family: image models carry
 * per-image pricing (`pricing.generation.usd`) and size/prompt
 * constraints instead of the text slice's context window, reasoning, and
 * function-calling capabilities. None of the text picker's capability
 * chips mean anything for an image model, so the two never share a type.
 *
 * What the picker actually shows per row: the friendly name plus the
 * per-image price - the one number a user weighs when choosing a backend.
 * Beta and deprecation ride along as badges. The browser never holds the
 * Venice key, so this arrives through the venice edge function's `models`
 * route (SupabaseService.fetchImageModels) and coercion stays here so it
 * is unit-testable offline against a captured response body.
 */

/**
 * One image model as the picker needs it. Flattened from Venice's nested
 * `model_spec`. Only priced models make it this far - `coerceImageModel`
 * drops anything without a flat per-image USD rate (see its docblock for
 * the two unpriced cases and why), so `usdPerImage` is always a real
 * number here and the picker never shows a price-less row.
 */
export interface ImageCatalogModel {
  readonly id: string;
  /** Human-facing name from `model_spec.name`, e.g. "Venice SD3.5". */
  readonly name: string;
  /** Flat USD per generated image, from `pricing.generation.usd`. */
  readonly usdPerImage: number;
  /** Gated to beta-flagged keys (`beta` or `betaModel`). */
  readonly beta: boolean;
  /** True when `model_spec.deprecation.date` is set - retiring soon. */
  readonly deprecated: boolean;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function usdFrom(block: unknown): number | null {
  const rec = asRecord(block);
  const usd = rec?.usd;
  return typeof usd === 'number' && Number.isFinite(usd) ? usd : null;
}

/**
 * Coerce one raw `/models?type=image` entry into an ImageCatalogModel, or
 * null when the entry is unusable. Dropped: missing id, offline, and -
 * deliberately - any model without a flat per-image USD price. Two kinds
 * of model land in that last bucket:
 *
 *   1. No pricing block at all - Venice omits it on free / internal
 *      models. (A blank price is NOT a crypto/DIEM thing: Venice prices
 *      every real model in both USD and DIEM, so a missing block means
 *      unpriced/internal, not payment-gated.)
 *   2. Resolution-tiered pricing (`pricing.resolutions.<tier>`) - a real
 *      price, but per output size rather than one flat rate, so there's
 *      no single number to put in the pill.
 *
 * We drop both rather than show a "n/a" row the user can't reason about.
 *
 * TODO: case 2 hides a model that is actually usable and priced. No
 * current Venice image model is resolution-tiered, so this is acceptable
 * today; if one appears, surface it with a representative "from $X" price
 * (cheapest tier) instead of dropping it.
 */
function coerceImageModel(raw: unknown): ImageCatalogModel | null {
  const entry = asRecord(raw);
  if (!entry) return null;
  const id = entry.id;
  if (typeof id !== 'string' || id.length === 0) return null;

  const spec = asRecord(entry.model_spec);
  if (!spec) return null;

  // offline: in the catalog but cannot serve requests right now. Treat as
  // absent so the picker never offers a model that will fail at send time.
  if (spec.offline === true) return null;

  const pricing = asRecord(spec.pricing);
  const usdPerImage = usdFrom(pricing?.generation);
  // No flat per-image price - drop it (see docblock). Keeps the picker to
  // models with a real number to show.
  if (usdPerImage === null) return null;

  const name = typeof spec.name === 'string' && spec.name.length > 0 ? spec.name : id;

  return {
    id,
    name,
    usdPerImage,
    beta: spec.beta === true || spec.betaModel === true,
    deprecated: asRecord(spec.deprecation)?.date != null,
  };
}

/**
 * Coerce Venice's `GET /models?type=image` response body into a sorted
 * ImageCatalogModel list. Accepts the `{ object, type, data: [...] }`
 * envelope or a bare array. Drops unusable entries silently (the picker
 * shows what is usable; a malformed row is not worth surfacing an error
 * over). Sorted by name so the dropdown reads alphabetically regardless
 * of Venice's catalog order.
 */
export function coerceImageCatalog(raw: unknown): ImageCatalogModel[] {
  const envelope = asRecord(raw);
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(envelope?.data)
      ? (envelope!.data as unknown[])
      : [];
  const out: ImageCatalogModel[] = [];
  for (const item of list) {
    const model = coerceImageModel(item);
    if (model) out.push(model);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
