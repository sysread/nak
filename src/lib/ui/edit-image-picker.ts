/**
 * UI-behavior primitives for the Settings AI-pane image-EDIT picker.
 * Edit-tool twin of image-model-picker.ts, over the inpaint catalog
 * (src/lib/models/edit-image-catalog.ts). Same option shape so the
 * ImageModelSelect component renders both pickers unchanged - the edit
 * picker's rows add the privacy badge (the same glyphs the text pickers'
 * privacyChip uses: lock = private, mask = anonymized) since a tool that
 * ships the user's own photos to a third-party proxy is worth flagging.
 */

import type { EditCatalogModel } from '../models/edit-image-catalog';
import type { ImageModelOption } from './image-model-picker';
import { DEFAULT_EDIT_IMAGE_MODEL } from '../models';

/**
 * Format a model's per-edit price for the pill. Three decimals reads
 * cleanly across the typical $0.02 - $0.10 range; "/edit" distinguishes
 * the pill from the generation picker's "/image".
 */
export function formatEditPrice(usdPerEdit: number): string {
  return `$${usdPerEdit.toFixed(3)}/edit`;
}

/** Status badges for a catalog row: privacy tier, beta, retirement. */
function badgesFor(model: EditCatalogModel): string[] {
  const badges: string[] = [];
  // Same glyph semantics as privacyChip in model-picker.ts: lock =
  // private-served, performing-arts mask = proxied-and-anonymized.
  badges.push(model.privacy === 'private' ? '\u{1F512} Private' : '\u{1F3AD} Anonymized');
  if (model.beta) badges.push('beta');
  if (model.deprecated) badges.push('retiring');
  return badges;
}

/** The structured option for one catalog row. Exported for unit tests. */
export function editModelOption(model: EditCatalogModel): ImageModelOption {
  return {
    id: model.id,
    name: model.name,
    priceLabel: formatEditPrice(model.usdPerEdit),
    badges: badgesFor(model),
  };
}

/**
 * Build the dropdown options from the live catalog and the currently-
 * selected id. When the current id isn't in the catalog (Venice retired
 * it, the cap filter dropped it, or the catalog hasn't loaded yet), a
 * synthetic option is prepended so the picker shows the real current
 * value rather than appearing to select nothing.
 */
export function buildEditModelOptions(
  catalog: readonly EditCatalogModel[],
  currentId: string
): ImageModelOption[] {
  const options = catalog.map(editModelOption);
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

/** Display name for a model id, falling back to the bare id when the
 *  catalog has no row for it (retired model, catalog not loaded yet). */
export function editImageModelLabel(
  catalog: readonly EditCatalogModel[],
  id: string
): string {
  return catalog.find((m) => m.id === id)?.name ?? id;
}

/**
 * The value to persist for a picked edit model. Picking the built-in
 * default clears the override (stored as absence) so the settings blob
 * stays compact and "default" reads as unset; any other id is stored
 * as-is. Inverse of the `override ?? DEFAULT_EDIT_IMAGE_MODEL` fallback
 * the picker's selected value uses.
 */
export function editImageModelOverrideFor(pickedId: string): string | undefined {
  return pickedId === DEFAULT_EDIT_IMAGE_MODEL ? undefined : pickedId;
}
