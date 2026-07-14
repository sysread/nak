# Grocery list

A section-organized shopping list on the Groceries drawer tab (above
Recipes), fed two ways: per-ingredient checkboxes on every recipe's
detail pane in the Cookbook, and manual adds. Two surfaces, matching the other tabs' "list in drawer,
content in panel" split:

- the **sidebar** (`GroceryList.svelte`) is the all-items browse - a
  windowed, infinite-scrolled catalog of every item ever added, with
  a debounced name search plus status (All / On list / Acquired) and
  section filters. Its one verb is the checkbox: checked = on the
  current list; toggling flips `needed`, which is how a past
  purchase gets restocked. An unmatched search offers an Add action.
- the **main panel** (`src/screens/Groceries.svelte`) is the working
  surface: the current list as one card per store section (section
  name as the card title, items one per row; every section renders
  even when empty, Other pinned last), the add-input with
  acquired-history suggestions, the collapsed acquired history, the
  inline item editor (name / count / unit / note / section / photo /
  delete), and section management. Full-width, which is what a
  phone at the store sees once the drawer closes.

Shipped from the plan at
[`plans/grocery-list-plan.md`](./plans/grocery-list-plan.md); this doc
owns current reality.

## Files

- `src/lib/supabase/grocery.ts` - the data-layer domain slice:
  sections (list / create / rename / delete / reorder RPC /
  first-run seed), items (needed list, acquired-history page,
  acquired search, CRUD, needed-flag toggle, per-recipe rows), and
  the product-photo upload + `grocery_item_image_upsert` pair.
  Facade methods on `SupabaseService` delegate one-for-one.
- `src/lib/supabase/types/grocery.ts` - `GrocerySection`,
  `GroceryItem`, `GroceryItemView` (item + recipe title + signed
  photo URL), `GroceryItemPatch`.
- `src/lib/grocery-store.svelte.ts` - module-level `$state`:
  `sections`, the complete `needed` array, the windowed `acquired`
  array (+ `acquiredHasMore` / `loadMoreAcquired`), `loadGroceries`.
- `src/lib/grocery-events.ts` - the rune-free event bus
  (`nak:grocery:changed`): `emitGroceryChange` / `onGroceryChange`.
  Mirrors `cookbook-events.ts`.
- `src/lib/ui/grocery-list.ts` - pure UI-behavior primitives:
  section grouping (`groupItemsBySection`, Other pinned last),
  quantity labels, the add-input create-vs-reuse decision
  (`canCreateGroceryItem`), the acquired disclosure copy, the DnD
  next-order computation (`sectionOrderAfterDrag`), the sidebar
  browse helpers (status/section filter mapping + the
  `computeBrowseView` render decision), name
  normalization, and the recipe-bridge helpers
  (`recipeCheckboxItemIds`, `groceryItemFromIngredient`). Tested at
  `tests/grocery-list.test.ts`.
- `src/components/GroceryList.svelte` - the sidebar all-items
  browse: debounced search, status + section filters (mapped to the
  service pager via `browseNeededArg` / `browseSectionArg`), a
  windowed listing with an infinite-scroll sentinel
  (`listGroceryItemsPage`), per-row needed toggles, and the
  unmatched-search Add action.
- `src/screens/Groceries.svelte` - the main-panel shopping list:
  add-input with debounced acquired-history suggestions, the needed
  panes grouped by section, the collapsed acquired history, the
  inline item editor (name / count / unit / note / section / photo /
  delete), and the Sections manage mode (add / rename / delete /
  native-DnD reorder).
- `src/screens/Cookbook.svelte` - the recipe side of the bridge:
  `recipeToHtml(..., { ingredientCheckboxes })` on the live detail
  view, the delegated `onchange` handler on the render container,
  the checked-state sync effect, and the per-recipe grocery-row
  fetch.
- `src/lib/cooklang.ts` - `RecipeHtmlOptions.ingredientCheckboxes`:
  prefixes ingredient `<li>`s with
  `<input class="cook-buy" data-ing="<raw name>">`. The renderer
  stays grocery-unaware - it stamps names, never checked state.
- `src/screens/Chat.svelte` - the Groceries tab (nav row, lazy
  component load, top-bar label, main-panel hint) and the realtime
  relay (`subscribeToGroceryChanges` -> `emitGroceryChange`).
- `supabase/functions/grocery-image-gc/index.ts` - the photo orphan
  sweep; reuses the recipe sweep's table-agnostic drain driver
  (`_shared/recipe-image-gc.ts`) with grocery RPCs/bucket injected.

## Data model

All in `supabase/schema.sql` under "grocery_sections /
grocery_items":

- `grocery_sections`: `id`, `user_id`, `name`, `position` (dense
  from 0), `created_at`. Self-* RLS. The permanent "Other" section
  is NOT a row - items with `section_id is null` render in a fixed
  Other pseudo-section pinned last, which makes Other undeletable /
  unrenamable by construction, and section deletion is
  `on delete set null` (items fall back to Other). Canned starter
  sections seed lazily client-side
  (`seedGrocerySectionsIfEmpty`) - per-user rows need an auth
  context the sync script doesn't have. Reorder is the
  `grocery_sections_reorder` RPC: the id array must be a
  permutation of the caller's whole section set.
- `grocery_items`: `name`, `count text` (free-form - cooklang
  quantities like "1/2" / "2-3" ride verbatim), `unit text`
  (free-form: "package", "loaf"), `note`, `section_id` (null =
  Other), `needed boolean` (true = to buy; false = acquired
  history), `recipe_id` (null = manual add; FK
  `on delete cascade`), `image_id` (nullable FK to
  `grocery_item_images`, `on delete set null`), timestamps. Self-*
  RLS. Rows are kept when bought (needed flips false), never
  deleted by shopping - the history is the add-input's suggestion
  corpus.
