# Grocery List Implementation Plan

Status: LANDED - kept for the design rationale. The living
reference is [`../grocery-list.md`](../grocery-list.md); where the
implementation diverged from this plan, that doc wins. Notable
divergences: all four milestones shipped in one change rather than
separately, and the grocery-image GC reuses the recipe sweep's
table-agnostic drain driver instead of cloning it.

Read [`../cookbook.md`](../cookbook.md) first; this plan assumes its
data model, tool/relay vocabulary, and the file-storage conventions
in [`../file-storage.md`](../file-storage.md).

## SYNOPSIS

A grocery list that integrates with the cookbook: ingredient
checkboxes on bookmarked recipes feed a section-organized,
phone-friendly shopping list rendered as a new drawer tab above
Recipes.

## PURPOSE

Currently the cookbook is deliberately a staging area with "no
shopping-list logic" - the user exports plain text to AnyList and
manages the actual shopping externally. That round-trip loses the
recipe link, offers no in-app shopping flow, and forces a second app
at the store. This plan brings the shopping list in-house: recipes
marked `upcoming` or `favorite` grow per-ingredient checkboxes that
push items onto a grocery list; the list itself is a standalone,
user-editable store organized by grocery-store section, designed to
be driven one-handed from a phone in the aisle.

Adopting this plan retires the cookbook doc's "intentionally narrow:
no shopping-list logic" claim - update that paragraph when M2 lands.

## DESCRIPTION

### How the relevant code behaves today

- **Recipes** live in `public.recipes` with `cooklang text` as the
  source of truth; ingredients are derived at read time by
  `parseCooklang` and rendered to an HTML string by `recipeToHtml`
  (`src/lib/cooklang.ts`), which the Cookbook detail pane injects
  into a bound container (`detailRenderEl`). Ingredients are NOT
  discrete rows - there is nothing stable to foreign-key against.
- **Bookmark flags** (`upcoming`, `favorite`) are direct-update
  workflow state; the drawer's RecipeList renders complete bucket
  arrays for both.
- **Every content mutation** funnels through the
  `recipe_update_with_version` RPC (modal edits, LLM `recipe_update`,
  revert), so a server-side trigger on `recipes` sees all write
  paths uniformly.
- **Photos** follow the `recipe_images` pattern: a metadata table
  unique on `(user_id, sha256)`, bytes in a private content-addressed
  bucket at `<user_id>/<sha256>`, signed-URL reads, and an idempotent
  edge-function GC sweep (`recipe-image-gc`) for orphans.
- **The drawer** (`Chat.svelte`) has a `.sidebar-nav` tablist (Chats
  / Recipes / ...) with per-tab lazy-loading list components
  (`RecipeList.svelte` + pure primitives in
  `src/lib/ui/recipe-list.ts`), debounced search, and a
  `postgres_changes` realtime relay per table that fires a `window`
  CustomEvent to refresh the open tab.
- **Drag-and-drop** already exists in `Settings.svelte` and
  `WikiRecords.svelte` (native `draggable` + `dragstart`/`ondrop`
  handlers); section reorder reuses that pattern rather than adding a
  dependency.

### What this plan adds

#### Data model (`supabase/schema.sql`, all idempotent)

- `public.grocery_sections`:
  - `id uuid`, `user_id uuid`, `name text not null`,
    `position int not null`, `created_at`.
  - Self-* RLS (select / insert / update / delete), same shape as
    `recipes`.
  - The permanent "Other" section is NOT a row. Items with
    `section_id is null` render in a fixed "Other" pseudo-section
    pinned last. This makes "Other" undeletable/unrenamable for free
    and lets section deletion be `on delete set null` - the section's
    items fall back to Other instead of vanishing.
  - Canned starter sections (Produce, Bread, Deli, Meats, Dairy,
    Frozen, Snacks, Pantry, Beverages, Household) are seeded lazily
    by the client the first time the grocery store loads and finds
    zero section rows - not in schema.sql, because per-user rows need
    an auth context the sync script doesn't have. The seed is
    guarded ("insert only if count is still 0" re-check) so two tabs
    racing don't double-seed.
- `public.grocery_items`:
  - `id uuid`, `user_id uuid`, `name text not null`,
    `count text` (freeform, nullable - cooklang quantities are
    freeform strings like `1/2` or `2-3`, and a numeric column would
    mangle them on the checkbox->item path),
    `unit text` (freeform, nullable - "package", "loaf"),
    `note text` (nullable),
    `image_id uuid` (nullable FK to `grocery_item_images`,
    `on delete set null`),
    `section_id uuid` (nullable FK to `grocery_sections`,
    `on delete set null`; null = Other),
    `needed boolean not null default true` (true = still to buy;
    false = acquired / historical),
    `recipe_id uuid` (nullable FK to `recipes`,
    `on delete cascade`; null = manually added),
    `created_at`, `updated_at`.
  - Indexes: `(user_id, needed)` for the two list panes;
    `(recipe_id)` for the invalidation delete and the recipe-detail
    checkbox-state query; a `(id, user_id)` replident index (twin of
    `recipes_replident_idx`) so realtime DELETE events replicate -
    see the cookbook doc's replica-identity gotcha.
  - Self-* RLS, four policies.
