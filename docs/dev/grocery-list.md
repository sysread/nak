# Grocery list

A section-organized shopping list on the Groceries drawer tab (above
Recipes), fed two ways: per-ingredient checkboxes on every recipe's
detail pane in the Cookbook, and manual adds.

The domain is split into a durable **product catalog**
(`grocery_products` - one row per variant, unique by label PLUS
details, living forever) and **list entries**
(`grocery_list_entries` - membership as events: an open entry means
"on the list now", a closed one records a purchase). The product
rows are the section/note/photo memory; list churn only ever
touches entries. New unfiled products can be **auto-sectioned** by a
small-model sub-completion (see "Auto-sectioning" below).

Two surfaces, matching the other tabs' "list in drawer, content in
panel" split:

- the **sidebar** (`GroceryList.svelte`) is the all-items browse - a
  windowed, infinite-scrolled catalog of every product variant,
  alphabetical by name (ordered server-side so the page seams stay
  honest), with a debounced name search plus status (All / On list /
  Acquired) and section filters. Rows split by provenance: standalone
  "Staples" first, recipe-sourced "Ingredients" below - and the
  Ingredients group is hidden by default behind a "Show recipe
  ingredients" toggle (a server-side `manualOnly` filter, so paging
  stays honest). Its one verb is the checkbox: checked = on the
  current list. Checking revives the product (opens an entry);
  unchecking UN-PLANS (deletes the open entry, records no purchase) -
  the planning surface must never write purchase history. An
  unmatched search offers the `(Other)` / `(Auto)` create pair
  (unfiled vs. background auto-sectioning).
