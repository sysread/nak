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
 * `model_spec`. Pricing is nullable because Venice omits the block on
 * free / internal models, and because models priced per-resolution-tier
 * (rather than a single flat per-image rate) have no single number to
 * show here - those read as "Pricing n/a" rather than a misleading tier.
 */
export interface ImageCatalogModel {
  readonly id: string;
  /** Human-facing name from `model_spec.name`, e.g. "Venice SD3.5". */
  readonly name: string;
  /**
   * Flat USD per generated image, from `pricing.generation.usd`. Null
   * when Venice omits pricing or prices the model per resolution tier
   * (`pricing.resolutions.*`), which has no single representative rate.
   */
  readonly usdPerImage: number | null;
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
 * null when the entry is unusable (missing id, or offline). Defensive on
 * every field: Venice marks the endpoint's shape loosely and free models
 * drop the pricing block entirely.
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

  const name = typeof spec.name === 'string' && spec.name.length > 0 ? spec.name : id;
  const pricing = asRecord(spec.pricing);

  return {
    id,
    name,
    // Flat per-image rate only. Per-resolution-tier pricing
    // (pricing.resolutions.*) has no single number to surface, so it
    // reads as "n/a" rather than picking an arbitrary tier.
    usdPerImage: usdFrom(pricing?.generation),
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
