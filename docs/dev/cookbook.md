# Cookbook

Personal recipe store. Recipes are authored in Cooklang, persisted to
Supabase, exposed to the LLM via tool calls, and rendered in a
modal plus a drawer tab. Storage and tools are memory-shaped; the UI
follows the Settings modal pattern.

## Role in the app

The cookbook is a staging area for recipes the user wants to capture,
tidy, and transfer elsewhere (most commonly AnyList). Intentionally
narrow: no shopping-list logic, no meal planning, no servings
scaling. The model can read, write, and edit recipes via tools; the
user can do the same via the Cookbook modal.

Storage layout follows `memories` deliberately — recipes are
user-owned notes that the LLM can also author, same row-level
security posture, same "freeform text column as source of truth"
philosophy. No embeddings pipeline: ILIKE on `title` is fast enough
at cookbook scale (tens to low hundreds of rows per user).

## Files

- `src/lib/cooklang.ts` — inline Cooklang parser + HTML / plain-text
  renderers. Deliberately no upstream dep. Exports `parseCooklang`,
  `recipeToHtml`, `cooklangToHtml`, `recipeToPlainText`, and the
  size constants the tools and the modal share.
- `src/lib/cookbook-store.svelte.ts` — module-level `$state` for the
  recipe list, plus `loadRecipes` and `notifyCookbookChanged`. The
  bridge between the tool layer and the UI is a window `CustomEvent`
  (`nak:recipes:changed`) so tools stay UI-unaware.
- `src/lib/tools/recipe_save.ts`, `recipe_list.ts`, `recipe_get.ts`,
  `recipe_update.ts`, `recipe_delete.ts`, `recipe_photos_attach.ts`,
  `recipe_photos_remove.ts`, `recipe_photos_reorder.ts`,
  `recipe_photo_label_set.ts` — the nine LLM tools. Mutating tools
  fire `notifyCookbookChanged` on success.
- `src/lib/supabase.ts` — `Recipe`, `RecipeVersion`, `RecipePhoto`,
  `RecipePhotoMeta`, and `RecipePhotoInput` types + `createRecipe /
  updateRecipe / deleteRecipe / getRecipe / listRecipes /
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
  `styles.css` because the modal is an island.
- `src/screens/Chat.svelte` — drawer tab switcher (`drawerTab`),
  Recipes list rendering, footer book icon, Cookbook modal mount,
  `COOKBOOK_CHANGE_EVENT` listener in `onMount`.
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
    1-5), `created_at`, `updated_at`.
  - Index: `recipes_user_updated_idx (user_id, updated_at desc)`.
  - RLS: four self-* policies (select / insert / update / delete),
    same shape as `memories`.
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
    `mime_type text`, `size_bytes int`, `data text` (base64),
    `created_at`. Unique on `(user_id, sha256)` for per-user dedup.
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
  - `gc_orphan_recipe_image` trigger (AFTER DELETE, security
    definer): when the last link to a `recipe_images` row is
    removed, the trigger deletes the image row in the same
    transaction. Recipe delete cascades through versions to link
    rows, which fires the trigger per-row and reclaims the now-
    orphan image bytes. Insert-side orphans (an image upserted but
    no save followed) are not reclaimed automatically; they're rare
    and cheap.
- Parsed shape (`src/lib/cooklang.ts::Recipe`): `{ metadata, steps,
  ingredients, cookware, timers }`. The DB stores raw source; the
  parsed shape is re-derived at read time.

## Contracts

- `parseCooklang(src: string): Recipe` — never throws. Malformed
  input produces a partial result; callers detecting emptiness check
  `steps.length === 0`.
- `cooklangToHtml(src: string): string` — parses + renders a scoped
  HTML fragment (no root wrapper). Classes prefixed `cook-` so host
  CSS can style without nesting selectors.
- `recipeToPlainText(title: string, recipe: Recipe): string` —
  AnyList-friendly export. Title + ingredients list + numbered
  instructions. Cookware omitted by design (shopping-list apps don't
  accept pots as items).
- `MAX_RECIPE_COOKLANG_CHARS = 20_000`, `MAX_RECIPE_TITLE_CHARS = 160`
  — shared between the tools and the modal so schema validation
  agrees everywhere.
- Tool contract follows the standard `ToolDef` (see `./tools.md`);
  mutating tools (`recipe_save / update / delete`) call
  `notifyCookbookChanged()` before returning.

## Versioning

Every create and every update writes one immutable snapshot into
`recipe_versions` along with a required `change_message` describing
the edit. Two writes per mutation, one transaction: both
`recipe_create_with_version` and `recipe_update_with_version` are
plpgsql RPCs, so either both rows land or neither does.

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

## Interactions

- **Tools** (`./tools.md`) — five recipe tools registered in
  `src/lib/tools/index.ts`'s `TOOLS` array, gated like the memory
  tools. They appear in the system-prompt catalog automatically via
  `buildSystemPrompt`'s `GATED_TOOLS` section.
- **Chat** (`./chat.md`) — hosts the Cookbook modal, the drawer tab,
  and the footer book icon. Adds a `drawerTab` state local to
  Chat.svelte. Registers the `COOKBOOK_CHANGE_EVENT` listener in
  its `onMount` so a model-driven save refreshes the Recipes tab
  live.
- **Settings** (`./settings.md`) — no settings yet; cookbook-wide
  preferences (default servings, preferred unit system) would land
  on `profiles.settings` if and when we grow them.
- **Memory** (`./memory.md`) — scope contrast. A memory is "something
  about the user"; a recipe is "an item the user owns". Share the
  RLS posture and the tool-registry pattern; don't share data.

## Gotchas

- **Inline parser, not a dep.** We deliberately skipped
  `@cooklang/cooklang-ts`. The Cooklang spec is small and stable,
  and owning the parser means a spec tweak doesn't block on an
  upstream release. If the parser ever needs to handle recipe
  references or shopping-list blocks, revisit — but today every
  line of `src/lib/cooklang.ts` is straightforward.
- **`notifyCookbookChanged` is the tools → UI bridge.** Tools don't
  import anything from the UI layer; they fire a `window`
  `CustomEvent`. The Cookbook modal and the drawer tab subscribe.
  Adding direct imports the other way would create a cycle —
  don't.
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
- **No embeddings.** ILIKE on `title` is fine at cookbook scale. If
  a user ever needs semantic search, the escape hatch mirrors
  memories exactly: add `embedding vector(2048)` + claim columns +
  the worker-claim RPC pattern. Don't pre-emptively wire it.
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
- **Dash-only section reset.** A line whose non-whitespace content is
  only dashes (2+, e.g. `--`, `---`) clears the current `section`. Used
  to end a cookbook-style declaration block so the instructions below
  don't inherit the last `# Section` heading. The check runs BEFORE
  line-level `--` comment stripping (otherwise the dashes would
  collapse to empty and be indistinguishable from a blank line). This
  is an additive extension — a dash-only line used to be a no-op
  comment, so no existing recipe parses differently.