- `grocery_item_images` + the private `grocery-item-images` bucket:
  a direct clone of the `recipe_images` content-addressed pattern
  (`<user_id>/<sha256>`, unique `(user_id, sha256)`, immutable
  rows, signed-URL reads). At most one photo per item via
  `grocery_items.image_id`; no link table. See
  [`./file-storage.md`](./file-storage.md).
- Realtime: both tables are `supabase_realtime` publication members
  with `(id, user_id)` replica-identity indexes (DELETE delivery -
  same gotcha as recipes).

## The recipe bridge

- Checkboxes render on EVERY recipe's live detail view. They were
  originally gated on the upcoming / favorite bookmarks, but a
  recipe's items outlive its bookmark (un-bookmarking leaves the
  list alone by design), and the gate left those surviving items
  with no recipe-side management surface.
- Ingredients have no stable identity (they are parsed out of the
  cooklang source at read time), so everything keys on the
  normalized (trimmed, lowercased) ingredient NAME:
  `recipeCheckboxItemIds` maps parsed ingredients to grocery rows,
  the sync effect sets `checked` per input's `data-ing`, and the
  delegated handler resolves clicks back to an ingredient.
- A checkbox mirrors its matched row's `needed` flag - "is this on
  my list right now". Removing or buying the item on the list side
  unchecks it on the recipe; re-checking revives the existing row
  (setGroceryItemNeeded) instead of inserting a duplicate.
  Unchecking in the recipe view deletes the row outright. (The
  original design showed row EXISTENCE instead, so a store purchase
  didn't "un-plan" the recipe - real use found that reading
  surprising, so the semantics were flipped.)
- Checking inserts a row carrying the cooklang qty/unit verbatim, a
  `"For <title>"` note, `recipe_id`, `needed = true`, section null.
- **Invalidation**: the `clear_grocery_items_on_recipe_change`
  trigger (AFTER UPDATE on `recipes`, only when `cooklang` is
  distinct) deletes every `grocery_items` row with that
  `recipe_id`. Wholesale on purpose - after an edit there is no way
  to know which items still correspond to real ingredients. A
  trigger rather than client cleanup so every write path (modal,
  server-dispatched `recipe_update` tool, revert) is covered.
  Bookmark / rating / title changes don't touch `cooklang` and
  leave the list alone. Recipe DELETE is the FK cascade, not the
  trigger.

## Refresh model

Local UI writes call `loadGroceries` directly (via the component's
`mutate` wrapper). Server-originated writes - the invalidation
trigger's bulk delete, a Cookbook checkbox click reaching an open
Groceries tab, another device - arrive through the
`subscribeToGroceryChanges` relay in Chat.svelte, which fires the
`nak:grocery:changed` CustomEvent; the panel (`Groceries.svelte`),
the sidebar browse window, and the Cookbook detail pane's row fetch
all subscribe. The sidebar's own toggle/add writes also emit the
event directly - one nudge refreshes every grocery surface, and the
realtime echo that follows is an idempotent no-op. The Cookbook
checkbox handler also emits the event directly after its write so a
same-client Groceries tab updates without waiting on the realtime
echo (the echo is a harmless idempotent refetch).

## GC

`grocery-image-gc` edge function + `nak-grocery-image-gc` cron
(every 6h, offset from the recipe sweep): deletes
`grocery_item_images` rows no `grocery_items.image_id` references,
then their bucket objects. Backed by
`list_orphan_grocery_item_images` / `delete_orphan_grocery_item_images`
(the delete re-checks still-orphaned). Removing a photo in the item
editor just nulls `image_id`; the sweep reclaims the bytes later.
Deployed via its own line in `deploy.yml`.

## Interactions

- **Cookbook** (`./cookbook.md`) - the bridge above; the
  invalidation trigger couples to every `recipes.cooklang` writer
  (`recipe_update_with_version` and any direct update). The
  cookbook's "no shopping-list logic" scoping is retired.
- **Chat** (`./chat.md`) - hosts the drawer tab, the lazy component
  load, and the realtime relay.
- **File storage** (`./file-storage.md`) - the fourth private
  bucket + its GC sweep.
- **Routing** - `drawer=groceries` joins the DrawerTab union in
  `routing.svelte.ts`.
- **LLM tools** - none, deliberately. The list is user-driven UI;
  the schema and service layer are tool-ready if a `groceries`
  toolbox ever earns its keep.

## Gotchas

- **`count` is text, not numeric.** Recipe quantities arrive
  verbatim from cooklang; a numeric column would mangle "1/2" and
  "2-3". Don't add arithmetic (quantity merging) without changing
  the representation.
- **Name normalization is the only ingredient identity.** Renaming
  a checkbox-added item in the list breaks its match with the
  recipe checkbox (the box shows unchecked again); the row still
  belongs to the recipe and still gets wiped on a recipe edit.
  Accepted trade - see the plan doc for the rationale.
- **The acquired history is never fetched whole.** It grows one row
  per item per trip forever; every read is a recency window
  (`ACQUIRED_PAGE_SIZE`). Keep it that way.
- **Seeding is client-side and racy by a round trip.** Two tabs
  racing the first load can in principle double-seed the canned
  sections; the count re-check narrows the window and a double
  seed is cosmetic (duplicate names, user-deletable). Not worth a
  server-side lock.
- **The grocery function reuses the recipe GC driver.** The drain
  loop in `_shared/recipe-image-gc.ts` is table-agnostic; changing
  its semantics changes BOTH sweeps.
