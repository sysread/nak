# Recipe Records Implementation Plan

Status: PROPOSED - not yet built. Scope decisions resolved in
discussion 2026-10-12; they are recorded at the end of this plan
("Decisions"). Nothing here has landed.

Read [`../cookbook.md`](../cookbook.md) first; this plan assumes its
data model, toolbox vocabulary, and realtime relay. The design is a
deliberate port of the wiki records feature (["wiki_records (the
dated journey layer)" in `../wiki.md`](../wiki.md)) onto
recipes: same table shape, same tool split, same UI section
anatomy. Where the cookbook differs (version snapshots already
exist, rating is user-only), the deltas are called out.

## SYNOPSIS

A cooking log attached to recipes: dated records capturing
iterations, notes, successes and failures, what went right and
wrong, and ideas for variations. Ships with chat tools to search and
CRUD them and a Records section in the Cookbook detail pane.

## PURPOSE

The cookbook stores a recipe's **current state**: the cooklang
source, the rating, the photos. `recipe_versions` snapshots content
edits and the History panel answers "what changed and when", but a
version row records THAT the source changed, not WHAT HAPPENED when
the user cooked. There is no home for the journey: "baked it
2026-10-04, crumb came out gummy, ferment longer next time" or
"idea: brown butter variant". The prod `recipes` table has no notes
column (verified), so this is greenfield, not a migration.

Wiki already solved this exact shape: the article body is the
current state, `wiki_records` are the dated journey. This plan ports
that design. The body/records separation carries over cleanly: the
recipe (cooklang) is the distilled current state; a record is one
dated event. Learnings accumulate in records and get folded into
the recipe by editing the cooklang, but records survive promotion.

## DESCRIPTION

### How the relevant code behaves today

- `public.recipes` is the denormalized current-state row
  (title, cooklang, source, rating, bookmark flags). Every content
  mutation funnels through the `recipe_create_with_version` /
  `recipe_update_with_version` RPCs, which snapshot into
  `recipe_versions` atomically.
- Bookmark flags (`upcoming`, `favorite`) are direct updates that
  deliberately bypass versioning and do not bump `updated_at`, so
  the recency sort stays stable. Recipe record writes must behave
  the same way (see "What records are NOT").
- The `recipes` embedding quartet feeds the drawer's embed-then-merge
  search via `search_recipes_by_embedding` + ILIKE merge
  (`searchRecipes`); the LLM path stays ILIKE-on-title via
  `recipe_list`.
- Recipe writes reach the UI through the `subscribeToRecipeChanges`
  realtime relay, not in-process notifications.
- Wiki records (the template) are documented in
  [`../wiki.md`](../wiki.md) and QA'd in
  [`../../qa/use-cases/wiki-records.md`](../../qa/use-cases/wiki-records.md).

### Data model: `recipe_records` (new table)

Mirrors `wiki_records` (see wiki.md, "wiki_records (the dated
journey layer)"), with `recipe_id` in place of `article_id`:

- `id uuid pk`, `user_id uuid not null references auth.users on
  delete cascade`.
- `recipe_id uuid not null references public.recipes on delete
  cascade` - a record always belongs to exactly one recipe and dies
  with it. Deliberately NO uniqueness constraint: many records per
  recipe, and two records on one date (morning bake, evening bake),
  are the point.
- `date date not null` - the day the cook happened, distinct from
  `created_at` (when the row was written). Lists sort `date desc,
  created_at desc` (the created_at tie-break matters; two cooks on
  one date are a normal case).
- `content text not null` (Markdown) - what happened: the iteration,
  observations, what went right and wrong.
- `tags jsonb not null default '[]'` - freeform keyword array for
  filtering ("variation", "rye", "less-salt"); GIN-indexed below.
- `created_at` / `updated_at timestamptz not null default now()` -
  `updated_at` is trigger-stamped, never client-set.
- `outcome text null` - optional enum `success | mixed | failure`
  with a check constraint, null meaning "not classified". This is
  the one deliberate divergence from wiki records: "historical
  success and failures" is a stated purpose of the feature, and a
  filterable outcome column ("show me my failures") beats parsing
  prose for it.
- `source_conversation_id uuid references threads on delete set
  null` - provenance: which discussion produced the record. The
  chat tools stamp it from the thread the tool call runs in; hand
  adds in the UI leave it null. Set null (not cascade) so deleting
  the source thread keeps the record; the event still happened.
- Same embedding quartet as `recipes` and `wiki_records`
  (`embedding vector(2048)`, `embedding_model`,
  `embedding_claim_holder`, `embedding_claim_expires`). Embed input
  is `date + content` (`buildRecipeRecordEmbedInput`); tags and the
  outcome are excluded so they can't dominate the vector.
- Indexes: `(recipe_id, date desc)` (the per-recipe log),
  `(user_id, date desc)` (cross-recipe chronological), and a GIN
  index on `tags`. No ANN index - rows are claimed by an
  `updated_at`-ordered scan, same as wiki records.
- Triggers: `touch_recipe_record_updated_at` (BEFORE UPDATE stamps
  `updated_at`; two surfaces write records - the browser and the
  edge tools - and neither can be trusted to set it) and
  `clear_recipe_record_embedding_on_change` (nulls
  the embedding/claim columns when `content` or `date` changes).
- Member of `supabase_realtime` with an `(id, user_id)` replica
  identity index so DELETE events reach the browser's user-filtered
  subscription (the same gotcha as wiki records).
- Embedding RPCs `claim_next_pending_recipe_record` /
  `save_recipe_record_embedding_if_claimed` /
  `search_recipe_records_by_embedding`, clones of the wiki record
  trio with the same `for update skip locked` claim discipline -
  with one delta: the search RPC takes optional `recipe_id` and
  `outcome` params so filtering happens inside the RPC before the
  limit (the wiki twin's search has no filter params, and
  post-filtering a capped result mangles the counts). The ILIKE leg
  applies the same filters.
  `recipe-records` joins `EMBED_SOURCES`
  (`supabase/functions/_shared/embed-input.ts`) so the existing
  generic backfill loop drains it. No new cron.
- RLS: four self-* policies, same shape as `recipes`.
- Grants: nothing per-table; the idempotent grant block at the end
  of schema.sql covers new tables.

Limits: `MAX_RECIPE_RECORD_CONTENT_CHARS = 8000`,
`MAX_RECIPE_RECORD_TAGS = 24`, `MAX_RECIPE_RECORD_TAG_CHARS = 40`
(wiki's caps). New constants live in a new
`supabase/functions/_shared/recipe-record-limits.ts`, imported
browser-side via the `$shared` alias. This extends the existing
`_shared` limits pattern (`supabase/functions/_shared/wiki-limits.ts`,
the edge-side consolidation of wiki's caps), which currently carries
only the content cap; the recipe file carries all three so the tag
caps never re-duplicate.

### What records are NOT

- **Not `recipe_versions`.** A version snapshots the cooklang source
  when recipe content changes; a record is a dated entry about a
  cook or an idea. Record writes never create version rows, never
  touch `recipes.updated_at` (the recency sort stays stable, like
  bookmark toggles), and never clear the recipe's embedding
  (cooklang unchanged, so the `clear_recipe_embedding_on_change`
  trigger does not fire; the grocery-list trigger also watches only
  cooklang and is unaffected).
- **Not rating changes.** The rating stays user-only
  (`recipe_save` rejects it today). A record may *mention* an
  outcome in prose and carry the `outcome` enum; the stars on the
  recipe card move only through the UI.
- **Not touched by revert.** A recipe revert is a normal update
  whose patch comes from a past version row; it writes a new
  version and never reads or writes records. The log survives a
  content revert by construction.
- **Not topic-tagged.** Recipes carry a curated `topics text[]`
  maintained by the server-side topics unit, which reads only
  title/cooklang and never looks at child tables. Records keep
  freeform tags; the drawer's topic filter does not reach them.

### Chat tools (six new)

Wiki owns the `record_*` names, so recipe records get the
`recipe_record_*` prefix (explicit, greppable, no collision).

Capture is manual by design: the model logs records during cooking
discussions (the tool call IS the capture path - there is no
background sweep), and the user can add records by hand in the UI.
That moves the discipline the wiki puts in its sweep prompts into
prompt surfaces - including the trigger the sweep used to own.
`recipe_record_create`'s description tells the model WHEN to log,
not just how: when the user reports having cooked the recipe and
how it went, log the record and say so in the reply (use the day
it happened, not today); when it is unclear which recipe is meant
or whether a real cook happened, ask instead of guessing. The
same trigger sentence rides the `cookingToolbox` description,
which IS catalog-visible (the catalog renders only toolbox
descriptions and per-tool short descriptions, never full tool
descriptions). After logging, fold any resulting recipe change (a
tweak to the cooklang) into a separate `recipe_save` edit so the
History panel keeps the two apart. There is deliberately no
cookbook narrative block in the system prompt (none exists today;
wiki has a curated WIKI_BLOCK, recipes have never had one) - the
toolbox + tool descriptions carry capture instead, the same shape
the followups toolbox uses for its proactive capture. And no UI
nudge yet ("Done cooking" offering to log is a natural follow-on;
see Scoped out). Revisit both if capture-by-discussion proves
unreliable.

- **Dedup guard on create**: before `recipe_record_create`, check
  `recipe_record_list` on the recipe for the same EVENT, not the
  same date - if the event is already logged, `recipe_record_update`
  it instead of stacking a duplicate; two cooks on one day are
  separate records (the wiki twin learned this distinction in
  production).
- **Merge, don't duplicate, on update** (carried in
  `recipe_record_update`'s description): details arrive piecemeal
  ("the crumb was actually fine on day two"). `recipe_record_get`
  the record first and pass the merged body; `content` is a
  full-replacement patch, so an update that omits it leaves the
  body untouched.

Reads - join `alwaysOnToolbox`, mirroring how wiki's record reads
ride always-on:

- `recipe_record_list` - one recipe's log. Params: `recipe_id`
  (required), optional `from_date` / `to_date` (the `record_list`
  param naming), `tags` (array, AND semantics - the `record_list`
  shape), `outcome` (`success | mixed | failure`), `limit`.
- `recipe_record_get` - one record by id.
- `recipe_record_search` - semantic search across every recipe's
  records, optional `recipe_id` scope, optional `outcome` filter.
  Merge semantics come from `searchWikiRecords`
  (`wiki-records.ts`): embed + ILIKE-on-**content** (recipes' own
  `searchRecipes` ILIKEs on title - records have no title), dedup
  by id, capped, with its empty-query short-circuit. The edge tool
  gaining an ILIKE leg at all is a deliberate divergence from the
  wiki twin's `record_search` (semantic-RPC only, empty on
  embedder failure) so the tool stays useful with the embedder
  down. The `recipe_id` scope and `outcome` filter are further
  deltas: the outcome param is what makes "show me my failed
  bakes across everything" a filter and not prose parsing - the
  cross-recipe journey the outcome column exists for.

Writes - join `cookingToolbox`:

- `recipe_record_create` - `recipe_id`, `date` (ISO `YYYY-MM-DD`,
  read from the conversation, not assumed today), `content`,
  optional `tags`, optional `outcome`. Stamps
  `source_conversation_id` from the thread the tool call runs in.
- `recipe_record_update` - `id` plus at least one of `date`,
  `content`, `tags`, `outcome`; omitted fields unchanged, `tags`
  replaces the whole array (the `record_update` patch shape).
- `recipe_record_delete` - `id`.

Wire schemas: `src/lib/tools/recipe_record_*.schema.ts` (schema-only
exports, with `formatArgs` overrides mirroring `record_create`'s so
the tool-call pill renders date/outcome as a header and the Markdown
body as a section). Edge impls:
`supabase/functions/venice/tools/recipe_record_*.ts`. Toolbox
membership is asserted in `tests/tools.test.ts` (the existing
tripwire).

### UI: Records section in the Cookbook detail pane

The Cookbook modal's detail pane gains a Records section (the
article view's Records section is the anatomy), rendered by a new
`src/components/RecipeRecords.svelte`. Placement: at the bottom of
the detail pane, below the History panel - the article view renders
Records at the bottom too, and the reading order "recipe, then its
history, then its log" is the narrative.

- **Add form**: date, content (Markdown), comma-separated tags,
  outcome selector.
- **Rows**: date ("Mon D, YYYY"), outcome chip, tag chips, truncated
  preview; a row expands to the full content with Edit / Delete.
- **Filters**: from/to date range, tag dropdown, outcome dropdown,
  and a semantic search box (debounce + abort-controller supersede
  wired like RecipeList's search; the merge itself is
  `searchWikiRecords`' shape - see the search tool above). Search
  results bypass the date/tag filters by design (the twin's
  behavior), but an outcome selection is NOT dropped: a set
  outcome dropdown is passed into the search call as its `outcome`
  param, so "failures about X" works in the UI, not just via the
  tools.
- **Search scope: cross-recipe, decided.** The search box searches
  every recipe's records (mirroring `recipe_record_search`), not
  just the open recipe's log; a hit on another recipe is annotated
  with that recipe's title (resolved from the cookbook store's
  loaded sets, with the by-id fallback fetch the routed-recipe
  path already uses - the twin's bare "(other article)" label is
  not enough once hits are clickable) and clicking it navigates
  the detail pane to that recipe through the modal's routed-recipe
  resolution (`route.recipe` from `src/lib/routing.svelte.ts`).
  Navigation resets the search and
  filters (the twin's remount-on-switch pattern), and the target
  row is scroll-highlighted on arrival (promoted into M2 by the
  round-4 review: without it the user clicks a specific hit and
  lands blind at the top of another recipe's log). Searching the
  whole cooking log from any recipe is the point; per-recipe
  narrowing is the filters' job.
- **Export**: single record to `yyyy-mm-dd-<slug>.md` with
  date/tags/outcome front matter, and Export all to a zip holding
  `recipe.md` plus one `records/` entry per record (wiki's Export
  all shape; the recipe itself has only single-file exports today).
  The export helpers live in a new recipe-typed
  `src/lib/recipe-records-export.ts` (a sibling of
  `src/lib/wiki-export.ts`, which is article-typed), reusing the
  twin's filename-collision dedup (it appends a numeric suffix,
  starting at `-2`, for same-date records).
- **Offline**: records stay online-only, but reads degrade soft:
  offline, the section keeps rendering its last fetch (a mid-cook
  "what did I note last time" still works on the open recipe) and
  disables the add/edit/delete controls with copy, the way the
  bookmark controls degrade. The filter and search controls
  disable too - both are server queries, and a failed refetch
  must not look like an empty log. A fresh load with nothing yet
  fetched (no cached rows) shows a distinct offline-no-data line,
  keyed off the offline status Cookbook.svelte already computes -
  never the "no records yet" empty state, which would lie about
  the log being empty. This is a deliberate improvement over the
  twin, whose Records section simply renders empty offline (the
  divergence is stated per the non-conforming-code rule). The
  records relay does NOT call `syncOfflineCache` - records join no
  IndexedDB mirror.

Supporting moves:

- Mount point: `src/screens/Cookbook.svelte` renders the section in
  the detail pane (it already computes the offline state the
  bookmark controls use, and already hosts the History panel
  Records sits below).
- Recipe delete names the log cost. The cookbook's delete
  confirmation is a `window.confirm` (not an inline strip); its
  message gains "This deletes the recipe and its N records", with
  N from a head-count query at confirm time (the section's loaded
  row count can be filtered or stale). With no changelog
  (decision 2), the cascade delete of the log is silent everywhere
  else - this is the one place it is announced.
- Data layer: `src/lib/supabase/recipe-records.ts`, plain async
  functions taking the shared client (the `wiki-records.ts` shape:
  no class, no state), one-for-one delegation from the
  SupabaseService facade. Row types + coercer (`RecipeRecord`,
  `coerceRecipeRecord`) in `src/lib/supabase/types/cookbook.ts`
  (the module's first coercer - recipes are cast raw today; wiki's
  coercers live in `types/wiki.ts`).
- Realtime: `subscribeToRecipeRecordChanges` in `realtime.ts` (a
  clone of `subscribeToWikiRecordChanges` over `recipe_records`),
  wired in `Chat.svelte` alongside the existing relays, publishing
  a `nak:recipe-records:changed` window event through
  `src/lib/cookbook-events.ts` (the same emit/on pair shape the
  cookbook already uses); RecipeRecords.svelte listens and
  refetches, so agent-side record writes land live.
- Screen primitives: `src/lib/ui/recipe-records.ts`, pure helpers
  (filter predicates, outcome chip labels and colors, export
  filename slugs), unit-tested next door.

## Milestones

- **M1 - Schema + data layer.** Table, triggers, RLS, the two
  realtime deliverables (publication membership + the
  `(id, user_id)` replica-identity index - omit either and M2's
  relay silently receives nothing, the exact failure the wiki
  gotcha documents), embedding RPCs, `EMBED_SOURCES` entry,
  `_shared/recipe-record-limits.ts`, types, SupabaseService slice,
  and `subscribeToRecipeRecordChanges` in `realtime.ts` (data-layer
  work, so M2's wiring has something to call). Two required test
  edits land here: `supabase/functions/tests/embed-input.test.ts`
  asserts `EMBED_SOURCES`' name list by exact equality, and
  `tests/realtime-subscribe.test.ts` pins every realtime helper's
  topic contract. Gate: `mise run sync` green, the backfill embeds
  a seeded record, unit tests pass.
- **M2 - UI.** The Records section in the detail pane (mounted by
  Cookbook.svelte): add / edit / delete, filters, cross-recipe
  search with navigation + scroll-highlight of the clicked hit,
  export module, offline degradation, realtime refresh wired
  through `Chat.svelte` + `cookbook-events.ts`.
- **M3 - Chat tools.** Six tools wired into the two toolboxes and
  registered in the edge tool barrel
  (`supabase/functions/venice/tools/index.ts`), shared edge helpers
  in a new `venice/tools/_recipe_record_helpers.ts` (the
  `_record_helpers.ts` clone: column list, date/tag normalizers,
  ownership pre-check, plus outcome normalizing), formatArgs, the
  capture trigger + dedup/merge guards in the descriptions, the
  two toolbox description strings (they enumerate members), the
  edge tools' b-strict specifics carried from the twin (explicit
  `user_id` on insert, and a parent-ownership pre-check so a
  record can only be written to a recipe the calling user owns),
  validation per the house convention (the dispatcher's central
  `validateToolArgs` handles the mechanical schema checks the
  browser-declared schemas already carry; per-tool semantic checks
  - date format, outcome enum, update's at-least-one-of - use the
  `ArgErrors` accumulator, never a first-fail throw), the capture
  trigger on the `cookingToolbox` description (catalog-visible;
  see "Chat tools"), one stale-comment fix while in the barrel:
  `recipe_delete.ts`'s header comment enumerates the cascade
  children and gains `recipe_records`, docs, QA use-case run end
  to end.

## Testing

- `tests/recipe-records.test.ts`: coercers, filters, chip labels,
  export filenames (plain vitest, stubbed client, mirroring the
  wiki-records tests).
- `tests/tools.test.ts`: three loops updated for the six new
  tools - the cookingToolbox membership array (writes), the
  always-on read list (`toContain`), and the no-writes-leak loop
  (records writes must not appear outside the cooking toolbox).
- Edge handler tests modeled on
  `supabase/functions/tests/recipe_save.test.ts` (the existing
  recipe-tool handler template; note wiki's record handlers have
  no edge test file to mirror - `wiki.test.ts` covers toolbox
  composition and prompt invariants only): create/update/delete
  handlers, argument validation, `source_conversation_id` stamping.
- `tests/schema-dml-columns.test.ts`: the floor assertions are
  `>=` comparisons, so adding a table cannot trip them upward -
  the suite should simply stay green over the new DML. A floor
  failing DOWNWARD is a scanner regression, not this change.
- The planned unit tests are all DOM-free (coercers, filters,
  chips, filenames - the twin `tests/wiki-records.test.ts` is not
  registered either), so no `environmentMatchGlobs` entry is
  needed in `vite.config.ts`.
- QA use-case: `docs/qa/use-cases/recipe-records.md`, mirroring
  `wiki-records.md` minus the sweep step, PLUS steps the twin
  never had - the chat tools are the primary capture path now, so
  the walkthrough covers: the chat-capture journey (tell the model
  a bake happened; the reply names the new record; opening the
  modal shows it, which doubles as the realtime-relay proof; a
  second report of the same event exercises the dedup guard; a
  detail correction exercises the get-then-merge update), the
  outcome filter end to end (set via tool and via the dropdown,
  including the failure-across-recipes search), cross-recipe
  search click-through + scroll-highlight, the delete confirm's
  "N records" count, export, embedding backfill, and the offline
  degradation (stale rows visible, writes and filter/search
  controls disabled, offline-no-data line on a fresh load). Index
  it in `docs/qa/README.md`'s use-case list.
- Docs: `../cookbook.md` gains a Records section; the user-facing
  doc `docs/user/cookbook.md` gains the "why records vs History
  panel" story (the `docs/user/` update is mandatory in the same
  PR, not optional); `docs/dev/offline-cache.md`'s Interactions
  ledger gains the "recipe records are online-only, degrade soft"
  line (the dev-docs rule: a feature coupling to another feature's
  ledger must update it).

## Scoped out (deliberately)

- **Per-record photos** (the `wiki_record_files` analog: "photo of
  how the loaf came out" hung on a specific bake). Recipe photos
  already exist at the recipe level; the per-record variant is a
  natural follow-on that clones the persistent-bucket +
  content-hash-dedup design. Deferred.
- **Record-to-record links** (the `wiki_record_links` analog:
  "this bake was a variation of that one" chains). Deferred with
  photos.
- **`recipe_changelog`.** Wiki records land a best-effort changelog
  row per write. The cookbook's audit story is the History panel,
  which stays content-only. Resolved 2026-10-12: no changelog in
  v1; revisit if silent record deletion (no audit trail) ever
  matters.
- **Extraction sweep.** The `agents/wiki_records.ts` analog (an
  hourly agent claiming settled conversations and logging cooks as
  records) was considered and rejected 2026-10-12: capture happens
  manually, when Jeff discusses a bake with the model and it calls
  `recipe_record_create`, or by hand in the UI. No thread pointer
  columns, no claim RPCs beyond the embedding ones, no cron, no
  settings toggle. If capture-by-discussion proves unreliable
  (records forgotten or misdated), revisit then.
- **Offline cache.** Records stay online-only in v1; the section
  degrades soft offline (reads render the last fetch, writes and
  filter/search controls disable with copy). The favorite/upcoming
  offline reconcile is untouched - records join no IndexedDB
  mirror.
- **A capture nudge from cooking mode.** Ending a cooking session
  ("Done cooking") is the app's most reliable "a bake just
  happened" moment, and the section could offer to log a record
  there. Deliberately not in v1: the model-side trigger (in
  `recipe_record_create`'s description) plus the manual form carry
  capture first. Add the nudge if capture-by-discussion proves
  spotty.
- **No history tools** for recipes, unchanged from the existing
  position (revert and History are user-directed UX).

## Decisions (resolved 2026-10-12)

The four scope questions this plan started with, resolved with
Jeff; recorded so a future session does not re-litigate them.

1. **Outcome column: YES.** Nullable `success | mixed | failure`
   enum, check-constrained, filterable in the UI, optional param on
   the write tools. "Show me my failures" is a filter, not prose
   parsing. Tags stay freeform for everything else.
2. **Changelog for record ops: NO in v1.** Records are themselves a
   diary; the History panel stays content-only; a `recipe_changelog`
   table plus a Cookbook-wide panel is real surface for little gain
   at single-user scale.
3. **Extraction sweep: NOT AT ALL.** Capture is manual by design -
   the model logs records during cooking discussions via the tools,
   the user can also add by hand in the UI. The write tools carry
   the dedup/merge discipline (see "Chat tools"). No cron, no
   thread pointer columns, no settings toggle.
4. **Tool naming: `recipe_record_*`.** Explicit, matches the wiki
   vocabulary the model already knows, zero collision with the wiki
   `record_*` tools.
5. **UI record search is cross-recipe** (surfaced by the round-1
   review): the Records section's search box searches every
   recipe's log, annotates hits from other recipes, and navigates
   the detail pane on click. The per-recipe narrowing job belongs
   to the date/tag/outcome filters.
6. **Refinement resolutions (round 2):** capture logs directly and
   says so in the reply (no confirmation round-trip; ask only when
   the cook report is ambiguous), matching how Jeff described
   using it; a cross-recipe hit click navigates and resets
   search/filters (the twin's remount pattern); offline keeps reads
   on the last fetch and disables writes (cooking is the most
   offline-prone context in the app).
