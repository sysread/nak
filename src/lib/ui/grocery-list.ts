/**
 * Pure UI-behavior primitives for the grocery list: the drawer tab's
 * section grouping, quantity labels, add-input suggestion decisions,
 * the acquired-history disclosure copy, the drag-reorder next-state
 * computation, and the recipe-bridge helpers the Cookbook detail
 * pane's ingredient checkboxes share with the list (name
 * normalization, checkbox-state mapping, checkbox-to-item payload).
 *
 * No Svelte imports on purpose - everything here is framework-
 * agnostic and unit-tested at tests/grocery-list.test.ts. The
 * composition + DOM glue lives in
 * src/components/GroceryList.svelte and the checkbox delegation in
 * src/screens/Cookbook.svelte.
 */
import type { Ingredient } from '../cooklang';
import type { GroceryItemView, GrocerySection } from '../supabase';

/**
 * Debounce for the add-to-list suggestion search. Matches the sibling
 * sidebars' SEARCH_DEBOUNCE_MS - long enough to skip intermediate
 * keystrokes, short enough to feel immediate.
 */
export const GROCERY_SEARCH_DEBOUNCE_MS = 200;

/** Suggestion dropdown cap - a phone-height list, not a result page. */
export const GROCERY_SUGGESTION_LIMIT = 8;

/**
 * Acquired-history page size. The history grows one row per item per
 * shopping trip forever, so it is always windowed; a page covers a
 * typical trip or two.
 */
export const ACQUIRED_PAGE_SIZE = 30;

/**
 * Sentinel `<select>` value for the permanent "Other" pseudo-section
 * (section_id = null). An empty string rather than null because HTML
 * select option values are always strings.
 */
export const OTHER_SECTION_VALUE = '';

/** Display name of the null-section pseudo-bucket. */
export const OTHER_SECTION_LABEL = 'Other';

/**
 * Dedup/equality key for item names: case-insensitive, trimmed. Used
 * everywhere two names are compared (suggestion dedup, the recipe
 * checkbox state sync, the create-vs-reuse decision) so "Eggs " and
 * "eggs" are one item.
 */
export function normalizeGroceryName(name: string): string {
  return name.trim().toLowerCase();
}

/** One rendered section group: a header plus its items. */
export interface GrocerySectionGroup {
  /** Null for the "Other" pseudo-section. */
  id: string | null;
  name: string;
  items: GroceryItemView[];
}

/**
 * Group the needed items by section for rendering: the null-section
 * "Other" bucket pinned FIRST (it is the intake tray - fresh adds
 * and recipe checkboxes land there until filed, and burying it at
 * the tail hid exactly the items most recently touched), then the
 * user's sections in their order. EVERY
 * section appears, including empty ones (and Other) - the panel
 * renders one card per section, and an aisle the user walks past
 * should show up even when nothing is filed under it. Items sort
 * alphabetically by name within a group - the shopper scans an aisle
 * card like an index, and recency order would shuffle it on every
 * toggle. (Safe client-side: the needed list is complete in memory,
 * unlike the paged surfaces.) Items pointing at a
 * section id that no longer exists (a mid-refresh delete) fall back
 * to Other rather than vanishing.
 */
export function groupItemsBySection(
  sections: readonly GrocerySection[],
  items: readonly GroceryItemView[]
): GrocerySectionGroup[] {
  const byId = new Map<string, GroceryItemView[]>();
  const other: GroceryItemView[] = [];
  const known = new Set(sections.map((s) => s.id));
  for (const item of items) {
    if (item.section_id !== null && known.has(item.section_id)) {
      const list = byId.get(item.section_id);
      if (list) list.push(item);
      else byId.set(item.section_id, [item]);
    } else {
      other.push(item);
    }
  }
  const alphabetical = (list: GroceryItemView[]): GroceryItemView[] =>
    list.sort((a, b) => a.name.localeCompare(b.name));
  const groups: GrocerySectionGroup[] = [
    { id: null, name: OTHER_SECTION_LABEL, items: alphabetical(other) },
    ...sections.map((s) => ({
      id: s.id,
      name: s.name,
      items: alphabetical(byId.get(s.id) ?? []),
    })),
  ];
  return groups;
}