- the **main panel** (`src/screens/Groceries.svelte`) is the working
  surface: the current list as one card per store section (section
  name as the card title, items one per row, alphabetical; Other
  pinned first as the intake tray for unfiled adds; empty cards
  hidden behind a default-off "Show empty sections" toggle), the
  add-input with suggestions over the off-list standalone catalog
  (every same-name variant is its own suggestion with its section
  in grey; picking one revives that product; `Add "X" (Other)`
  always leads the dropdown - it is also the new-variant path and
  the Enter action - with `Add "X" (Auto)` beside it for unmatched
  names), the collapsed acquired history, the inline
  item editor (name / count / unit / note / section / photo /
  delete - name/note/section/photo save to the product, count/unit
  to its current entry), item drag-to-file (an on-list row's handle
  drops onto a section card, saving its section - with an accent
  highlight on the hovered card; the section manager's reorder
  shows an insertion line via `sectionDropEdge`), whole-card
  section reorder (title-bar handles, shown ONLY when "Show empty
  sections" is on - with cards hidden, a drag would silently
  leapfrog invisible sections), and section management. Full-width,
  which is what a phone at the store sees once the drawer closes.
  Both drags work on touch via the Settings custom-prompts
  long-press pattern (hold the grip ~1s, haptic tick, slide,
  release); native HTML5 DnD covers pointer. The editor's section
  picker remains the keyboard path. The panel checkbox's uncheck IS
  a purchase (stamps the open entry's `acquired_at`); its re-check
  opens a fresh entry, leaving the old purchase in the log.

Originally shipped from the plan at
[`plans/grocery-list-plan.md`](./plans/grocery-list-plan.md); this doc
owns current reality.

## Files

- `src/lib/supabase/grocery.ts` - the data-layer domain slice:
  sections (list / create / rename / delete / reorder RPC /
  first-run seed), the `grocery_products_view` read paths (current
  list, acquired-history page, browse pager, suggestion search,
  per-recipe rows), the product + entry writes (create / update /
  delete product; `setProductOnList` / `removeProductFromList` /
  `updateGroceryListEntry`), and the product-photo upload +
  `grocery_item_image_upsert` pair. Facade methods on
  `SupabaseService` delegate one-for-one.
- `src/lib/supabase/types/grocery.ts` - `GrocerySection`,
  `GroceryProduct`, `GroceryProductView` (a view row: product +
  current entry + recipe title + signed photo URL),
  `GroceryProductPatch`, `GroceryEntryPatch`.
- `src/lib/grocery-store.svelte.ts` - module-level `$state`:
  `sections`, the complete `onList` array, the windowed `acquired`
  array (+ `acquiredHasMore` / `loadMoreAcquired`), `loadGroceries`.
- `src/lib/grocery-events.ts` - the rune-free event bus
  (`nak:grocery:changed`): `emitGroceryChange` / `onGroceryChange`.
  Mirrors `cookbook-events.ts`.
- `src/lib/ui/grocery-list.ts` - pure UI-behavior primitives:
  section grouping (`groupItemsBySection`, Other pinned first;
  `filterSectionGroups` for the empty-cards toggle), quantity
  labels, the row detail line (`itemDetailLine` - qty / note /
  recipe title joined for the block under an item's name, shared by
  both list surfaces), the add-input create-vs-revive decision
  (`canCreateGroceryItem`), the acquired disclosure copy, the DnD
  next-state helpers (`sectionOrderAfterDrag` + the `sectionDropEdge`
  insertion-line decision), the shopping-trip helpers
  (`isShoppingTripActive`, `splitAcquiredForTrip`,
  `CART_IDLE_MESSAGE`, `shoppingToggleLabel`), the sidebar browse
  helpers (status/section filter mapping, `splitBrowseRows`
  provenance grouping, the `computeBrowseView` render decision),
  name normalization, and the recipe-bridge helpers
  (`recipeCheckboxItemIds`, `groceryProductFromIngredient`,
  `partitionIngredientsForAdd`). Tested at
  `tests/grocery-list.test.ts`, which also carries the JS mirror of
  the invalidation trigger's SQL name-extraction regex.
- `src/lib/grocery-section-agent.ts` - the auto-sectioning
  sub-completion (see "Auto-sectioning" below): prompt assembly and
  answer parsing as pure functions
  (`tests/grocery-section-agent.test.ts`), the `complete()` call on
  the `grocerySection` model slot, and the `autoFileProducts`
  fire-and-forget entry every add path shares.
- `src/components/GroceryList.svelte` - the sidebar all-items
  browse: debounced search, status + section filters (mapped to the
  service pager via `browseOnListArg` / `browseSectionArg`), a
  windowed listing with an infinite-scroll sentinel
  (`listGroceryProductsPage`), the provenance split + recipe-items
  toggle (`splitBrowseRows` / `manualOnly`), per-row list toggles
  (check = revive, uncheck = un-plan), and the unmatched-search Add
  action.
- `src/screens/Groceries.svelte` - the main-panel shopping list:
  add-input with debounced catalog suggestions, the section cards
  (row taps toggle list membership - uncheck is a purchase; the
  pencil opens the inline editor: name / count / unit / note /
  section / photo / delete), the empty-sections toggle, both drags
  (item-to-card filing and whole-card reorder, pointer + long-press
  touch), the Start/Finish shopping trip toggle with the In-cart
  section, the collapsed acquired history, and the Sections manage
  mode (add / rename / delete / DnD reorder).
- `src/screens/Cookbook.svelte` - the recipe side of the bridge:
  `recipeToHtml(..., { ingredientCheckboxes })` on the live detail
  view, the delegated `onchange` handler on the render container,
  the checked-state sync effect, and the per-recipe grocery-row
  fetch.
- `src/lib/cooklang.ts` - `RecipeHtmlOptions.ingredientCheckboxes`:
  wraps each ingredient row in a `<label>` around an
  `<input class="cook-buy" data-ing="<raw name>">` so tapping the
  text toggles the box. The renderer stays grocery-unaware - it
  stamps names, never checked state.
- `src/screens/Chat.svelte` - the Groceries tab (nav row, lazy
  loads for both the sidebar and the panel, top-bar label) and the
  realtime relay (`subscribeToGroceryChanges` -> `emitGroceryChange`).
- `supabase/functions/grocery-image-gc/index.ts` - the photo orphan
  sweep; reuses the recipe sweep's table-agnostic drain driver
  (`_shared/recipe-image-gc.ts`) with grocery RPCs/bucket injected.

## Data model

All in `supabase/schema.sql` under "grocery_sections /
grocery_products / grocery_list_entries":

- `grocery_sections`: `id`, `user_id`, `name`, `position` (dense
  from 0), `created_at`. Self-* RLS. The permanent "Other" section
  is NOT a row - products with `section_id is null` render in a
  fixed Other pseudo-section, which makes Other undeletable /
  unrenamable by construction, and section deletion is
  `on delete set null` (products fall back to Other). Canned starter
  sections seed lazily client-side
  (`seedGrocerySectionsIfEmpty`) - per-user rows need an auth
  context the sync script doesn't have. Reorder is the
  `grocery_sections_reorder` RPC: the id array must be a
  permutation of the caller's whole section set.
- `grocery_products`: the durable catalog. `name`, `note`,
  `section_id` (null = Other or unfiled), `section_source`
  (`'user'` / `'auto'` / null - who decided the section; a user
  edit stamps `'user'` and nothing overwrites it, and null is what
  the future auto-sectioning agent is allowed to fill),
  `recipe_id` (null = standalone; FK `on delete cascade`),
  `image_id` (nullable FK to `grocery_item_images`,
  `on delete set null`), timestamps. Self-* RLS. Rows are unique by
  label PLUS details by design - same-name standalone variants
  coexist ("canned corn" / "fresh corn"), and recipe products are
  effectively unique per `(recipe_id, normalized name)`. Products
  are the section/note/photo memory: buying and un-planning never
  delete them.
- `grocery_list_entries`: list membership as events. `product_id`
  (FK `on delete cascade`), `count` / `unit` text (free-form -
  cooklang quantities like "1/2" / "2-3" ride verbatim; units like
  "package", "loaf"), `added_at`, `acquired_at` (null = on the list
  now; set = purchased then). A partial unique index allows at most
  one OPEN entry per product; the acquired entries are the purchase
  log, one row per buy.
- `grocery_products_view`: the flat read model every client surface
  queries - product columns plus recipe title, photo storage path,
  the CURRENT entry (open if one exists, else the latest purchase),
  and an `on_list` boolean. `security_invoker`, so base-table RLS
  applies. One view instead of per-surface PostgREST embeds keeps
  every filter server-side and the paging honest.
- `grocery_item_images` + the private `grocery-item-images` bucket:
  a direct clone of the `recipe_images` content-addressed pattern
  (`<user_id>/<sha256>`, unique `(user_id, sha256)`, immutable
  rows, signed-URL reads). At most one photo per product via
  `grocery_products.image_id`; no link table. The table and bucket
  keep their historical "item" names - rows are content-addressed
  into the bucket by stored path, and renaming buys nothing. See
  [`./file-storage.md`](./file-storage.md).
- Retired: `grocery_section_prefs`, the pre-split name-keyed sticky
  section memory. Product rows are the memory now, and a name-keyed
  table cannot represent same-name variants (one section per name).
  The schema drops it unconditionally so deployed databases
  converge.
- One-time backfill: schema.sql carries an existence-guarded DO
  block that transforms a pre-split `grocery_items` table into
  products (same ids, `section_source = 'user'` where filed) plus
  one entry each (open for `needed` rows, else stamped with
  `updated_at`), then drops the old table. Fresh installs no-op.
- Realtime: products, entries, and sections are all
  `supabase_realtime` publication members with `(id, user_id)`
  replica-identity indexes (DELETE delivery - same gotcha as
  recipes). Products and entries are separate members because
  either changes alone (a filing touches the product; a buy touches
  the entry).

## The recipe bridge

- Checkboxes render on EVERY recipe's live detail view. They were
  originally gated on the upcoming / favorite bookmarks, but a
  recipe's products outlive its bookmark (un-bookmarking leaves the
  list alone by design), and the gate left those surviving items
  with no recipe-side management surface.
