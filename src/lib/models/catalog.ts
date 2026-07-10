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
 * Venice's serving-privacy classification for a model. 'private' means
 * Venice hosts the weights itself; 'anonymized' means the request is
 * proxied to an upstream provider (OpenAI, Anthropic, Google, ...) with
 * identifying metadata stripped, so the prompt content leaves Venice's
 * infrastructure. Null when the API omits or mangles the field - the UI
 * shows nothing rather than guessing a classification.
 */
export type ModelPrivacy = 'private' | 'anonymized';

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
   * Reasoning-capable: the model emits a thinking pass and/or accepts the
   * `reasoning_effort` knob. Venice splits this into two capability flags -
   * `supportsReasoning` (emits a thinking pass) and `supportsReasoningEffort`
   * (honors the granular effort knob) - and a model can have the first
   * without the second (qwen-3-7-plus is one: it reasons but Venice reports
   * `supportsReasoningEffort: false`). nak collapses both into this single
   * flag because the reasoning picker's "Off" position maps to
   * `disable_thinking` (meaningful for any thinking model) and the
   * low/medium/high positions map to `reasoning_effort`, which Venice
   * accepts on reasoning models even when it doesn't honor the granular
   * level. Gating on `supportsReasoningEffort` alone wrongly disabled the
   * picker for reason-but-no-effort models.
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
  /** Serving privacy, or null when Venice doesn't report it. */
  readonly privacy: ModelPrivacy | null;
  /** Served end-to-end encrypted (`capabilities.supportsE2EE`). */
  readonly supportsE2EE: boolean;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function usdFrom(block: unknown): number | null {
  const rec = asRecord(block);
  const usd = rec?.usd;
  return typeof usd === 'number' && Number.isFinite(usd) ? usd : null;
}

// The live API carries privacy on model_spec, but the published docs
// place it on the entry itself - coerceModel reads spec-first with an
// entry-level fallback so a doc-shaped response still classifies.
// Anything outside the two known values coerces to null (unclassified).
function coercePrivacy(v: unknown): ModelPrivacy | null {
  return v === 'private' || v === 'anonymized' ? v : null;
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
    // Reasoning-capable if Venice reports EITHER flag. supportsReasoning
    // means the model emits a thinking pass; supportsReasoningEffort means
    // it also honors the granular effort knob. A model can have the first
    // without the second (qwen-3-7-plus), and the picker is still useful
    // for it (Off -> disable_thinking; the effort levels are accepted on
    // the wire). Requiring supportsReasoningEffort alone wrongly disabled
    // the reasoning picker for those models. See the CatalogModel docblock.
    supportsReasoning:
      caps.supportsReasoning === true || caps.supportsReasoningEffort === true,
    supportsFunctionCalling: caps.supportsFunctionCalling === true,
    supportsResponseFormat: caps.supportsResponseSchema === true,
    inputUsdPerM: usdFrom(pricing?.input),
    outputUsdPerM: usdFrom(pricing?.output),
    deprecated: asRecord(spec.deprecation)?.date != null,
    privacy: coercePrivacy(spec.privacy ?? entry.privacy),
    supportsE2EE: caps.supportsE2EE === true,
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