/**
 * Compact quantity string for an item row: "2 lb", "1/2", "loaf", or
 * null when the item carries neither a count nor a unit (render
 * nothing rather than an empty chip).
 */
export function itemQuantityLabel(item: {
  count: string | null;
  unit: string | null;
}): string | null {
  const parts = [item.count, item.unit]
    .map((p) => p?.trim() ?? '')
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * Disclosure-header copy for the collapsed acquired-history section.
 * `hasMore` marks the count as a lower bound ("30+") because only a
 * window of the history is loaded.
 */
export function acquiredHeaderLabel(count: number, hasMore: boolean): string {
  const n = hasMore ? `${count}+` : `${count}`;
  return `Acquired (${n})`;
}

/**
 * Whether the add-input should offer a "create new item" action for
 * the typed text: non-empty, and not a duplicate (by normalized name)
 * of a suggestion (which would reuse its row) or of an item already
 * on the needed list (which would double it up).
 */
export function canCreateGroceryItem(
  query: string,
  suggestions: readonly GroceryItemView[],
  needed: readonly GroceryItemView[]
): boolean {
  const key = normalizeGroceryName(query);
  if (key.length === 0) return false;
  return ![...suggestions, ...needed].some(
    (i) => normalizeGroceryName(i.name) === key
  );
}

/**
 * Next section-id order after dragging section `fromId` onto section
 * `toId`: `fromId` is removed and re-inserted at `toId`'s position.
 * Returns null for a no-op (same slot, unknown ids) so the caller can
 * skip the reorder round trip.
 */
export function sectionOrderAfterDrag(
  ids: readonly string[],
  fromId: string,
  toId: string
): string[] | null {
  if (fromId === toId) return null;
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from === -1 || to === -1) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, fromId);
  return next;
}

// All-items browse (the sidebar) -----------------------------------------

/** Sidebar browse page size. Windowed - the corpus grows unboundedly. */
export const GROCERY_BROWSE_PAGE_SIZE = 40;

/** Status filter for the sidebar's all-items browse. */
export type GroceryStatusFilter = 'all' | 'needed' | 'acquired';

export const GROCERY_STATUS_FILTER_OPTIONS: ReadonlyArray<{
  value: GroceryStatusFilter;
  label: string;
}> = [
  { value: 'all', label: 'All' },
  { value: 'needed', label: 'On list' },
  { value: 'acquired', label: 'Acquired' },
];

/**
 * Map the status filter to listGroceryItemsPage's `needed` argument
 * (undefined = no filter).
 */
export function browseNeededArg(filter: GroceryStatusFilter): boolean | undefined {
  if (filter === 'needed') return true;
  if (filter === 'acquired') return false;
  return undefined;
}

/** Section-filter select sentinels: all sections / the Other bucket. */
export const BROWSE_SECTION_ALL = '';
export const BROWSE_SECTION_OTHER = '__other';

/**
 * Map the section-filter select value to listGroceryItemsPage's
 * `sectionId` argument (undefined = no filter, 'other' = null-section
 * bucket, anything else = a section id).
 */
export function browseSectionArg(selected: string): string | 'other' | undefined {
  if (selected === BROWSE_SECTION_ALL) return undefined;
  if (selected === BROWSE_SECTION_OTHER) return 'other';
  return selected;
}

/** One provenance group in the sidebar browse. */
export interface GroceryBrowseGroup {
  key: 'staples' | 'ingredients';
  label: string;
  items: GroceryItemView[];
}

/**
 * Split the loaded browse window by provenance: "Staples" are
 * manually-entered items (no recipe link - the things the user buys
 * as a matter of course), "Ingredients" came from recipe checkboxes.
 * Empty groups are dropped; each group keeps the window's recency
 * order. Client-side over the loaded window on purpose - the two
 * groups share one paged query, so rows join their group as pages
 * load rather than each group paging separately.
 */