- Ingredients have no stable identity (they are parsed out of the
  cooklang source at read time), so everything keys on the
  normalized (trimmed, lowercased) ingredient NAME within the
  recipe's products - effectively `(recipe_id, name)` identity,
  since the fetch is already scoped by `recipe_id`:
  `recipeCheckboxItemIds` maps parsed ingredients to products, the
  sync effect sets `checked` per input's `data-ing`, and the
  delegated handler resolves clicks back to an ingredient.
- A checkbox mirrors its matched product's `on_list` flag - "is
  this on my list right now". Removing or buying it on the list
  side unchecks it on the recipe; re-checking revives the existing
  product (`setProductOnList`) - keeping its learned section, note,
  and photo - instead of inserting a duplicate. Unchecking in the
  recipe view UN-PLANS: `removeProductFromList` deletes the open
  entry, records no purchase, and leaves the product row as this
  recipe's memory for that ingredient.
- First-time checking creates a product carrying a `"For <title>"`
  note, `recipe_id`, and a null section (unfiled), plus an open
  entry with the cooklang qty/unit verbatim.
- The detail pane also has an "Add all to grocery list" button:
  revives existing off-list products, creates the rest (deduped by
  normalized name via `partitionIngredientsForAdd`), skips products
  already on the list - idempotent by construction. Each ingredient
  row is a `<label>` wrapping its checkbox, so tapping the text
  toggles it via native label semantics (no extra JS).
