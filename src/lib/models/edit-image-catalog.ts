/**
 * Venice image-EDIT-model catalog: the wire shape Venice returns from
 * `GET /api/v1/models?type=inpaint` and the defensive coercion that turns
 * it into the flat `EditCatalogModel` the Settings edit-model picker
 * reads. Sibling of ./image-catalog.ts (the generation slice), kept
 * separate because the pricing field differs (`pricing.inpaint.usd` per
 * edit rather than `pricing.generation.usd`) and edit models carry a
 * privacy tier the generation picker never surfaced: `private` models are
 * served on Venice infrastructure, `anonymized` ones are proxied to third
 * parties with the prompt body - worth a chip on a tool that ships the
 * user's own photos.
 *
 * Unlike the generation slice, every live inpaint model carries a flat
 * per-edit USD rate (verified 2026-10-12), so the "drop resolution-tiered
 * rows" wrinkle image-catalog.ts documents does not exist here. The
 * coercion still drops unpriced rows for the same reason: the picker
 * never shows a price-less row.
 */

export interface EditCatalogModel {
  readonly id: string;
  /** Human-facing name from `model_spec.name`, e.g. "FireRed Image Edit". */
  readonly name: string;
  /** Flat USD per edited image, from `pricing.inpaint.usd`. */
  readonly usdPerEdit: number;
  /**
   * Venice serving tier: 'private' keeps prompt bodies on Venice's
   * infrastructure; 'anonymized' proxies them to a third-party provider.
   * Display-only (the text pickers' chip semantics).
   */
  readonly privacy: 'private' | 'anonymized';
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
 * Coerce one raw `/models?type=inpaint` entry into an EditCatalogModel,
 * or null when the entry is unusable: missing id, offline, or no flat
 * per-edit price - the picker shows what is usable.
 */
function coerceEditModel(raw: unknown): EditCatalogModel | null {
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
  const usdPerEdit = usdFrom(pricing?.inpaint);
  if (usdPerEdit === null) return null;

  const name = typeof spec.name === 'string' && spec.name.length > 0 ? spec.name : id;
  const privacy = spec.privacy === 'anonymized' ? 'anonymized' : 'private';

  return {
    id,
    name,
    usdPerEdit,
    privacy,
    beta: spec.beta === true || spec.betaModel === true,
    deprecated: asRecord(spec.deprecation)?.date != null,
  };
}

/**
 * Coerce Venice's `GET /models?type=inpaint` response body into a sorted
 * EditCatalogModel list. Accepts the `{ object, type, data: [...] }`
 * envelope or a bare array. Drops unusable entries silently; sorted by
 * name so the dropdown reads alphabetically.
 */
export function coerceEditCatalog(raw: unknown): EditCatalogModel[] {
  const envelope = asRecord(raw);
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(envelope?.data)
      ? (envelope!.data as unknown[])
      : [];
  const out: EditCatalogModel[] = [];
  for (const item of list) {
    const model = coerceEditModel(item);
    if (model) out.push(model);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
