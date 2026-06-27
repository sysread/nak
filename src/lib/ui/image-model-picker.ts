/**
 * UI-behavior primitives for the Settings AI-pane image-generation
 * picker. Pure functions over the Venice image catalog
 * (src/lib/models/image-catalog.ts): the structured option list the
 * ImageModelSelect component renders, and the per-image price label.
 * Kept out of the .svelte file per the frontend-organization split - a
 * port to another framework would rewrite none of this.
 *
 * Simpler than the text tier picker (src/lib/ui/model-picker.ts): image
 * generation has no reasoning level, no per-tier slots, and only a
 * handful of models. Each option carries its parts separately - name,
 * price, badges - so the component can left-align the name and right-
 * align the price in a pill rather than cramming everything into one
 * text run the way a native <option> would force.
 */

import type { ImageCatalogModel } from '../models/image-catalog';

/** One entry in the image-model dropdown, parts kept separate for layout. */
export interface ImageModelOption {
  readonly id: string;
  /** Left-aligned model name (or the bare id for an off-catalog current pick). */
  readonly name: string;
  /**
   * Right-aligned price-pill text, e.g. "$0.010/image". Null when Venice
   * omits pricing, the model is resolution-tiered, or this is the
   * synthetic current row - the component collapses the pill rather than
   * drawing an empty capsule or a misleading "$0.00".
   */
  readonly priceLabel: string | null;
  /** Small status tags shown next to the name, e.g. ['beta', 'retiring']. */
  readonly badges: readonly string[];
}

/**
 * Format a model's per-image price for the pill. Three decimals reads
 * cleanly across the typical $0.005 - $0.05 range. Takes a non-null
 * number; the caller maps null pricing to a collapsed pill (priceLabel
 * null) rather than a "price n/a" string.
 */
export function formatImagePrice(usdPerImage: number): string {
  return `$${usdPerImage.toFixed(3)}/image`;
}

/** Status badges for a catalog row: beta gating and pending retirement. */
function badgesFor(model: ImageCatalogModel): string[] {
  const badges: string[] = [];
  if (model.beta) badges.push('beta');
  if (model.deprecated) badges.push('retiring');
  return badges;
}

/** The structured option for one catalog row. Exported for unit tests. */
export function imageModelOption(model: ImageCatalogModel): ImageModelOption {
  return {
    id: model.id,
    name: model.name,
    priceLabel: model.usdPerImage === null ? null : formatImagePrice(model.usdPerImage),
    badges: badgesFor(model),
  };
}

/**
 * Build the dropdown options from the live catalog and the currently-
 * selected id. When the current id isn't in the catalog (Venice retired
 * it, the default that the image filter happened to drop, or the catalog
 * hasn't loaded yet), a synthetic option is prepended so the picker shows
 * the real current value rather than appearing to select nothing. The
 * synthetic row carries just the id and a 'current' badge - there's no
 * catalog row to source a name or price from.
 */
export function buildImageModelOptions(
  catalog: readonly ImageCatalogModel[],
  currentId: string
): ImageModelOption[] {
  const options = catalog.map(imageModelOption);
  if (!catalog.some((m) => m.id === currentId)) {
    options.unshift({
      id: currentId,
      name: currentId,
      priceLabel: null,
      badges: ['current'],
    });
  }
  return options;
}
