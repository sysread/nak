# Cookbook

Personal recipe store. Recipes are authored in Cooklang, persisted to
Supabase, exposed to the LLM via tool calls, and rendered in a
modal plus a drawer tab. Storage and tools are memory-shaped; the UI
follows the Settings modal pattern.

## Role in the app

The cookbook is a staging area for recipes the user wants to capture,
tidy, and cook from. Intentionally narrow on recipe mechanics - no
meal planning, no servings scaling - but it feeds the in-app
grocery list: every recipe's detail pane carries per-ingredient
checkboxes that push items onto the Groceries drawer tab (see
[`./grocery-list.md`](./grocery-list.md)). The model can read,
write, and edit recipes via tools; the user can do the same via the
Cookbook modal.

Storage layout follows `memories` deliberately — recipes are
user-owned notes that the LLM can also author, same row-level
security posture, same "freeform text column as source of truth"
philosophy. Embeddings pipeline added later (see "Embeddings"
below) for the drawer-side recipe search; the LLM tool path
(`recipe_list`, `recipe_search`) still uses ILIKE-on-title and is
unaffected.

## Files

- `src/lib/cooklang.ts` — inline Cooklang parser + HTML / plain-text / markdown
  renderers. Deliberately no upstream dep. Exports `parseCooklang`,
  `recipeToHtml`, `cooklangToHtml`, `recipeToc`, `recipeToPlainText`,
  `recipeToMarkdown`, and the size constants the tools and the modal
  share. `recipeToc` is a third projection of the parsed AST (alongside
  the HTML and the export renderers): it returns the detail pane's table
  of contents (Ingredients + Instructions, each with a sub-entry per
  rendered section). Its link ids and the `<h3>` / `<h4>` ids
  `recipeToHtml` stamps both come from one private `tocHeadingId` helper,
  so a jump link can never point at a heading the renderer didn't emit.
- `src/lib/cookbook-store.svelte.ts` — module-level `$state` for the
  recipe list. Holds the paginated "All recipes" window (`recipes`,
  `offset`, `hasMore`, `loadingMore`, `sort`), the complete `upcoming`
  / `favorites` bucket arrays, the topic selection, and the vocabulary.
  `loadRecipes` reloads page one (current sort + topic filter) and
  refetches the buckets; `loadMoreRecipes` appends the next offset
  page. The bridge between the tool layer and the UI is a window
  `CustomEvent` (`nak:recipes:changed`) so tools stay UI-unaware - its
  handler calls `loadRecipes`, i.e. a tool mutation resets the list to
  the top rather than trying to patch a row in the middle of a page.
- `src/lib/tools/recipe_*.schema.ts` — the nine LLM tools' wire
  schemas (name, description, JSON Schema parameters). Schema only;
  the browser never executes a recipe tool.
- `supabase/functions/venice/tools/recipe_save.ts`, `recipe_list.ts`,
  `recipe_get.ts`, `recipe_update.ts`, `recipe_delete.ts`, and
  `recipe_photos.ts` (which carries all four photo verbs) — the
  implementations, dispatched function-side against the admin client.
  `_recipe_helpers.ts` holds `readRecipePhotoMeta`, the "newest
  version's link set" read that `recipe_get` and `recipe_update`
  both answer photo questions with. Mutating tools reach the UI
  through the realtime relay, not `notifyCookbookChanged` - see the
  relay gotcha below.
- `src/lib/supabase.ts` — `Recipe`, `RecipeVersion`, `RecipePhoto`,
  `RecipePhotoMeta`, and `RecipePhotoInput` types + `createRecipe /
  updateRecipe / deleteRecipe / getRecipe / listRecipes /
  listRecipesPage / listUpcomingRecipes / listFavoriteRecipes /
  listRecipeVersions / getRecipeVersion / revertRecipe /
  upsertRecipeImage / listRecipePhotos / listRecipePhotoMeta /
  listRecipeVersionPhotoInputs / attachRecipePhotos /
  removeRecipePhotos / reorderRecipePhotos / setRecipePhotoLabels`
  methods. Lives between the memory methods and the background-worker
  pipeline block.
  `createRecipe` / `updateRecipe` go through the
  `recipe_create_with_version` / `recipe_update_with_version` RPCs
  so the parent row, the history snapshot, and any photo links land
  in one transaction. Both versioned RPCs accept a parallel-indexed
  `p_image_labels text[]` alongside `p_image_ids` so a save lands
  the photo set, ordering, AND captions atomically. The photo-only
  mutations (`attachRecipePhotos` etc.) call dedicated single-
  purpose RPCs that wrap "snapshot a new version + write its links"
  atomically; `setRecipePhotoLabels` is the caption-edit verb.
