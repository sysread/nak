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
import type { GroceryProductView, GrocerySection } from '../supabase';

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
  items: GroceryProductView[];
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
  items: readonly GroceryProductView[]
): GrocerySectionGroup[] {
  const byId = new Map<string, GroceryProductView[]>();
  const other: GroceryProductView[] = [];
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
  const alphabetical = (list: GroceryProductView[]): GroceryProductView[] =>
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
 * Narrow the section groups to what the panel renders: empty cards
 * are hidden unless the user opts in via the "Show empty sections"
 * toggle (the full store layout is mostly noise on a short list, but
 * seeing every aisle helps when filing items into sections). The
 * Other card survives either way when it has items - it is the
 * intake tray.
 */
export function filterSectionGroups(
  groups: readonly GrocerySectionGroup[],
  showEmpty: boolean
): GrocerySectionGroup[] {
  return groups.filter((g) => showEmpty || g.items.length > 0);
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
 * Separator between the parts of an item's detail line. U+00B7 MIDDLE
 * DOT rather than a comma or hyphen - at the muted 0.72rem size it
 * reads as a divider instead of as punctuation belonging to the note
 * text on either side of it.
 */
const DETAIL_SEPARATOR = ' \u00b7 ';

/**
 * The muted detail line rendered UNDER an item's name: quantity,
 * free-form note, and source recipe title, in that order. Null when
 * the item carries none of the three, so the caller renders nothing
 * rather than an empty line.
 *
 * The recipe title is dropped when the note is exactly the
 * `"For <title>"` string the Cookbook ingredient checkbox writes -
 * that note already names the recipe, and printing both stutters
 * ("For Chili . Chili").
 *
 * These three parts share one line because the item NAME owns the
 * line above it: a long name has to wrap in full rather than get
 * clipped by details competing for the same row.
 */
export function itemDetailLine(item: {
  count: string | null;
  unit: string | null;
  note: string | null;
  recipe_title: string | null;
}): string | null {
  const note = item.note?.trim() ?? '';
  const recipe = item.recipe_title?.trim() ?? '';
  const parts = [
    itemQuantityLabel(item) ?? '',
    note,
    note === `For ${recipe}` ? '' : recipe,
  ].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(DETAIL_SEPARATOR) : null;
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
 * of a suggestion (which would revive its product) or of a product
 * already on the list (which would double it up).
 */
export function canCreateGroceryItem(
  query: string,
  suggestions: readonly GroceryProductView[],
  onList: readonly GroceryProductView[]
): boolean {
  const key = normalizeGroceryName(query);
  if (key.length === 0) return false;
  return ![...suggestions, ...onList].some(
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

// Shopping trips ----------------------------------------------------------

/**
 * Copy shown in the In-cart section while no trip is underway.
 */
export const CART_IDLE_MESSAGE =
  'Items appear in this list as you mark them off of your shopping ' +
  'list. You must click "Start Shopping" to enable this feature.';

/**
 * Whether a shopping trip is active: a trip started at `startedAt`
 * lives until local midnight - it is active only while `now` falls on
 * the SAME local calendar day. Comparing calendar days (rather than a
 * 24h window) is what makes the trip expire at midnight in the user's
 * timezone with no cleanup write: the stale timestamp simply reads as
 * inactive the next morning.
 */
export function isShoppingTripActive(
  startedAt: string | undefined,
  now: Date
): boolean {
  if (!startedAt) return false;
  const started = new Date(startedAt);
  if (Number.isNaN(started.getTime())) return false;
  if (started > now) return false;
  return (
    started.getFullYear() === now.getFullYear() &&
    started.getMonth() === now.getMonth() &&
    started.getDate() === now.getDate()
  );
}

/**
 * Split the acquired window for an active trip: products whose
 * current entry was PURCHASED since the trip started are "in the
 * cart"; everything older stays plain history. `acquired_at` is the
 * entry's purchase stamp, so an unrelated product edit can never
 * fake a row into the cart. With no active trip the cart is empty
 * and the history is untouched - the caller renders the idle message
 * instead. Rows with no acquired_at (never bought) cannot appear in
 * the acquired window by construction; they fall to history
 * defensively.
 */
export function splitAcquiredForTrip(
  acquired: readonly GroceryProductView[],
  startedAt: string | undefined,
  active: boolean
): { cart: GroceryProductView[]; history: GroceryProductView[] } {
  if (!active || !startedAt) return { cart: [], history: [...acquired] };
  const startMs = Date.parse(startedAt);
  const cart: GroceryProductView[] = [];
  const history: GroceryProductView[] = [];
  for (const item of acquired) {
    const boughtMs = item.acquired_at ? Date.parse(item.acquired_at) : NaN;
    (boughtMs >= startMs ? cart : history).push(item);
  }
  return { cart, history };
}

/** Label for the trip toggle button. */
export function shoppingToggleLabel(active: boolean): string {
  return active ? 'Finish shopping' : 'Start shopping';
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
 * Map the status filter to listGroceryProductsPage's `onList`
 * argument (undefined = no filter).
 */
export function browseOnListArg(filter: GroceryStatusFilter): boolean | undefined {
  if (filter === 'needed') return true;
  if (filter === 'acquired') return false;
  return undefined;
}

/** Section-filter select sentinels: all sections / the Other bucket. */
export const BROWSE_SECTION_ALL = '';
export const BROWSE_SECTION_OTHER = '__other';

/**
 * Map the section-filter select value to listGroceryProductsPage's
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
  items: GroceryProductView[];
}

/**
 * Split the loaded browse window by provenance: "Staples" are
 * standalone products (no recipe link - the things the user buys
 * as a matter of course), "Ingredients" came from recipe checkboxes.
 * Empty groups are dropped; each group keeps the window's order.
 * Client-side over the loaded window on purpose - the two groups
 * share one paged query, so rows join their group as pages load
 * rather than each group paging separately.
 */
export function splitBrowseRows(
  rows: readonly GroceryProductView[]
): GroceryBrowseGroup[] {
  const staples: GroceryProductView[] = [];
  const ingredients: GroceryProductView[] = [];
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

/**
 * Which edge of the hovered row the section-reorder insertion line
 * belongs on. Mirrors sectionOrderAfterDrag's landing spot: dragging
 * DOWN the list inserts after the hovered row (line on its bottom
 * edge), dragging UP inserts before it (line on top). Null for a
 * self-hover or unknown ids - no line.
 */
export function sectionDropEdge(
  ids: readonly string[],
  fromId: string,
  toId: string
): 'top' | 'bottom' | null {
  if (fromId === toId) return null;
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from === -1 || to === -1) return null;
  return from < to ? 'bottom' : 'top';
}

// Recipe bridge ---------------------------------------------------------

/** A recipe ingredient's matching catalog product, for the checkbox sync. */
export interface RecipeCheckboxItem {
  /** The product's id - the revival / un-plan target. */
  id: string;
  /** The product's on-list flag - what the checkbox displays. */
  onList: boolean;
}

/**
 * Map a recipe's parsed ingredients to the recipe's catalog products
 * (by normalized name) for the detail pane's checkbox sync. The
 * products are already recipe-scoped (fetched by recipe_id), so name
 * matching within them is effectively (recipe_id, name) identity.
 * The checkbox displays the matched product's `on_list` flag - "is
 * this on my list right now" - so removing or buying it on the list
 * side unchecks it here, and re-checking revives the existing
 * product (keeping its learned section) rather than inserting a
 * duplicate. Duplicate ingredient names collapse onto the same
 * product, and unmatched products (e.g. one renamed after checking)
 * are simply unmatched - they still belong to the recipe and are
 * still dropped when their name no longer parses from the source.
 */
export function recipeCheckboxItemIds(
  ingredients: readonly Ingredient[],
  recipeItems: readonly { id: string; name: string; on_list: boolean }[]
): Map<string, RecipeCheckboxItem> {
  const byName = new Map<string, RecipeCheckboxItem>();
  // An on-list product wins on a name collision (the checkbox should
  // read checked if ANY matching product is on the list); otherwise
  // first one wins. Collisions are rare - products are recipe-scoped.
  for (const item of recipeItems) {
    const key = normalizeGroceryName(item.name);
    const prior = byName.get(key);
    if (!prior || (!prior.onList && item.on_list)) {
      byName.set(key, { id: item.id, onList: item.on_list });
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
 * Plan the "add all ingredients" batch: which existing products to
 * revive (present but off the list) and which ingredients need a
 * fresh product, deduped by normalized name so a recipe that
 * mentions @butter twice adds it once. Already-on-list products are
 * skipped - the batch is idempotent, so mashing the button is
 * harmless.
 */
export function partitionIngredientsForAdd(
  ingredients: readonly Ingredient[],
  entries: ReadonlyMap<string, RecipeCheckboxItem>
): { reviveIds: string[]; create: Ingredient[] } {
  const reviveIds: string[] = [];
  const create: Ingredient[] = [];
  const seen = new Set<string>();
  for (const ing of ingredients) {
    const key = normalizeGroceryName(ing.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = entries.get(key);
    if (entry === undefined) create.push(ing);
    else if (!entry.onList) reviveIds.push(entry.id);
  }
  return { reviveIds, create };
}

/**
 * Build the createGroceryProduct payload for a checked recipe
 * ingredient: name and cooklang quantity/unit verbatim (free-form
 * text by design; the quantity lands on the product's open entry),
 * a note naming the source recipe, and the recipe link that scopes
 * the product to the invalidation trigger. Section is left null
 * (unfiled) - the shopper files it later if they care.
 */
export function groceryProductFromIngredient(
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