- `public.grocery_item_images`: direct clone of `recipe_images`
  (`id`, `user_id`, `sha256`, `mime_type`, `size_bytes`,
  `storage_path`, unique `(user_id, sha256)`, immutable rows, self
  select/insert/delete RLS).
- **Bucket** `grocery-item-images`: private, content-addressed
  `<user_id>/<sha256>`, three self-folder `storage.objects` policies.
  Its own bucket per the file-storage convention of one bucket per
  byte store.
- **Invalidation trigger** `clear_grocery_items_on_recipe_change`:
  AFTER UPDATE on `recipes`, fires only when `cooklang` is distinct
  from the old value, deletes all `grocery_items` where
  `recipe_id = new.id`. Rationale: ingredients are embedded in the
  cooklang markup, not discrete rows, so after an edit there is no
  way to know which list items still correspond to real ingredients -
  wholesale invalidation is the only honest answer. A trigger (rather
  than client-side cleanup) covers every write path: the modal, the
  LLM `recipe_update` tool dispatched server-side in the venice
  function, and revert. Bookmark toggles and rating changes don't
  touch `cooklang`, so they don't nuke the list. Recipe deletion is
  covered by the FK cascade, not the trigger.

#### Service layer (`src/lib/supabase.ts`)

New types (`GrocerySection`, `GroceryItem`, `GroceryItemImage`) and
methods following the recipe block's shape:

- sections: `listGrocerySections`, `createGrocerySection`,
  `renameGrocerySection`, `deleteGrocerySection`,
  `reorderGrocerySections` (single RPC writing the whole position
  array, matching the photo-reorder pattern), plus the lazy seed.
- items: `listGroceryItems({needed})`, `createGroceryItem`,
  `updateGroceryItem`, `deleteGroceryItem`,
  `setGroceryItemNeeded(id, needed)`,
  `searchAcquiredGroceryItems(query, limit)` (ILIKE on `name` where
  `needed = false`, distinct-on-name, newest first - the add-input's
  suggestion source),
  `listGroceryItemsForRecipe(recipeId)` (drives the recipe-detail
  checkbox state).
- photos: `upsertGroceryItemImage` + signed-URL resolution inside
  the item list read, mirroring `upsertRecipeImage` /
  `listRecipePhotos`.
- realtime: `subscribeToGroceryChanges` - one user-scoped
  `postgres_changes` subscription covering `grocery_items` and
  `grocery_sections`, relayed through a `nak:grocery:changed`
  CustomEvent exactly like the recipes relay, so a checkbox click in
  the Cookbook modal refreshes an open Groceries tab (and a second
  device at the store stays live).

#### Store (`src/lib/grocery-store.svelte.ts`)

Module-level `$state` mirroring `cookbook-store.svelte.ts`: the
`sections` array (user order), the `needed` items array (complete -
an active shopping list is small), the `acquired` items window
(capped fetch, newest N, with a load-more path - this set "will grow
enormously over time" so it must never be fetched whole), loading
flags, and a `loadGroceries` refresh wired to the change event.

#### UI

- **Drawer tab** (`Chat.svelte`): a "Groceries" row inserted in the
  `.sidebar-nav` tablist directly ABOVE the Recipes row. Lazy-loads
  like the Recipes tab. No modal counterpart in v1 - the list IS the
  feature; item editing happens inline in the drawer.
- **`src/components/GroceryList.svelte`** + primitives in
  **`src/lib/ui/grocery-list.ts`** (tested at
  `tests/grocery-list.test.ts`). The component is composition-only;
  every decision below that isn't Svelte plumbing lives in the
  primitives module:
  - **Add-to-list input** at the top: debounced (reuse the
    `SEARCH_DEBOUNCE_MS` convention) suggestion dropdown over
    `searchAcquiredGroceryItems`. Picking a suggestion flips that
    row's `needed` back to true (reuse, preserving its section /
    photo / note); submitting an unmatched name creates a fresh
    manual item in Other.
  - **Needed pane**: items grouped by section in the user's section
    order, Other pinned last, empty sections hidden. Each item shows
    a CHECKED checkbox (inverted from the recipe view - the shopper
    unchecks as they buy), name, count + unit, note, recipe title
    when linked, and a photo thumbnail that opens the signed-URL
    image.
  - **Uncheck** = `setGroceryItemNeeded(id, false)`: the item moves
    to the acquired pane. Re-checking an acquired item moves it back.
  - **Acquired pane**: greyed-out, collapsed by default behind a
    disclosure header with a count; renders the windowed newest-N
    with a "show more" tail.
  - **Item edit**: inline expand (or small popover) for name / count
    / unit / note / section picker / photo pick-replace-remove /
    delete. Photo pick funnels through the same client-side
    compress-then-sha256 pipeline as recipe photos.
  - **Section management**: sections render as draggable group
    headers (native DnD per the Settings / WikiRecords pattern);
    drop order persists via `reorderGrocerySections`. Header
    affordances for rename and delete, plus an "add section" row.
    Other has no affordances.