- **Invalidation**: the
  `clear_stale_grocery_products_on_recipe_change` trigger (AFTER
  UPDATE on `recipes`, only when `cooklang` is distinct) deletes
  the recipe's products whose normalized name no longer parses out
  of the new source - renamed/removed ingredients drop (entries
  cascade), surviving names keep their memory, amount-only edits
  delete nothing. The trigger extracts names with a SQL regex over
  the cooklang `@`-token syntax (a trigger can't call
  `parseCooklang`); it deliberately takes the UNION of tokens
  anywhere in the source rather than the parser's
  declaration-narrowed list - supersets only ever keep more, and a
  kept-but-unlisted product is benign while a wrongly-deleted one
  destroys memory. `tests/grocery-list.test.ts` runs a JS mirror of
  the exact SQL extraction against `parseCooklang` so drift fails
  the gate. A trigger rather than client cleanup so every write
  path (modal, server-dispatched `recipe_update` tool, revert) is
  covered. Bookmark / rating / title changes don't touch `cooklang`
  and leave the list alone. Recipe DELETE is the FK cascade, not
  the trigger.

## Auto-sectioning

`src/lib/grocery-section-agent.ts` files just-created, unfiled
products into the user's own sections via a `grocerySection`
sub-completion (`AGENT_MODELS` -> `z-ai-glm-5-3-flash`;
thinking pass disabled - pure classification, rationale on the slot's docblock in
`src/lib/models/index.ts`). The contract, end to end:

- **Insert first, classify after.** Every add stays instant; the
  agent runs fire-and-forget and the item hops from Other into its
  section when the call returns. Latency shapes only the hop.
- **Prompt**: the user's sections as a numbered list, each with up
  to `SECTION_EXAMPLES_PER_SECTION` example items - standalone
  filed products ONLY (`listSectionExampleProducts`), because
  recipe ingredients are poor evidence without their recipe's
  context - plus, for recipe-originated adds, the recipe title and
  cooklang source (only the recipe disambiguates fresh vs. canned
  vs. frozen "corn"). The model answers a JSON map of name ->
  section number, 0 for "no fit". `response_format: json_object`,
  `temperature 0`, explicit `maxTokens` with headroom, and a
  `finish_reason === 'length'` check per CLAUDE.md "Venice
  sub-completions".
- **Fail closed.** Unparseable answer, truncation, out-of-range
  number, transport error: the product simply stays in Other,
  exactly where it would be without the agent. `autoFileProducts`
  never throws.
- **The save is conditional**: `autoFileGroceryProduct` updates
  `section_id` + `section_source = 'auto'` ONLY where
  `section_source is null`, so a manual filing that lands while the
  call is in flight wins and is never overwritten. User edits stamp
  `'user'`, which the agent never touches - each product is
  classified at most once, ever.
- **Batch, never fan out.** "Add all to grocery list" classifies
  every freshly-created ingredient in ONE call.
- **Who triggers it**: the panel and sidebar `Add "X" (Auto)`
  actions (standalone, no recipe context); the recipe checkbox and
  Add-all paths automatically for first-time ingredients (with
  context). Revived products are never re-classified - their
  section is the memory.
- **In-flight feedback**: the manual paths funnel through
  `autoFileProductsTracked` (grocery-store.svelte.ts), which tracks
  the in-flight product ids in `grocery.classifying` - store-level
  because the add can originate in the sidebar while the row
  renders in the panel - and both surfaces show a small accent ring
  beside the row's name while its id is in the set. The Cookbook
  bridge keeps its own name-keyed variant (its spinner targets the
  rendered checkbox DOM, which renders as a disabled spinning ring
  via `.cook-buy-busy`; a toggle mid-flight would race the
  background save).

Prompt assembly and answer parsing are pure functions tested at
`tests/grocery-section-agent.test.ts`.

## Shopping trips

