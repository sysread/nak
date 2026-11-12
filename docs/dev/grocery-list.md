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
  to its current entry), item drag-to-file (press-and-hold anywhere
  on the row lifts it - accent ring, raised shadow - then slide
  onto a section card, which highlights, and release to save its
  section; the drop path resolves the row in BOTH the on-list and
  acquired arrays, so In-cart and history rows re-file too; the
  section manager's reorder shows an insertion line via
  `sectionDropEdge`), whole-card
  section reorder (title-bar handles, shown ONLY when "Show empty
  sections" is on - with cards hidden, a drag would silently
  leapfrog invisible sections), and section management. Full-width,
  which is what a phone at the store sees once the drawer closes.
  Pointer drags work anywhere on the row via native HTML5 DnD;
  touch uses the long-press lift pattern (hold ~1s, haptic tick,
  slide, release). The editor's section
  picker remains the keyboard path. The panel row tap is a
  purchase (an OPTIMISTIC move - see the store below - that stamps
  the open entry's `acquired_at`); tapping the row again opens a
  fresh entry, leaving the old purchase in the log.

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
  array (+ `acquiredHasMore` / `loadMoreAcquired`),
  `loadGroceries` (generation-guarded: start order wins over
  resolve order, with a shared abort-signal timeout on every
  query), the OPTIMISTIC check-off flow
  (`toggleGroceryProductOnList` + `pendingToggles` + `writeError`),
  and a post-load reconcile that re-asserts in-flight optimistic
  rows. `loadGroceries`.
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
  (`isShoppingTripActive` - a delegate of the shared session policy,
  `splitAcquiredForTrip`, `CART_IDLE_MESSAGE`, `shoppingToggleLabel`),
  the optimistic toggle moves (`applyOptimisticPurchase` /
  `applyOptimisticRevival`, with disagreement no-op guards) plus
  `reconcilePendingToggles` and the check-slot render decision
  (`rowCheckState`), the sidebar browse
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
- `src/lib/tools/grocery.schema.ts` + edge
  `supabase/functions/venice/tools/grocery.ts` - the grocery chat
  tool (see "The grocery chat tool" below). Deno op tests at
  `supabase/functions/tests/grocery_tools.test.ts`.
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
  (the whole ROW is the tap target - role=button with a visual
  check glyph and a busy spinner in its slot while the optimistic
  write is pending; the pencil opens the
  inline editor: name / count / unit / note / section / photo /
  delete), the empty-sections toggle, both drags
  (row-to-card filing from any list state and whole-card reorder,
  pointer + long-press touch with a click-suppression lifecycle),
  the Start/Finish shopping trip toggle with the In-cart
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
  path (modal, server-dispatched recipes (op=save) tool, revert) is
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

## The grocery chat tool

The `grocery` combination tool gives the chat model the list
surface: one tool, one `op` enum - list (read + search, with a
sections payload), add (batch, idempotent), remove (un-plan),
update (rename / note / section / planned quantity). Browser half
`src/lib/tools/grocery.schema.ts` (schema-only, a `serverSideTool`
in the `groceryToolbox`), edge half
`supabase/functions/venice/tools/grocery.ts` (b-strict
service-role writes, direct table writes - no grocery CRUD RPC
takes a `p_user_id`, so the recipe combo's RPC path has no
equivalent here).

Two contracts carry the design:

- **The un-plan boundary.** `remove` deletes the open entry and
  never stamps `acquired_at`. Purchase history records only real
  buys, and every existing stamp is the user's own panel tap; the
  purchase op is deliberately absent from the tool (deferral in
  `./planned-changes.md`). The toolbox description teaches the
  model this boundary.
- **The tiered name probe on add.** A recipe-context add probes
  that recipe's products, then standalone staples - never another
  recipe's product, which would silently cross the invalidation
  trigger's cleanup boundary. A standalone add probes standalone
  products, then anything (sidebar checkbox parity). Within the
  winning tier, multiple matches resolve to the most recently
  updated row and the outcome reports it; remove/update, which
  edit, refuse ambiguity with candidates instead. Revive beats
  create everywhere - the learned section and purchase history
  stay with the product.

Machine-chosen sections (the model filing an item via the
`section` param) stamp `section_source: 'auto'` - the same
provenance the auto-sectioning agent gets, and equally
overridable by a user refiling. Items added without a section
land in the intake bucket exactly like unclassified browser adds.
`rename` is refused on recipe-linked products: the checkbox match
and the invalidation trigger key on the name, a trade the UI
editor shows the user but the model cannot see.

Edge writes refresh open tabs through the standard realtime relay
(no side channel) - the tool stamps `user_id`, so the
postgres-change filter matches and `nak:grocery:changed` fires.

## Shopping trips

The "Start shopping" / "Finish shopping" button on the panel toggles
the `shopping` entry of `profiles.settings.activeSessions` (an ISO
`startedAt` timestamp; see `ActiveSession` in `types/settings.ts` -
one session map shared with the Cookbook's cooking sessions, written
through the `updateActiveSessions` read-modify-write so a concurrent
cooking session on another surface can't be clobbered). While a trip
is active, items unchecked from the list surface in the **In cart**
card between the section cards and the acquired disclosure - membership is derived, not stored:
off-list AND `acquired_at >= trip start` (the panel's uncheck
stamps the open entry's `acquired_at`), split client-side by
`splitAcquiredForTrip`. Because the split keys on the purchase
stamp - not `updated_at` - editing an old item mid-trip can no
longer fake it into the cart (a real gotcha of the pre-split
model). The acquired-history disclosure excludes the cart rows
while a trip is active. A trip is active only while the local
calendar day still matches the start timestamp
(`isShoppingTripActive`, a delegate of the shared `isSessionKeyActive`
policy in `src/lib/ui/active-sessions.ts` - the trip has no age
bound, unlike cooking sessions), so it expires at midnight in the
user's timezone with no cron or cleanup write - the stale timestamp
just reads as inactive; a minute-tick in the panel re-evaluates so an
open tab crosses midnight too. Idle, the In-cart card shows
`CART_IDLE_MESSAGE`.

**Legacy migration**: blobs written before the session map carried
the trip on `settings.groceryShoppingStartedAt`. `coerceSettings`
seeds the map's `shopping` entry from it on first read (the map wins
when it already carries one); the next `activeSessions` write clears
the legacy key - the same read-side migration pattern as
`journalTimezone`.

## Refresh model

The check-off flow is OPTIMISTIC and concurrent. A row tap runs
`toggleGroceryProductOnList` (grocery-store.svelte.ts): the row
moves in the store the moment it is tapped (a purchase stamps
`acquired_at` locally, which is what routes it into In cart
mid-trip), the write fires per-row, and when the LAST pending
write lands, one settle-reload picks up every write at once - a
burst of taps is one reload, not one three-query reload per tap.
A failed write reverts the row, sets `writeError` (cleared by the
next successful TOGGLE, not by a load - the failure path's own
resync load would flash the message away otherwise), and resyncs.
A tap on a row whose write is still pending is ignored (the
pending guard also covers the drawer's un-plan toggle, whose rows
would otherwise race a panel write on the same product).

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

`loadGroceries` itself is GENERATION-GUARDED: each call takes a
monotonic token at the START (wrapping the seed branch), and a
call whose token is superseded discards its results, its error,
and its `loading`/`loaded` writes. Start order wins over resolve
order - the pre-fix contract was "a later result overwrites,"
which let a load that started before a write committed (a stale
snapshot) overwrite newer truth when it resolved late, visibly
un-doing a check-off. The guard makes the reload storm safe: the
relay has no self-write suppression, so a burst of N check-offs
fires N echo reloads plus the settle-reload, all racing. Every
query in a load runs under one shared abort signal with a ~15s
timeout (`REQUEST_TIMEOUT_MS`; toggle writes get their own), so a
request that black-holes on flaky wifi cannot pin `loading`
forever (the sidebar's mount gate reads it) or leave a row's
pending spinner stuck. After a successful load,
`reconcilePendingToggles` re-asserts the optimistic rows for
writes still in flight - a raced load briefly un-does them; the
reconcile puts them back until the write's own settle-reload
replaces them with truth.

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
  cookbook is also where cooking mode lives - the other consumer of
  the shared `activeSessions` map; the trip and the cooking
  sessions must not clobber each other's settings writes.
- **Chat** (`./chat.md`) - hosts the drawer tab, the lazy component
  load, and the realtime relay.
- **File storage** (`./file-storage.md`) - the fourth private
  bucket + its GC sweep.
- **Settings** (`./settings.md`) - the shopping trip rides the
  shared `activeSessions` map on `profiles.settings` through the
  standard coercer + merge-RPC path; session-map changes mean
  touching `ActiveSession`/`coerceActiveSessions` in
  `types/settings.ts`, the `activeSessions` whitelist branch in
  `updateSettings`, and the mutators in
  `src/lib/ui/active-sessions.ts` together.
- **Routing** - `drawer=groceries` joins the DrawerTab union in
  `routing.svelte.ts`.
- **Models** (`src/lib/models/index.ts`) - the `grocerySection`
  slot in `AGENT_MODELS`; retuning the auto-sectioning model means
  editing that slot, not the agent module. The call rides the
  non-streaming `complete()` seam of the venice proxy
  (`src/lib/supabase/venice-proxy.ts`), including its 429 retry
  loop.
- **LLM tools** (`./tools.md`) - the `grocery` combination tool
  (list / add / remove / update), added 2026-11-12 after shipping
  tool-less deliberately. Its writes are covered by the realtime
  relay like any other writer; its recipe-context adds link
  `recipe_id` so the invalidation trigger cleans them up; its
  un-plan boundary (never stamp a purchase) is pinned in the tool
  contract and the toolbox description.

## Gotchas

- **The chat tool never stamps a purchase.** `grocery op=remove`
  deletes the open entry only, and no op writes `acquired_at` -
  purchase history records only real buys, and stamping it is the
  panel row tap. The remove/update writes also carry the open-entry
  predicate (`acquired_at is null`) so a purchase racing the write
  costs the tool its row, not the history its record.
- **A chat-tool section choice stamps `section_source: 'auto'`.**
  The model files items as a machine, same provenance as the
  auto-sectioning agent; the classifier only touches null-source
  rows, so user refiling still wins. Unfiling via the tool (section
  null) is back to intake - the UI-only "deliberately in Other"
  state (`section_id null + source 'user'`) is not reachable from
  the tool.
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
  `supabase/functions/_shared/cooklang-parse.ts` (or the SQL) without updating the other
  side fails that suite - that is the alarm working, not noise.
- **Seeding is client-side and non-reentrant.** Two tabs racing the
  first load could historically double-seed the canned sections
  (cosmetic, user-deletable). The dangerous case is bigger: an
  external wipe of the sections table (QA cleanup, a manual DB
  delete) makes every realtime echo trigger a reload, and each
  reload that observes zero sections re-seeded - 10 insert echoes
  per seed, each fanning out to more loads, a self-sustaining
  reload storm (observed live in QA: 201 seed batches, 2010 rows,
  until the browser's connection pool gave out). The `seedInFlight`
  guard in `loadGroceries` collapses concurrent seeds to one, which
  converges the storm; the seed branch remains client-side because
  per-user rows need an auth context the sync script doesn't have.
  Once requests start FAILING, note that the sidebar's mount gate
  (`!grocery.loaded && !grocery.loading`) retries on every re-mount
  - a pre-existing failure-mode amplifier worth knowing about if
  you ever see a wedged tab.
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
- **Optimistic rows carry `entry_id: null`, and the pencil knows.**
  A moved row's real entry does not exist yet; keeping the OLD id
  would let a fast quantity edit write to the closed entry. Null
  degrades the editor's quantity save to a no-op, and the pencil is
  disabled for the whole null-entry window (pending, and the
  post-success pre-reload moment) so the no-op is unreachable.
- **A lift gesture must never toggle.** The touch drag's touchend
  `preventDefault()`s (killing the synthesized click) AND the row's
  click handler consumes a one-shot `suppressClick` flag that the
  long-press timer arms. The flag is also disarmed by every fresh
  touchstart - the preventDefault can swallow the click entirely,
  leaving the flag unconsumed, and without the disarm the NEXT real
  tap would be silently dropped.
- **Only a single stationary finger lifts.** A second touch on the
  screen cancels a pending press (a palm sharing the phone
  one-handed), and a touchstart during an active drag is ignored
  (one component-level drag slot).
- **`touch-action` is deliberately NOT restricted on item rows.**
  `pan-y` would let the browser claim vertical pans and break the
  `preventDefault`-during-lift path; selection and callout are
  suppressed with `user-select: none` / `-webkit-touch-callout:
  none` instead.
- **`loadMoreAcquired` blocks while a toggle is pending.** Its
  offset cursor is `grocery.acquired.length`, which optimistic rows
  inflate (the next page skips a real history row) or deflate (it
  re-appends a loaded row - duplicate keys in the keyed each). The
  pending window is sub-second, so blocking beats a truth-cursor.
- **The drag-to-file drop path resolves BOTH arrays.** The whole
  row is the drag surface and the In-cart / history cards render
  rows too; an `onList`-only lookup would silently no-op every
  lift from an acquired row.