- `src/screens/Cookbook.svelte` — three-pane modal (list, detail,
  edit). Mirrors `Settings.svelte`'s shell / escape / click-outside-
  to-close conventions; styles scoped locally rather than added to
  `styles.css` because the modal is an island. The detail pane parses
  the recipe once and feeds both `recipeToHtml` and `recipeToc` off the
  result; the TOC renders as a `<nav class="cookbook-toc">` above the
  rendered body, and a click resolves the target heading by id within
  the bound render container (`detailRenderEl`) and `scrollIntoView`s it.
  The TOC is gated on `recipeTocVisible(...)` so a one-block
  recipe doesn't show a lone link.
- `src/lib/ui/recipe-detail.ts` — pure UI-behavior primitives for the
  detail pane (`recipeSourceLine`, the lightbox carousel helpers, the
  photo-strip aria labels, and `recipeTocVisible` - the "is the TOC
  worth showing" threshold, kept out of the renderer because it's a
  presentation threshold, not part of the document structure).
  Unit-tested at `tests/recipe-detail.test.ts`.
- `src/lib/ui/cookbook-screen.ts` — the screen-scoped UI primitives
  for Cookbook.svelte (named `-screen` because the cookbook domain
  already owns the nearby names - `cookbook-store.svelte.ts`,
  `cooklang.ts`, `recipe-limits.ts`): routed-recipe resolution against
  the loaded store sets and the by-id fallback fetch, the edit-form
  draft seeds and validation ladder + error copy, the photo-draft
  lifecycle (pick gates against the photo cap / images-only / size
  rules, reorder, the `{id, label}` save payload), the auto-generated
  rating and revert change messages, the History panel's summary label
  and row states, and the action-bar / bookmark button copy.
  Unit-tested at `tests/cookbook-screen.test.ts`.
- `src/screens/Chat.svelte` — drawer tab switcher (`drawerTab`),
  Recipes list rendering, footer book icon, Cookbook modal mount,
  `COOKBOOK_CHANGE_EVENT` listener in `onMount`, and the
  recipes-table realtime relay (`subscribeToRecipeChanges` →
  `emitCookbookChange`) that publishes the event when a server-side
  recipe write lands.
- `src/components/RecipeList.svelte` — the sidebar listing
  rendered by the Recipes drawer tab. Owns the search input, the
  sort selector (bound to `cookbook.sort`), the topic-filter
  dropdown mount, the debounced embed-then-search round trip with
  abort-controller supersede, an `$effect` that reloads page one
  whenever the sort or topic filter changes, and the buckets-plus-
  main-list markup with an infinite-scroll sentinel at the tail of
  the "All recipes" list (browse mode only). Composition-only:
  every UI-behavior decision lives in the primitives module next
  door.
- `src/lib/ui/recipe-list.ts` — pure UI-behavior primitives for
  the recipe sidebar. `isSearching(query)`,
  `pickVisibleRecipes(args)` (client-side topic filter over the
  capped search results on search; the server-sorted, server-topic-
  filtered page window rendered verbatim on browse - no client
  re-sort, which would disagree with the server's page boundaries
  mid-scroll), `pickUpcomingRecipes` and `pickFavoriteRecipes`
  (topic filter + recency sort over the complete bucket arrays,
  empty during a search), `matchesTopicFilter(recipe, selected)`
  (the client-side topic predicate, used for the search results
  and the buckets - the paginated "All recipes" list filters
  server-side instead, since a partial page has to be narrowed
  before it is sliced), and `computeListView(args)` returning a
  tagged union for the listing area's 5-state render decision
  (scanner-search / error / scanner-loading / empty / list). The
  `SEARCH_DEBOUNCE_MS` and `RECIPE_SEARCH_LIMIT` tunables also
  live here. Unit-tested at `tests/recipe-list.test.ts` with
  plain vitest. The sort itself (updated / rating / alphabetical)
  is pushed into the Supabase query, NOT computed here.
