/**
 * Grocery-domain row types: store sections, catalog products, and
 * list entries. Re-exported through `../../supabase.ts` so consumers
 * keep importing from `$lib/supabase`.
 *
 * The domain is split in two (see the grocery block in
 * supabase/schema.sql): `grocery_products` is the durable catalog -
 * one row per product VARIANT, unique by label plus details, living
 * forever - and `grocery_list_entries` is list membership as events:
 * an open entry (acquired_at null) means "on the list now", a closed
 * one records a purchase.
 */

/**
 * A grocery-store section (aisle) the user shops by. Free-form and
 * user-ordered. The permanent "Other" section is NOT a row - products
 * with `section_id = null` render in a fixed Other pseudo-section,
 * which is what makes Other undeletable and unrenamable.
 */
export interface GrocerySection {
  id: string;
  name: string;
  /** Display order, lower first. Dense from 0; rewritten whole on reorder. */
  position: number;
  created_at: string;
}

/** Who decided a product's section. Null = unfiled. */
export type GrocerySectionSource = 'user' | 'auto';

/**
 * One catalog product variant. Carries everything that makes a
 * variant itself: name, note, section, photo, source recipe. Rows
 * are durable - buying and un-planning touch entries, never this
 * table - so the learned section survives all list churn.
 */
export interface GroceryProduct {
  id: string;
  name: string;
  note: string | null;
  /** Null = the permanent "Other" pseudo-section (or unfiled; see source). */
  section_id: string | null;
  /**
   * 'user' = section chosen in the UI (authoritative; nothing
   * overwrites it), 'auto' = filed by the auto-sectioning agent,
   * null = unfiled. Disambiguates a null section_id: 'user' + null
   * is "deliberately in Other", null + null is "not yet classified".
   */
  section_source: GrocerySectionSource | null;
  /**
   * Source recipe for checkbox-added products; null for standalone.
   * Recipe products are deleted when their name no longer parses out
   * of the recipe's cooklang (see
   * clear_stale_grocery_products_on_recipe_change in schema.sql) or
   * when the recipe is deleted (FK cascade).
   */
  recipe_id: string | null;
  /** Optional product photo; id into grocery_item_images. */
  image_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A row of the `grocery_products_view` read model: the product
 * flattened with its CURRENT entry (open when on the list, else the
 * latest purchase), the recipe title, and a short-lived signed URL
 * for the photo. What every list surface renders.
 *
 * `count` and `unit` are the current entry's quantity - free-form
 * text on purpose, since recipe quantities arrive verbatim from
 * cooklang ("1/2", "2-3") and units include "package" and "loaf".
 */
export interface GroceryProductView extends GroceryProduct {
  recipe_title: string | null;
  /** Signed bucket URL for the photo, or null when the product has none. */
  image_url: string | null;
  /**
   * The current entry, or null for a product with no entries at all
   * (a recipe ingredient that was un-planned).
   */
  entry_id: string | null;
  count: string | null;
  unit: string | null;
  /** The current entry's purchase time; null while it is open. */
  acquired_at: string | null;
  /** True when an open entry exists - "on the list right now". */
  on_list: boolean;
}

/**
 * Patch shape for updateGroceryProduct. Absent field = leave
 * unchanged; explicit null = clear. `name` cannot be cleared, only
 * replaced. Setting `section_id` (including to null = Other) stamps
 * `section_source = 'user'` in the data layer - a user edit is
 * always authoritative.
 */
export interface GroceryProductPatch {
  name?: string;
  note?: string | null;
  section_id?: string | null;
  image_id?: string | null;
}

/**
 * Patch shape for updateGroceryListEntry - quantity only. Entry
 * timestamps are owned by the open/acquire verbs, never patched.
 */
export interface GroceryEntryPatch {
  count?: string | null;
  unit?: string | null;
}