- **Recipe-detail ingredient checkboxes** (`Cookbook.svelte` +
  `src/lib/cooklang.ts`): `recipeToHtml` grows an opts parameter
  (`{ ingredientCheckboxes?: boolean }`) that prefixes each
  ingredient `<li>` with `<input type="checkbox"
  data-ing="<normalized name>">`. The detail pane enables it only
  when the recipe is `upcoming` or `favorite`. Because the render is
  an HTML string, interaction is a delegated click handler on
  `detailRenderEl`, and checked-state is synced after mount from
  `listGroceryItemsForRecipe` by matching normalized ingredient
  names (lowercased, trimmed) - there is no stable ingredient id, by
  construction. Checking inserts a grocery item carrying the
  cooklang quantity/unit verbatim, `recipe_id`, a note naming the
  recipe ("For <title>"), `needed = true`, section null. The
  checkbox reads as checked whenever a matching item row EXISTS for
  the recipe, regardless of `needed` - buying the item at the store
  should not silently re-open the recipe checkbox. Unchecking in the
  recipe view deletes the row.
  - The plain-text / markdown exports and the TOC are untouched -
    checkboxes are a detail-pane render option only.

#### GC sweep

`grocery-image-gc` edge function + cron entry: a direct clone of
`recipe-image-gc` with a simpler orphan predicate (an image row is
orphaned when no `grocery_items.image_id` references it - single
nullable FK, no link table). Backed by
`list_orphan_grocery_item_images` / `delete_orphan_grocery_item_images`
RPCs with the same "re-check still-orphaned" delete guard; deployed
via its own line in `deploy.yml`; drain loop unit-tested offline in
`supabase/functions/_shared/`.

#### Docs and QA (same PRs as the code)

- `docs/dev/grocery-list.md` - the permanent feature doc, with
  Interactions naming Cookbook, Chat, File storage, and this
  trigger's coupling to `recipe_update_with_version`.
- `docs/user/` - a grocery-list page linked from the manual index,
  updated per milestone.
- `docs/qa/use-cases/` - a walkthrough covering: bookmark a recipe,
  check ingredients on, shop the list (uncheck), edit the recipe and
  confirm the wipe, re-add from the acquired-history search, section
  reorder, photo attach.
- Cookbook doc updates: retire the "no shopping-list logic" framing;
  add the trigger to its Interactions ledger.

### How that fixes PURPOSE

The **checkbox bridge** turns bookmarked recipes into the list's
intake without giving ingredients an identity they don't have - the
**invalidation trigger** keeps the derived list honest against the
cooklang source of truth by construction, at every write path. The
**needed flag plus acquired history** makes one table serve both the
live shopping trip and the "I buy this often" suggestion corpus. The
**section rows plus null-means-Other** give free-form, reorderable
store layout with a guaranteed default and no special-case rows.

## Milestones

Each lands independently green (gate + knip + docs + QA):

1. **M1 - list core**: schema (sections + items, no images), service
   methods, store, drawer tab, manual add/edit/delete, needed toggle,
   needed/acquired panes, add-input search, realtime relay, seed.
2. **M2 - recipe bridge**: `recipeToHtml` checkbox option, detail-
   pane delegation + state sync, item insert/delete from the recipe
   view, invalidation trigger, FK cascade. Cookbook doc updates.
3. **M3 - sections management**: DnD reorder, add/rename/delete,
   reorder RPC.
4. **M4 - photos**: `grocery_item_images` table, bucket, upload plus
   signed-URL read, item-edit photo controls, `grocery-image-gc`
   sweep + cron + deploy wiring.

## Scoped out (deliberately)

- **LLM tools** (`grocery_add` / `grocery_list` / ...): the spec is
  user-driven UI. The schema and service layer are tool-ready if the
  model later earns a `groceries` toolbox; adding tools is a
  follow-up, not part of these milestones.
- **Offline cache**: shopping happens on a phone in a store with bad
  signal, so offline mirroring (per `offline-cache.md`) is the
  obvious next step - but it is its own milestone with its own
  reconcile design. Flagged, not planned here.
- **Quantity merging** ("2 recipes both need onions -> one row with
  summed count"): counts are freeform text, so arithmetic is
  ill-defined. Duplicate names across recipes stay separate rows,
  each carrying its recipe note.

## Open questions (resolved defaults, flag if wrong)

1. `count` as freeform text (not numeric) - chosen so cooklang
   quantities survive verbatim; costs +/- stepper affordances.
2. Recipe checkbox reflects row EXISTENCE, not `needed` - buying an
   item does not visually re-open it on the recipe. The alternative
   (track `needed`) makes a shopping trip appear to "un-plan" the
   recipe.
3. Acquired-history dedup is by exact normalized name only; no
   fuzzy/embedding search on the add input in v1.
