/**
 * UI-behavior primitives for the Settings AI-pane image-generation
 * picker. Pure functions over the Venice image catalog
 * (src/lib/models/image-catalog.ts): option-list assembly and the
 * per-image price label. Kept out of Settings.svelte per the frontend-
 * organization split - a port to another framework would rewrite none of
 * this.
 *
 * Simpler than the text tier picker (src/lib/ui/model-picker.ts): image
 * generation has no reasoning level, no per-tier slots, and only a
 * handful of models, so this drives a plain <select> rather than the
 * fuzzy-search combobox. The one "interesting feature" surfaced per row
 * is the per-image price - the number a user actually weighs when picking
 * a backend - with beta / retiring as trailing badges.
 */

import type { ImageCatalogModel } from '../models/image-catalog';

/** One entry in the image-model dropdown. */
export interface ImageModelOption {
  readonly id: string;
  /** Display label: name + price, plus beta / retiring badges. */
  readonly label: string;
}

/**
 * Format a model's per-image price for the option label. Three decimals
 * reads cleanly across the typical $0.005 - $0.05 range; null pricing
 * (Venice omits the block, or the model is resolution-tiered) reads
 * "price n/a", honest rather than a misleading $0.00.
 */
export function formatImagePrice(usdPerImage: number | null): string {
  if (usdPerImage === null) return 'price n/a';
  return `$${usdPerImage.toFixed(3)}/image`;
}

/**
 * The display label for one catalog row: name, price, then any badges.
 * Exported for the synthetic-current case and unit tests.
 */
export function imageModelLabel(model: ImageCatalogModel): string {
  const badges: string[] = [];
  if (model.beta) badges.push('beta');
  if (model.deprecated) badges.push('retiring');
  const badgeText = badges.length > 0 ? ` (${badges.join(', ')})` : '';
  return `${model.name} - ${formatImagePrice(model.usdPerImage)}${badgeText}`;
}

/**
 * Build the dropdown options from the live catalog and the currently-
 * selected id. When the current id isn't in the catalog (Venice retired
 * it, or it's the default that the image catalog filter happened to drop,
 * or the catalog hasn't loaded yet), a synthetic option is prepended so
 * the select shows the real current value rather than silently snapping
 * to the first catalog entry. The synthetic label is just the id since
 * there's no catalog row to enrich it.
 */
export function buildImageModelOptions(
  catalog: readonly ImageCatalogModel[],
  currentId: string
): ImageModelOption[] {
  const options: ImageModelOption[] = catalog.map((m) => ({
    id: m.id,
    label: imageModelLabel(m),
  }));
  if (!catalog.some((m) => m.id === currentId)) {
    options.unshift({ id: currentId, label: `${currentId} (current)` });
  }
  return options;
}
