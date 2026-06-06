/**
 * Venice /models catalog: the wire shape Venice returns from
 * `GET /api/v1/models?type=text` and the defensive coercion that turns
 * it into the flat `CatalogModel` the Settings model-picker reads.
 *
 * Why this lives apart from ./index.ts: that file is the curated,
 * compile-time registry (the ids Nak pins from a tier or an agent, plus
 * the hand-discovered safety flags like `leaksSpecialTokens` that the
 * API cannot supply). This file is the runtime catalog - the full list
 * of text models Venice currently serves, fetched live, used only to
 * populate the per-tier model dropdown and to snapshot a chosen model's
 * capabilities into `profiles.settings.tierModels`. The two never merge:
 * curated flags are keyed by concrete id and keep applying to a
 * user-picked id automatically (e.g. the slop guard arms on
 * deepseek-v4-flash whoever points a tier at it), while the catalog
 * supplies the window/pricing/capability data the registry would
 * otherwise have to hardcode for every model the user might choose.
 *
 * The browser never holds the Venice key, so the catalog arrives through
 * the venice edge function's `models` route (see SupabaseService.fetchModels);
 * coercion stays here so it is unit-testable offline against a captured
 * response body.
 */

/**
 * One text model as the picker needs it. Flattened from Venice's nested
 * `model_spec` so the UI and the snapshot builder read plain fields.
 * Pricing is nullable because Venice omits the block on free / internal
 * models (see the venice-models skill's "pricing can be missing" gotcha).
 */
export interface CatalogModel {
  readonly id: string;
  /** Human-facing name from `model_spec.name`, e.g. "GLM 5.1". */
  readonly name: string;
  /** Context window in tokens, from `model_spec.availableContextTokens`. */
  readonly contextWindow: number;
  /** Accepts OpenAI-compatible multimodal image_url parts. */
  readonly supportsVision: boolean;
  /**
   * Honors the `reasoning_effort` body field. Mapped from Venice's
   * `supportsReasoningEffort` (the knob nak actually sends), falling back
   * to `supportsReasoning` when the more specific flag is absent. This is
   * the flag that gates whether the chat loop forwards reasoning_effort -
   * some providers 4xx on the field they do not recognise.
   */
  readonly supportsReasoning: boolean;
  /** Tools are allowed (`supportsFunctionCalling`). */
  readonly supportsFunctionCalling: boolean;
  /** Honors `response_format: json_schema` (`supportsResponseSchema`). */
  readonly supportsResponseFormat: boolean;
  /** USD per 1,000,000 input tokens, or null when Venice omits pricing. */
  readonly inputUsdPerM: number | null;
  /** USD per 1,000,000 output tokens, or null when Venice omits pricing. */
  readonly outputUsdPerM: number | null;
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
 * Coerce one raw `/models` entry into a CatalogModel, or null when the
 * entry is unusable (missing id / context window, or offline). Defensive
 * on every field: Venice marks the endpoint's shape loosely and free
 * models drop the pricing block entirely.
 */
function coerceModel(raw: unknown): CatalogModel | null {
  const entry = asRecord(raw);
  if (!entry) return null;
  const id = entry.id;
  if (typeof id !== 'string' || id.length === 0) return null;

  const spec = asRecord(entry.model_spec);
  if (!spec) return null;

  // offline: in the catalog but cannot serve requests right now. Treat as
  // absent so the picker never offers a model that will fail at send time.
  if (spec.offline === true) return null;

  const context = spec.availableContextTokens;
  if (typeof context !== 'number' || !Number.isFinite(context) || context <= 0) {
    return null;
  }

  const caps = asRecord(spec.capabilities) ?? {};
  const pricing = asRecord(spec.pricing);

  const name = typeof spec.name === 'string' && spec.name.length > 0 ? spec.name : id;

  return {
    id,
    name,
    contextWindow: context,
    supportsVision: caps.supportsVision === true,
    // Prefer the effort-specific flag (what we gate the wire field on);
    // fall back to the generic reasoning flag when Venice omits it.
    supportsReasoning:
      caps.supportsReasoningEffort === true ||
      (caps.supportsReasoningEffort === undefined && caps.supportsReasoning === true),
    supportsFunctionCalling: caps.supportsFunctionCalling === true,
    supportsResponseFormat: caps.supportsResponseSchema === true,
    inputUsdPerM: usdFrom(pricing?.input),
    outputUsdPerM: usdFrom(pricing?.output),
    deprecated: asRecord(spec.deprecation)?.date != null,
  };
}

/**
 * Coerce Venice's `GET /models` response body into a sorted CatalogModel
 * list. Accepts the `{ object, type, data: [...] }` envelope or a bare
 * array. Drops unusable entries silently (the picker shows what is
 * usable; a malformed row is not worth surfacing an error over). Sorted
 * by name so the dropdown reads alphabetically regardless of Venice's
 * catalog order.
 */
export function coerceCatalog(raw: unknown): CatalogModel[] {
  const envelope = asRecord(raw);
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(envelope?.data)
      ? (envelope!.data as unknown[])
      : [];
  const out: CatalogModel[] = [];
  for (const item of list) {
    const model = coerceModel(item);
    if (model) out.push(model);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