The "Start shopping" / "Finish shopping" button on the panel toggles
`profiles.settings.groceryShoppingStartedAt` (an ISO timestamp; see
`UserSettings`). While a trip is active, items unchecked from the
list surface in the **In cart** card between the section cards and
the acquired disclosure - membership is derived, not stored:
off-list AND `acquired_at >= trip start` (the panel's uncheck
stamps the open entry's `acquired_at`), split client-side by
`splitAcquiredForTrip`. Because the split keys on the purchase
stamp - not `updated_at` - editing an old item mid-trip can no
longer fake it into the cart (a real gotcha of the pre-split
model). The acquired-history disclosure excludes the cart rows
while a trip is active. A trip is active only while the local
calendar day still matches the start timestamp
(`isShoppingTripActive`), so it expires at midnight in the user's
timezone with no cron or cleanup write - the stale timestamp just
reads as inactive; a minute-tick in the panel re-evaluates so an
open tab crosses midnight too. Idle, the In-cart card shows
`CART_IDLE_MESSAGE`.

## Refresh model

Local UI writes call `loadGroceries` directly (via the component's
`mutate` wrapper). Server-originated writes - the invalidation
trigger's stale-product delete, a Cookbook checkbox click reaching
an open Groceries tab, another device - arrive through the
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
`grocery_item_images` rows no `grocery_products.image_id` references,
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
- **Settings** (`./settings.md`) - the shopping-trip flag
  (`groceryShoppingStartedAt`) rides `profiles.settings` through
  the standard coercer + merge-RPC path; adding trip fields means
  touching `UserSettings`, `coerceSettings`, and the
  `updateSettings` whitelist together.
- **Routing** - `drawer=groceries` joins the DrawerTab union in
  `routing.svelte.ts`.
- **Models** (`src/lib/models/index.ts`) - the `grocerySection`
  slot in `AGENT_MODELS`; retuning the auto-sectioning model means
  editing that slot, not the agent module. The call rides the
  non-streaming `complete()` seam of the venice proxy
  (`src/lib/supabase/venice-proxy.ts`), including its 429 retry
  loop.
- **LLM tools** - none, deliberately. The list is user-driven UI;
  the schema and service layer are tool-ready if a `groceries`
  toolbox ever earns its keep.

## Gotchas

- **`count` is text, not numeric.** Recipe quantities arrive
  verbatim from cooklang; a numeric column would mangle "1/2" and
  "2-3". Don't add arithmetic (quantity merging) without changing
  the representation.
- **Name normalization is the only ingredient identity.** Renaming
  a checkbox-added product in the list breaks its match with the
  recipe checkbox (the box shows unchecked again); the product still
  belongs to the recipe, and because its new name no longer parses
  from the source it is dropped on the next cooklang edit. Accepted
  trade - see the plan docs for the rationale.
- **The two uncheck verbs are different on purpose.** The panel's
  uncheck is a purchase (stamps `acquired_at`); the sidebar's and
  the recipe view's uncheck is an un-plan (deletes the open entry,
  no purchase). Wiring a planning surface to the purchase verb
  pollutes the purchase log with things never bought.
- **The acquired history is never fetched whole.** It grows one row
  per purchase forever; every read is a recency window
  (`ACQUIRED_PAGE_SIZE`). Keep it that way.
- **The invalidation trigger's regex must track the parser.** The
  SQL name extraction in
  `clear_stale_grocery_products_on_recipe_change` duplicates the
  cooklang `@`-token grammar; the drift-guard suite in
  `tests/grocery-list.test.ts` mirrors it in JS and compares
  against `parseCooklang`. Changing INGREDIENT_RE in
  `src/lib/cooklang.ts` (or the SQL) without updating the other
  side fails that suite - that is the alarm working, not noise.
- **Seeding is client-side and racy by a round trip.** Two tabs
  racing the first load can in principle double-seed the canned
  sections; the count re-check narrows the window and a double
  seed is cosmetic (duplicate names, user-deletable). Not worth a
  server-side lock.
- **Item rows wrap; they never ellipsize.** Both surfaces render the
  name on a line of its own and `itemDetailLine` on a block under
  it, each with `overflow-wrap: anywhere` and no
  `text-overflow: ellipsis`. This is deliberate: a shopper scans an
  aisle card by item name, and the drawer in particular is narrow
  enough that clipping started on ordinary names. Reintroducing
  single-line truncation to "tidy" a tall row undoes the fix.
  `.grocery-item-name` is shared with the add-input's suggestion
  dropdown, so a change there lands in two places.
- **The grocery function reuses the recipe GC driver.** The drain
  loop in `_shared/recipe-image-gc.ts` is table-agnostic; changing
  its semantics changes BOTH sweeps.