export function splitBrowseRows(
  rows: readonly GroceryItemView[]
): GroceryBrowseGroup[] {
  const staples: GroceryItemView[] = [];
  const ingredients: GroceryItemView[] = [];
  for (const row of rows) {
    (row.recipe_id === null ? staples : ingredients).push(row);
  }
  const groups: GroceryBrowseGroup[] = [];
  if (staples.length > 0) {
    groups.push({ key: 'staples', label: 'Staples', items: staples });
  }
  if (ingredients.length > 0) {
    groups.push({ key: 'ingredients', label: 'Ingredients', items: ingredients });
  }
  return groups;
}

/**
 * The sidebar listing area's render decision, mirroring the recipe
 * sidebar's computeListView shape: one tagged union so the template
 * is a switch, not a predicate pile.
 */
export type GroceryBrowseView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty'; reason: 'no-items-yet' | 'no-matches' }
  | { kind: 'list' };

export function computeBrowseView(args: {
  loading: boolean;
  error: string | null;
  count: number;
  filtered: boolean;
}): GroceryBrowseView {
  if (args.error) return { kind: 'error', message: args.error };
  if (args.loading && args.count === 0) return { kind: 'loading' };
  if (args.count === 0) {
    return { kind: 'empty', reason: args.filtered ? 'no-matches' : 'no-items-yet' };
  }
  return { kind: 'list' };
}

// Recipe bridge ---------------------------------------------------------

/** A recipe ingredient's matching grocery row, for the checkbox sync. */
export interface RecipeCheckboxItem {
  id: string;
  /** The row's on-list flag - what the checkbox displays. */
  needed: boolean;
}

/**
 * Map a recipe's parsed ingredients to their grocery-item rows (by
 * normalized name) for the detail pane's checkbox sync. The checkbox
 * displays the matched row's `needed` flag - "is this on my list
 * right now" - so removing or buying the item on the list side
 * unchecks it here, and re-checking revives the existing row rather
 * than inserting a duplicate. Duplicate ingredient names collapse
 * onto the same row, and unmatched rows (e.g. an item renamed after
 * checking) are simply unmatched - they still belong to the recipe
 * and still get wiped on a recipe edit.
 */
export function recipeCheckboxItemIds(
  ingredients: readonly Ingredient[],
  recipeItems: readonly { id: string; name: string; needed: boolean }[]
): Map<string, RecipeCheckboxItem> {
  const byName = new Map<string, RecipeCheckboxItem>();
  // A needed row wins on a name collision (the checkbox should read
  // checked if ANY matching row is on the list); otherwise first row
  // wins. Collisions are rare - rows are recipe-scoped.
  for (const item of recipeItems) {
    const key = normalizeGroceryName(item.name);
    const prior = byName.get(key);
    if (!prior || (!prior.needed && item.needed)) {
      byName.set(key, { id: item.id, needed: item.needed });
    }
  }
  const out = new Map<string, RecipeCheckboxItem>();
  for (const ing of ingredients) {
    const key = normalizeGroceryName(ing.name);
    const entry = byName.get(key);
    if (entry !== undefined) out.set(key, entry);
  }
  return out;
}

/**
 * Build the createGroceryItem payload for a checked recipe
 * ingredient: name and cooklang quantity/unit verbatim (free-form
 * text by design), a note naming the source recipe, and the recipe
 * link that scopes the row to the invalidation trigger. Section is
 * left null (Other) - the shopper files it later if they care.
 */
export function groceryItemFromIngredient(
  ingredient: Ingredient,
  recipe: { id: string; title: string }
): {
  name: string;
  count: string | null;
  unit: string | null;
  note: string;
  recipe_id: string;
} {
  return {
    name: ingredient.name,
    count: ingredient.qty,
    unit: ingredient.unit,
    note: `For ${recipe.title}`,
    recipe_id: recipe.id,
  };
}
