/**
 * Grocery-domain row types: store sections and list items. Re-exported
 * through `../../supabase.ts` so consumers keep importing from
 * `$lib/supabase`.
 */

/**
 * A grocery-store section (aisle) the user shops by. Free-form and
 * user-ordered. The permanent "Other" section is NOT a row - items
 * with `section_id = null` render in a fixed Other pseudo-section
 * pinned last, which is what makes Other undeletable and unrenamable.
 */
export interface GrocerySection {
  id: string;
  name: string;
  /** Display order, lower first. Dense from 0; rewritten whole on reorder. */
  position: number;
  created_at: string;
}

/**
 * One grocery-list item. `needed = true` rows are the active shopping
 * list; `needed = false` rows are the acquired history (greyed-out
 * collapsed section + the add-input's suggestion corpus). Rows are
 * kept when bought, not deleted, so the history accumulates.
 *
 * `count` and `unit` are free-form text on purpose - recipe
 * quantities arrive verbatim from cooklang ("1/2", "2-3") and units
 * include things like "package" and "loaf".
 */
export interface GroceryItem {
  id: string;
  name: string;
  count: string | null;
  unit: string | null;
  note: string | null;
  /** Null = the permanent "Other" pseudo-section. */
  section_id: string | null;
  needed: boolean;
  /**
   * Source recipe for checkbox-added items; null for manual adds.
   * Rows with a recipe_id are wholesale-deleted when the recipe's
   * cooklang changes (see clear_grocery_items_on_recipe_change in
   * schema.sql) or when the recipe is deleted (FK cascade).
   */
  recipe_id: string | null;
  /** Optional product photo; id into grocery_item_images. */
  image_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A grocery item joined with its display decorations: the source
 * recipe's title (when linked) and a short-lived signed URL for the
 * product photo (when present). What the list panes render.
 */
export interface GroceryItemView extends GroceryItem {
  recipe_title: string | null;
  /** Signed bucket URL for the photo, or null when the item has none. */
  image_url: string | null;
}

/**
 * Patch shape for updateGroceryItem. Absent field = leave unchanged;
 * explicit null = clear. `name` cannot be cleared, only replaced.
 */
export interface GroceryItemPatch {
  name?: string;
  count?: string | null;
  unit?: string | null;
  note?: string | null;
  section_id?: string | null;
  image_id?: string | null;
}
