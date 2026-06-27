/**
 * UI-behavior primitives for the Settings AI-pane model picker. Pure
 * functions over the Venice catalog (src/lib/models/catalog.ts) and the
 * persisted per-tier snapshot (TierModelConfig in src/lib/models): option
 * list assembly, capability-to-chip mapping, context/price formatting,
 * and the catalog-to-snapshot transform. Kept out of Settings.svelte per
 * the frontend-organization split - a port to another framework would
 * rewrite none of this.
 */

import type { CatalogModel } from '../models/catalog';
import {
  DEFAULT_REASONING_EFFORT,
  effectiveTierSpec,
  type ModelTier,
  type ThinkingLevel,
  type TierModelConfig,
  type TierModels,
  type TierSpec,
} from '../models';

/** One entry in the model dropdown. */
export interface ModelOption {
  readonly id: string;
  /** Display label - the catalog name, or the snapshot label for an off-catalog current pick. */
  readonly label: string;
  /** The catalog row, or null for a synthetic "current selection" not in the live catalog. */
  readonly model: CatalogModel | null;
  readonly deprecated: boolean;
}

/**
 * Build the dropdown options for a tier, given the live catalog and the
 * currently-selected model. When the current model isn't in the catalog
 * (Venice retired it, or it's a curated id the catalog filter dropped), a
 * synthetic option is prepended so the select still shows the real
 * current value rather than silently snapping to the first catalog entry.
 */
export function buildModelOptions(
  catalog: readonly CatalogModel[],
  current: { id: string; label: string } | null
): ModelOption[] {
  const options: ModelOption[] = catalog.map((m) => ({
    id: m.id,
    label: m.name,
    model: m,
    deprecated: m.deprecated,
  }));
  if (current && !catalog.some((m) => m.id === current.id)) {
    options.unshift({
      id: current.id,
      label: `${current.label} (current)`,
      model: null,
      deprecated: false,
    });
  }
  return options;
}

/** The capability surface a chip row reads - satisfied by CatalogModel and TierSpec alike. */
export interface CapabilitySource {
  readonly supportsVision: boolean;
  readonly supportsReasoning: boolean;
  readonly supportsFunctionCalling?: boolean;
}

export interface CapabilityChip {
  readonly icon: string;
  readonly label: string;
}

/**
 * Capability chips for a model: one per supported feature. Icons carry a
 * U+FE0F variation selector where the base glyph would otherwise render
 * as a thin monochrome text form that vanishes against the pane
 * background (same reasoning as the Balanced tier's yin-yang choice in
 * ./models). Returns an empty array when the model supports none of the
 * tracked features - the caller renders nothing rather than an empty row.
 */
export function capabilityChips(source: CapabilitySource): CapabilityChip[] {
  const chips: CapabilityChip[] = [];
  if (source.supportsReasoning) {
    chips.push({ icon: '\u{1F9E0}', label: 'Reasoning' });
  }
  if (source.supportsVision) {
    // U+1F441 EYE + U+FE0F emoji presentation.
    chips.push({ icon: '\u{1F441}️', label: 'Vision' });
  }
  if (source.supportsFunctionCalling) {
    // U+1F527 WRENCH - already emoji-default, no selector needed.
    chips.push({ icon: '\u{1F527}', label: 'Tools' });
  }
  return chips;
}

/**
 * Format a context window for the chip strip: "1M", "1.5M", "256k". Whole
 * millions drop the decimal; sub-million rounds to the nearest thousand.
 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    const text = Number.isInteger(millions) ? String(millions) : millions.toFixed(1);
    return `${text}M`;
  }
  return `${Math.round(tokens / 1000)}k`;
}

function formatUsd(perMillion: number): string {
  // Two decimals reads cleanly for the typical $0.10 - $15.00 range;
  // sub-cent models round to $0.00, which is honest enough for a
  // rough cost indicator (the Usage pane carries the precise spend).
  return `$${perMillion.toFixed(2)}`;
}

/**
 * Format a model's per-1M-token pricing for the chip strip. Venice omits
 * the pricing block on free / internal models, so a fully-absent pair
 * reads "Pricing n/a"; a half-present pair shows the side it has.
 */
export function formatPricing(model: {
  inputUsdPerM: number | null;
  outputUsdPerM: number | null;
}): string {
  const { inputUsdPerM, outputUsdPerM } = model;
  if (inputUsdPerM === null && outputUsdPerM === null) return 'Pricing n/a';
  const inPart = inputUsdPerM === null ? '?' : formatUsd(inputUsdPerM);
  const outPart = outputUsdPerM === null ? '?' : formatUsd(outputUsdPerM);
  return `${inPart} in / ${outPart} out per 1M`;
}

/**
 * Snapshot a catalog model + chosen reasoning level into the persisted
 * TierModelConfig. This is the capture point referenced in
 * TierModelConfig's docblock: the catalog's capability fields are frozen
 * here so chat resolution reads them back without the async catalog.
 */
export function tierConfigFromCatalog(
  model: CatalogModel,
  thinking: ThinkingLevel
): TierModelConfig {
  return {
    modelId: model.id,
    thinking,
    contextWindow: model.contextWindow,
    supportsReasoning: model.supportsReasoning,
    supportsVision: model.supportsVision,
    supportsResponseFormat: model.supportsResponseFormat,
    label: model.name,
  };
}

