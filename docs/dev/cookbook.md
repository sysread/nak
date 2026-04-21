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
  `recipe_update.ts`, `recipe_delete.ts` — the five LLM tools.
  Mutating tools fire `notifyCookbookChanged` on success.
- `src/lib/supabase.ts` — `Recipe` type + `createRecipe / updateRecipe
  / deleteRecipe / getRecipe / listRecipes` methods. Lives between
  the memory methods and the background-worker pipeline block.
- `src/screens/Cookbook.svelte` — three-pane modal (list, detail,
  edit). Mirrors `Settings.svelte`'s shell / escape / click-outside-
  to-close conventions; styles scoped locally rather than added to
  `styles.css` because the modal is an island.
- `src/screens/Chat.svelte` — drawer tab switcher (`drawerTab`),
  Recipes list rendering, footer book icon, Cookbook modal mount,
  `COOKBOOK_CHANGE_EVENT` listener in `onMount`.
- `src/styles.css` — `.sidebar-tabs`, `.sidebar-tab`,
  `.recipe-drawer-list`, `.recipe-drawer-footer`. The tab pair styles
  live with the rest of the sidebar chrome.

## Entry points

- **Footer book icon** in the sidebar → opens the Cookbook modal on
  the list pane.
- **Recipes tab** in the drawer → lazy-loads the list (first click
  fetches from Supabase; subsequent switches are free). Clicking a
  row opens the Cookbook modal on the detail pane for that id via
  the `initialRecipeId` prop.
- **LLM tool calls** — `recipe_save / list / get / update / delete`.
  Gated behind `toggle_tools` like the memory tools.

## Data model

- `public.recipes` table (see `supabase/schema.sql`):
  - `id uuid`, `user_id uuid`, `title text not null`,
    `source text`, `source_url text`, `cooklang text not null`,
    `created_at`, `updated_at`.
  - Index: `recipes_user_updated_idx (user_id, updated_at desc)`.
  - RLS: four self-* policies (select / insert / update / delete),
    same shape as `memories`.
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