- `src/lib/actions/infinite-scroll.ts` — shared Svelte `use:`
  action wrapping an IntersectionObserver; fires `onHit` when the
  sentinel nears the viewport. Used by the RecipeList, MemoryList,
  and WikiList sidebars to page their browse lists.
- `src/styles.css` — `.sidebar-nav`, `.recipe-drawer-list`,
  `.recipe-drawer-footer`. The nav section reuses `.thread` and
  `.thread-row` for the button chrome and lives with the rest of
  the sidebar styles.

## Entry points

- **Footer book icon** in the sidebar → opens the Cookbook modal on
  the list pane.
- **Recipes tab** in the drawer → lazy-loads the list (first click
  fetches from Supabase; subsequent switches are free). Clicking a
  row opens the Cookbook modal on the detail pane for that id via
  the `initialRecipeId` prop.
- **LLM tool calls** - `recipe_save / list / get / update / delete`,
  grouped into the `cooking` toolbox. The model flips the toolbox
  on with `toggle_toolbox({enabled: ["cooking", ...]})` before
  reaching for any of the recipe tools; the user can do the same
  from the composer toolbox popover.

## Data model

- `public.recipes` table (see `supabase/schema.sql`):
  - `id uuid`, `user_id uuid`, `title text not null`,
    `source text`, `source_url text`, `cooklang text not null`,
    `rating smallint` (null = unrated; check constraint enforces
    1-5), `upcoming boolean not null default false`,
    `favorite boolean not null default false` (both are workflow
    bookmarks - see "Bookmark flags" below), `created_at`,
    `updated_at`.
  - Indexes: `recipes_user_updated_idx (user_id, updated_at desc)`;
    partial `recipes_user_upcoming_idx (user_id) where upcoming` and
    `recipes_user_favorite_idx (user_id) where favorite` to keep the
    "list upcoming" / "list favorites" paths cheap while most rows
    aren't bookmarked.
  - RLS: four self-* policies (select / insert / update / delete),
    same shape as `memories`.
  - **Bookmark flags** (`upcoming`, `favorite`): not in
    `recipe_versions`. Toggled via
    `SupabaseService.setRecipeUpcoming(id, upcoming)` and
    `setRecipeFavorite(id, favorite)`, which do direct table updates
    bypassing `recipe_update_with_version` - both are workflow
    state, not content, so they do not write version rows and do not
    touch `updated_at` (so the recency sort stays stable across
    toggles). The two flags are independent. The drawer's
    `RecipeList.svelte` renders an "Upcoming" section at the top
    from the complete `cookbook.upcoming` array (fetched whole by
    `listUpcomingRecipes`), then a "Favorites" section below it
    from `cookbook.favorites` (`listFavoriteRecipes`). These are
    fetched separately from the paginated "All recipes" list
    precisely because they must be complete - a flagged recipe that
    lives past the loaded page window would otherwise vanish from
    its bucket. The partial `recipes_user_upcoming_idx` /
    `recipes_user_favorite_idx` indexes keep those whole-bucket
    fetches cheap. Rows in either section ALSO appear in their
    natural position in the main "All recipes" listing below (the
    duplication is intentional - the user wants both "what's
    bookmarked" and "where it lives normally"). The LLM tools do
    NOT expose a way to toggle either flag - both are strictly
    user-driven UI affordances, surfaced via the cart and
    thumbs-up icons in `Cookbook.svelte`'s detail action bar.
- `public.recipe_versions` table (see `supabase/schema.sql`):
  - `id uuid`, `recipe_id uuid` (FK to `recipes`, on-delete cascade),
    `user_id uuid`, `title`, `source`, `source_url`, `cooklang`,
    `rating smallint`, `change_message text not null`, `created_at`.
  - Indexes: `recipe_versions_recipe_created_idx (recipe_id,
    created_at desc)` for the History panel; `recipe_versions_user_idx
    (user_id)` for fast RLS evaluation.
  - RLS: select + insert self-* policies only. Versions are
    immutable - no update or delete policy. A cascade delete from
    `recipes` is the only way a version row leaves the table.
- `public.recipe_images` table (see `supabase/schema.sql`):
  - `id uuid`, `user_id uuid`, `sha256 text` (64-char hex),
    `mime_type text`, `size_bytes int`, `storage_path text`,
    `created_at`. Unique on `(user_id, sha256)` for per-user dedup.
  - Bytes live in the private `recipe-images` Storage bucket at the
    content-addressed key `<user_id>/<sha256>` (`storage_path`).
    `listRecipePhotos` resolves a display `url` (a signed bucket URL).
    The migration off the old base64 `data` column is complete - see
    [`./file-storage.md`](./file-storage.md).
  - RLS: self-* select / insert / delete; no update (rows are
    immutable - byte changes mean a different sha256, which means a
    different row).
- `public.recipe_version_images` table (see `supabase/schema.sql`):
  - `recipe_version_id uuid` (FK cascade to `recipe_versions`),
    `image_id uuid` (FK to `recipe_images`), `user_id uuid`,
    `position int`, `label text` (nullable), `created_at`. Composite
    PK on `(recipe_version_id, image_id)`.
  - Indexes: `recipe_version_images_image_idx (image_id)` for the
    orphan-GC trigger's reverse lookup;
    `recipe_version_images_user_idx (user_id)` for RLS.
  - RLS: select + insert self-* policies only; deletes flow through
    the cascade from `recipe_versions`.
  - `label` is the optional photo caption, scoped to this version's
    link. Per-version (link-level) so a label change creates a new
    version like any other photo edit, and revert restores the
    captions a snapshot held. Empty / whitespace-only labels
    normalise to NULL on the wire so "no caption" reads
    consistently across the read path. Labels are not unique - two
    photos on a recipe can share a caption, or have none.
  - Orphan reclamation is an idempotent server-side sweep (the
    `recipe-image-gc` edge function + cron), not a trigger. It
    deletes any `recipe_images` row with no link AND its bucket
    object - catching both delete-side orphans (last link removed,
    e.g. via a recipe-delete cascade) and insert-side orphans (a row
    upserted but never linked). The `list_orphan_recipe_images` /
    `delete_orphan_recipe_images` RPCs back it; the delete re-checks
    "still no link" to skip a row re-linked mid-sweep. Replaced the
    old `gc_orphan_recipe_image` AFTER DELETE trigger, which could
    only delete the row (never the Storage object) and never caught
    insert-side orphans. See
    [`./file-storage.md`](./file-storage.md).
- Parsed shape (`src/lib/cooklang.ts::Recipe`): `{ metadata, steps,
  ingredients, cookware, timers, sections }`. The DB stores raw
  source; the parsed shape is re-derived at read time.

## Contracts

- `parseCooklang(src: string): Recipe` — never throws. Malformed
  input produces a partial result; callers detecting emptiness check
  `steps.length === 0`.
- `cooklangToHtml(src: string): string` — parses + renders a scoped
  HTML fragment (no root wrapper). Classes prefixed `cook-` so host
  CSS can style without nesting selectors. The Ingredients /
  Instructions `<h3>`s and their section `<h4>`s carry `id`s
  (`cook-ingredients`, `cook-instructions`, `cook-<block>-sN`) so the
  TOC can scroll to them; Cookware is not a TOC target and stays
  id-less.
- `recipeToc(recipe: Recipe): RecipeTocEntry[]` — the detail pane's
  table of contents: `[{ id, label, sections }]` for Ingredients and
  Instructions (whichever have content), each `sections` entry one
  rendered section heading. Ids match the renderer's heading anchors
  by construction (shared `tocHeadingId`). Cookware is omitted on
  purpose - it's a flat aside, not a navigation destination.
- `recipeToPlainText(title: string, recipe: Recipe): string` —
  AnyList-friendly export. Title + ingredients list + numbered
  instructions. Cookware omitted by design (shopping-list apps don't
  accept pots as items).
- `recipeToMarkdown(title, recipe, { source?, sourceUrl? }): string`
  — human-readable markdown export aimed at notes apps and issue
  trackers. Same structural pieces as the plain-text export plus a
  source link, `>> key: value` metadata as bolded bullets, and the
  cookware list (which the markdown target wants and the plain-text
  target deliberately strips). Content (title, step text, ingredient
  names, metadata values) is emitted verbatim - any inline markdown
  the LLM left in the recipe round-trips, by design.
- `MAX_RECIPE_COOKLANG_CHARS = 20_000`, `MAX_RECIPE_TITLE_CHARS = 160`
  — shared between the tools and the modal so schema validation
  agrees everywhere.
- Tool contract follows the standard `ToolDef` (see `./tools.md`).
  The tools run function-side, so a mutation reaches the UI through
  the `recipes` realtime relay rather than an in-process notify call.
- A mutating tool's response must describe state it actually read
  back, not the shape the caller asked for. See the echoed-row gotcha
  below for the two fields this went wrong on.
- **The rating is user-only.** `recipe_update` accepts no `rating`
  argument and always passes `p_set_rating: false`; a call that
  carries one is rejected with an explanatory error. The rating is a
  user evaluation of a cooked dish, so it moves only through the UI
  paths - the star control on the recipe card and the edit form -
  which reach `updateRecipe` directly. `recipe_save` still takes a
  rating, since a save can transcribe a rating the user stated while
  dictating the recipe.

## Versioning

Every create and every update writes one immutable snapshot into
`recipe_versions` along with a `change_message` describing the edit.
Two writes per mutation, one transaction: both
`recipe_create_with_version` and `recipe_update_with_version` are
plpgsql RPCs, so either both rows land or neither does.

`change_message` is required at the `SupabaseService.createRecipe` /
`updateRecipe` layer (and on `recipe_update`, where a meaningful delta
description exists). The `recipe_save` tool is the one exception: a
save is always a recipe's first version, so an omitted message has no
delta to describe and the tool defaults it to `"Initial version"`
(matching the backfill seed's naming) rather than bouncing the model
with an error - the model routinely forgets the field on a brand-new
recipe. The default lives in the tool, not the service method, so
non-LLM callers (revert, the modal edit form) stay strict.

The shape is **denormalized cache + immutable log**: the `recipes`
row stays the canonical-current state, and `recipe_versions` is the
audit trail. Hot reads (list pane, detail render, drawer tab) keep
their one-table projection; the History panel is a cold path that
fetches `recipe_versions` lazily on first detail-pane open.

**Why both** (instead of a `current_version_id` pointer on
`recipes`): every existing read path projects directly off `recipes`
and `cookbook.recipes[]` is denormalized in the store too. A
pointer would force a join on every read for no user-visible win,
since History only matters when the user opens the panel. The
duplicate bytes per snapshot are trivial at single-user cookbook
scale (a typical recipe is 1-3 KiB; even a hundred edits is well
under a megabyte).

**Atomicity**: `recipe_update_with_version` takes a `for update`
lock on the parent row before snapshotting, so concurrent writers
(the user editing in the modal while the model also calls
`recipe_update`) serialize. The first writer commits its snapshot;
the second sees the post-first-commit state and snapshots that. No
gaps in the history chain, no surprise overwrites.

**No revert RPC**: revert is a normal update whose patch happens to
come from a past version row. `revertRecipe` reads the snapshot
plus the version's photo link list, then calls `updateRecipe` with
that content (including `image_ids`). The revert itself becomes a
new version row carrying the restored photo set, so a misclick is
recoverable.

**No history LLM tools** (deliberately): the model has no
`recipe_versions_list` or `recipe_revert` tool, only the existing
`recipe_save` / `recipe_update` / etc. History viewing and revert
are user-directed UX flows; letting the model revert without an
explicit user prompt is a footgun without a clear win. The model
can already author whatever content it wants via `recipe_update`,
and the user has revert in the modal. Revisit if a need surfaces.

**Backfill**: existing recipes that predate the rollout get one
"Initial version (backfilled)" row inserted at sync time. The seed
is idempotent (`not exists` predicate), so re-running `mise run
sync` is a no-op.

**Retention**: unbounded by design. The cookbook is small and the
user opted in to keeping every revision so the History panel reads
as a complete diary.

## Embeddings

The drawer's recipe search runs through the same embed-then-merge
pipeline as the wiki and journal sidebars (see `./embeddings.md`).
Added after the original `recipes` design, which omitted embeddings
on the rationale that ILIKE-on-title is enough for a small
single-user cookbook. That holds for the LLM tool path - the model
knows exactly what title it wrote - but the human drawer is a
different problem: a fuzzy query like "fluffy potato side" should
find "Mashed Potatoes" by meaning.

Columns: `embedding vector(2048)`, `embedding_model text`,
`embedding_claim_holder text`, `embedding_claim_expires timestamptz`
on `public.recipes`. A `clear_recipe_embedding_on_change` trigger
nulls the embedding (and the claim) whenever `title`, `cooklang`,
or `source` change; `recipe_update_with_version` updates these
columns inside its own RPC so the trigger fires automatically.

RPCs: `claim_next_pending_recipe`, `save_recipe_embedding_if_claimed`,
`search_recipes_by_embedding`. Same shape as the wiki RPCs and the
same `for update skip locked` claim discipline. The recipe input
builder is the `recipes` entry in `EMBED_SOURCES`
(`supabase/functions/_shared/embed-input.ts`), drained by the
server-side backfill alongside the other six sources.

Search wrapper: `SupabaseService.searchRecipes({query, queryEmbedding,
limit})` merges semantic hits (RPC, cosine order) and ILIKE hits
(title only) deduped by id and capped at `limit`. The sidebar
(`src/components/RecipeList.svelte`) calls it on debounced
keystrokes; the LLM tool path keeps using `listRecipes`.

## Interactions

- **Tools** (`./tools.md`) — five recipe tools registered in
  `src/lib/tools/index.ts`'s `TOOLS` array, gated like the memory
  tools. They appear in the system-prompt catalog automatically via
  `buildSystemPrompt`'s `GATED_TOOLS` section.
- **Chat** (`./chat.md`) — hosts the Cookbook modal, the drawer tab,
  and the footer book icon. Adds a `drawerTab` state local to
  Chat.svelte. Registers the `COOKBOOK_CHANGE_EVENT` listener in
  its `onMount`, and runs the recipes-table realtime relay that
  fires the event, so a model-driven save refreshes the Recipes tab
  live.
- **Settings** (`./settings.md`) — no settings yet; cookbook-wide
  preferences (default servings, preferred unit system) would land
  on `profiles.settings` if and when we grow them.
- **Memory** (`./memory.md`) — scope contrast. A memory is "something
  about the user"; a recipe is "an item the user owns". Share the
  RLS posture and the tool-registry pattern; don't share data.
- **Grocery list** (`./grocery-list.md`) — the ingredient-checkbox
  bridge: `recipeToHtml`'s `ingredientCheckboxes` option, the
  detail pane's delegated handler + checked-state sync, and the
  `clear_stale_grocery_products_on_recipe_change` trigger, which
  deletes a recipe's grocery products whose ingredient names no
  longer parse out of `recipes.cooklang` after a change (a SQL
  regex over the `@`-token syntax; a drift-guard test compares it
  against `parseCooklang`). Any new write path that touches
  `cooklang` inherits that side effect by construction; a write
  path that changes ingredients WITHOUT touching `cooklang` would
  silently skip it (none exists today).
- **Offline cache** (`./offline-cache.md`) — a recipe's `favorite` or
  `upcoming` flag is what saves it offline: the offline-sync reconcile
  mirrors the union of both buckets into IndexedDB. The Cookbook
  detail view routes its existing `getRecipe` deep-link fallback
  through that feature's `getRecipeCached` read-through, and the
  bookmark / edit / delete controls disable when offline. The
  bookmark flags' deliberate no-bump of `updated_at` is what lets the
  cache treat a toggle as "no content change".
- **Topics** (`./topics.md` under "Recipe topics") - a server-side
  curation unit
  (`supabase/functions/venice/agents/recipe_topics.ts`) tags each
  recipe with 1-6 short topic strings spanning primary
  ingredients, cuisine, course, and technique. The Cookbook drawer mounts the same
  `TopicsFilter.svelte` component the conversation and Memories
  drawers use; the filter narrows the Upcoming / Favorites / All /
  search buckets uniformly - server-side for the paginated "All
  recipes" list (so each page is filtered before it is sliced),
  client-side for the complete buckets and the capped search
  results. Changing the selection reloads the "All recipes" list
  from page one. Tags are managed by the unit - no manual tagging
  tool exposed to the LLM or the user, by design.

## Gotchas

- **Inline parser, not a dep.** We deliberately skipped
  `@cooklang/cooklang-ts`. The Cooklang spec is small and stable,
  and owning the parser means a spec tweak doesn't block on an
  upstream release. If the parser ever needs to handle recipe
  references or shopping-list blocks, revisit — but today every
  line of `src/lib/cooklang.ts` is straightforward.
- **The realtime relay is the tools → UI bridge.** The `recipe_*`
  tools dispatch in the venice function, so the browser learns
  about model-driven writes through a user-scoped
  `postgres_changes` subscription on `recipes`
  (`SupabaseService.subscribeToRecipeChanges`, wired in
  Chat.svelte), which fires `emitCookbookChange` - the `window`
  `CustomEvent` the Cookbook modal and the drawer tab subscribe to
  via `onCookbookChange`. Same shape as the `wiki_articles` and
  `memories` relays.
- **DELETE events need the (id, user_id) replica identity.** A
  DELETE's WAL record carries only the table's replica identity,
  and realtime drops events its `user_id` filter can't match - so
  with the default primary-key identity, server-side deletes never
  reach the panel. `recipes_replident_idx` in `schema.sql` (and its
  wiki_articles / memories twins) exists solely to put `user_id`
  into the old tuple; dropping it silently degrades the identity to
  NOTHING and breaks DELETE replication. The full rationale lives
  on the schema block.
- **Drawer Recipes tab loads lazily.** A session that never opens
  the tab never fetches recipes. The tool layer still loads via
  direct Supabase calls, so a model-driven save works regardless.
  When the tab is opened, subsequent `COOKBOOK_CHANGE_EVENT` fires
  refresh it; before the first open, the event is a no-op (nothing
  to refresh yet).
- **Copy plain text omits cookware on purpose.** AnyList's manual-
  add textarea treats each line as an item — a "saucepan" row would
  sit in the shopping list permanently. Instructions and
  ingredients are the useful parts for transfer.
- **Copy as Markdown deliberately does NOT escape content.** Step
  text, ingredient names, metadata values, and the title pass
  through verbatim. The LLM occasionally drops markdown emphasis
  (`**bold**`, backticks, inline links) into a recipe and the user
  wants that to land in the destination notes app as markdown, not
  as escaped literal characters. Structural markdown (headings,
  list markers, link syntax) is ours to author; content markdown is
  the recipe's. The cost of this choice is that a recipe with a
  stray `*` in an ingredient name will render as italics in the
  paste target - acceptable trade vs. mangling the LLM's intent
  every time.
- **Drawer search is semantic; LLM tool path is not.** The
  embedding pipeline (added after the original "no embeddings"
  design - see "Embeddings" below) feeds `searchRecipes` only.
  The `recipe_list` and `recipe_search` tools the model uses
  still go through ILIKE-on-title. Two reasons: the model knows
  exactly what title it just wrote so meaning matching adds no
  value on the tool path, and keeping the tool's behaviour
  deterministic avoids fuzz on a path the agent reasons about.
- **Cooklang source is the source of truth.** The parsed
  ingredients list you see in the render is derived, not stored.
  This means a future parser bug is a pure read-path issue —
  nothing persisted needs migrating.
- **Photos live alongside cooklang, not inside it.** The detail
  pane renders the photo strip as a sibling above the
  `.cookbook-render` div, not by injecting into the parsed cooklang
  HTML. Cooklang stays unaware of photos so the parser/renderer
  doesn't grow a new concern. Edit-pane photo controls live in
  their own form-row between the change-message field and the
  cooklang+preview panes.
- **A tool's echoed row is a claim about live state - read it back.**
  `recipe_update` answered with a hardcoded `photos: []` and echoed the
  `topics` column, and both read as data loss to the model, which
  relayed "your photos and tags are gone" to the user after an edit
  that had preserved every one of them. Photos: the RPC inherits the
  previous version's links when `p_set_image_ids` is false, so the tool
  reads the post-write link set back through
  `readRecipePhotoMeta` (`tools/_recipe_helpers.ts`, shared with
  `recipe_get`) instead of asserting a shape. Topics: the
  `clear_recipe_topics_on_change` trigger empties the column so the
  curation unit re-tags the row, and the RPC's `return query` reads the
  row back AFTER that trigger fires - so the field is always `[]` on
  this path and the tool strips it rather than echoing a number that
  only ever means "re-queued." `recipe_save`'s `photos: []` is a
  different case and stays: a create passes `p_image_ids: null`, so
  the recipe genuinely has no photos yet.
  `tests/recipe_update.test.ts` guards both.
- **Photo IDs are stable across versions.** A photo upserted into
  `recipe_images` keeps the same id forever for that user;
  reordering or appending changes the link rows, not the image
  rows. The LLM tools surface these ids in `recipe_get`'s
  `photos: [{id, position}, ...]` projection so the model can
  chain a `recipe_photos_remove` call against the same id it just
  saw.
- **Photo lifecycle is link-driven.** Recipe delete cascades
  through `recipe_versions` to `recipe_version_images`; the
  AFTER-DELETE trigger on the link table reclaims the image row
  when its last link goes away. Conversation-attachment expiry has
  no effect on recipe photos - the bytes are copied into
  `recipe_images` at attach time, so the recipe owns its own copy.
- **Photo labels live on the link, not the image.** The `label`
  column is on `recipe_version_images`, not `recipe_images`, so a
  caption is part of the version's link state and gets snapshotted
  / inherited / reverted alongside positions. The same image
  appearing on two recipes (or on different versions of the same
  recipe) can carry different captions on each link without the
  underlying bytes row changing. The edit form keeps draft
  captions in component state until Save - one save per overall
  edit, not one per keystroke - while the LLM-side
  `recipe_photo_label_set` tool is the single-photo / batch-photo
  caption update path. Empty strings normalise to NULL server-side
  (and on the wire helper `splitPhotoInputs`) so "no caption"
  reads as one shape everywhere.
- **Section model layers on top of the flat AST.** `== Name ==` and
  `# Name` (line-start + space) introduce a section. The parser
  records a per-step `section: string | null` plus a top-level
  `sections: string[]` for declaration order, and leaves the flat
  `ingredients / cookware / timers` lists untouched so existing
  callers keep working. `recipeToHtml` groups by section when any
  section exists and collapses to the flat layout when none do — no
  data migration, no schema change, just a richer read. `>` at line
  start is a continuation marker: the parser merges the line into
  the previous step's text and references.
- **Declaration lines vs. instruction steps.** A line whose first
  non-whitespace character is `@` is an ingredient declaration (Step
  with `kind: 'declaration'` and empty `text`). Its ingredients flow
  into the flat and per-section ingredient lists, but the renderers
  skip it in the Instructions block. Lets the LLM write cookbook-style
  recipes — a declaration block of `@ingredient{qty%unit}` lines
  followed by prose instructions — without those declarations landing
  as numbered steps. When ANY declaration exists, the ingredient
  render uses declarations only; inline `@ingredient` references in
  instruction prose are cross-references, not new ingredients, so
  they don't double-count against the declared rows.
- **`@?` marks an optional ingredient.** Not in the canonical spec
  (cooklang/spec discussion #50 is still open), but it is the `?`
  component modifier from the official cooklang-rs parser's
  extensions, so it round-trips through other Cooklang tooling.
  `Ingredient.optional` is a required boolean on the parsed shape;
  the dedupe key includes it, so `@salt` and `@?salt` stay distinct
  rows. All three renderers agree on presentation: the HTML list
  appends a `.cook-optional` "(optional)" span, the plain-text and
  markdown exports append " (optional)" to the bullet, and step
  prose shows just the name. Ingredients only - cooklang-rs also
  allows `#?cookware`, but nak's flat cookware aside has nothing to
  hang optionality off. The `recipe_save` / `recipe_update` tool
  descriptions teach the model the syntax; keep them in sync if the
  rendering changes.
- **Dash-only section reset.** A line whose non-whitespace content is
  only dashes (2+, e.g. `--`, `---`) clears the current `section`. Used
  to end a cookbook-style declaration block so the instructions below
  don't inherit the last `# Section` heading. The check runs BEFORE
  line-level `--` comment stripping (otherwise the dashes would
  collapse to empty and be indistinguishable from a blank line). This
  is an additive extension — a dash-only line used to be a no-op
  comment, so no existing recipe parses differently.
- **TOC ids must stay in lockstep with the renderer.** `recipeToc` and
  `recipeToHtml` are two projections of the same parsed recipe, and the
  detail pane looks the jump target up by id AFTER `recipeToHtml`'s
  output mounts - so a TOC entry whose id doesn't match a rendered
  heading is a silent dead link, not a crash. They are kept honest by
  sharing the private `tocHeadingId` helper (id scheme) and the
  `ingredientBucketRenders` / `instructionBucketRenders` predicates
  (which sections actually emit an `<h4>`). If you change which
  sections the renderer emits, change those predicates rather than
  branching the renderer alone, or the TOC will list a section the body
  doesn't show. Section ids are keyed by index in `recipe.sections`,
  not by a name slug, so the same section name appearing under both
  blocks (`Ingredients > Soup` and `Instructions > Soup`) gets distinct
  ids and a name with odd characters can't collide. `tests/cooklang.test.ts`
  has a lockstep test that asserts every `recipeToc` id resolves to an
  `id="..."` in the rendered HTML - keep it green.