/**
 * Snapshot a TierSpec (the effective current spec for a tier) + chosen
 * reasoning level into a TierModelConfig. Used when the user changes only
 * the reasoning level on a tier whose model isn't a live catalog row, so
 * the existing capabilities carry forward unchanged. Label falls back to
 * the model id since a bare TierSpec has no friendly catalog name.
 */
export function tierConfigFromSpec(
  spec: TierSpec,
  thinking: ThinkingLevel,
  label?: string
): TierModelConfig {
  return {
    modelId: spec.id,
    thinking,
    contextWindow: spec.contextWindow,
    supportsReasoning: spec.supportsReasoning,
    supportsVision: spec.supportsVision,
    supportsResponseFormat: spec.supportsResponseFormat,
    label: label ?? spec.id,
  };
}

/**
 * The note shown under the tier pickers when the project price cap hides
 * some live-catalog models, or null when nothing is hidden (the caller
 * renders nothing). Count-to-noun pluralization kept out of the template
 * per the frontend-organization split.
 */
export function priceCapHiddenNote(hiddenCount: number): string | null {
  if (hiddenCount <= 0) return null;
  const noun = hiddenCount === 1 ? 'model is' : 'models are';
  return `${hiddenCount} ${noun} hidden by this instance's price cap.`;
}

/** Everything one tier's row in the Settings picker needs to render. */
export interface TierRowView {
  /** Effective spec - built-in default folded with any user override. */
  readonly spec: TierSpec;
  /** The tier's default reasoning level (the picker's selected value). */
  readonly thinking: ThinkingLevel;
  /** Dropdown options, with the current pick guaranteed present. */
  readonly options: ModelOption[];
  /** Capability chips for the selected model. */
  readonly chips: CapabilityChip[];
  /** Pre-formatted context window, e.g. "1M". */
  readonly contextLabel: string;
  /** Pre-formatted price, e.g. "$0.30 in / $1.20 out per 1M". */
  readonly priceLabel: string;
  /** True when the tier carries a user override (enables the Reset affordance). */
  readonly overridden: boolean;
}

/**
 * Assemble the view-model for one tier row from the effective spec, the
 * persisted overrides, and the live catalog. Capability chips, context,
 * and price prefer the live catalog row for the selected model (richer +
 * carries pricing); they fall back to the effective spec's snapshotted
 * capabilities when the model isn't a live catalog entry (retired, or a
 * curated id the catalog filter dropped), in which case price is "n/a"
 * because the snapshot doesn't carry pricing.
 */
export function tierRowView(
  tier: ModelTier,
  tierModels: TierModels,
  catalog: readonly CatalogModel[]
): TierRowView {
  const spec = effectiveTierSpec(tier, tierModels);
  const override = tierModels[tier];
  const selected = catalog.find((m) => m.id === spec.id) ?? null;
  const label = override?.label ?? selected?.name ?? spec.id;
  return {
    spec,
    thinking: spec.defaultThinking ?? DEFAULT_REASONING_EFFORT,
    options: buildModelOptions(catalog, { id: spec.id, label }),
    chips: capabilityChips(selected ?? spec),
    contextLabel: formatContextWindow(spec.contextWindow),
    priceLabel: selected ? formatPricing(selected) : 'Pricing n/a',
    overridden: override != null,
  };
}

/**
 * Fuzzy subsequence score of `query` against `text`, or null when the
 * query's characters don't appear in order. Higher is a better match.
 * Pure scoring heuristic, not a ranking standard - it just has to order
 * a few dozen model names sensibly in the combobox:
 *
 *   - every query char must appear in order (subsequence) or it's a miss;
 *   - contiguous runs score higher than scattered hits ("gpt4" beats
 *     "g...p...t...4");
 *   - a char landing at a word boundary (start, after a space/hyphen)
 *     scores higher, so "v4" favors "DeepSeek-V4" over "...v...4...";
 *   - longer texts get a mild penalty so a tight short match outranks the
 *     same letters buried in a longer name.
 *
 * Case-insensitive. An empty query scores 0 (matches everything), which
 * `filterModelOptions` short-circuits before calling this.
 */
export function fuzzyMatch(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at === -1) return null;
    score += at === prev + 1 ? 2 : 1;
    const before = at === 0 ? ' ' : t[at - 1];
    if (before === ' ' || before === '-') score += 3;
    prev = at;
    from = at + 1;
  }
  return score - text.length * 0.01;
}

/**
 * Filter + rank model options against a fuzzy query, matching on the
 * display label and (for live catalog rows) the model id, so "qwen-3-7"
 * finds it by id even though the label reads "Qwen 3.7 Plus". An empty
 * query returns the options untouched (preserving the caller's order).
 * Stable best-score-first ordering; original order breaks ties.
 */
export function filterModelOptions(
  options: readonly ModelOption[],
  query: string
): ModelOption[] {
  if (query.trim().length === 0) return [...options];
  const scored: { opt: ModelOption; score: number; order: number }[] = [];
  options.forEach((opt, order) => {
    const labelScore = fuzzyMatch(query, opt.label);
    const idScore = opt.model ? fuzzyMatch(query, opt.id) : null;
    const best = Math.max(labelScore ?? -Infinity, idScore ?? -Infinity);
    if (best > -Infinity) scored.push({ opt, score: best, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map((s) => s.opt);
}
