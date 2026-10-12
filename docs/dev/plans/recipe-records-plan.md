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
`_shared` limits pattern (`supabase/functions/_shared/wiki-limits.ts`):
of the wiki record caps, only the content cap is consolidated
there today - the tag caps live in `_record_helpers.ts` and the
extraction agent - so the recipe file carries all three from the
start and the tag caps never re-duplicate. The direction (browser
imports the `_shared` file as canonical, rather than the file
mirroring the browser) matches the `$shared/cooklang-validate`
precedent and is deliberate - do not "fix" it back to mirroring.

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
- **Not versioned.** While the user views a past version in the
  History panel, the Records section below keeps showing the
  current log - records hang off the recipe, not any version
  row. Stated so the mixed view does not read as a bug later.

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
  production). The guard is prompt-only (there is no cleanup agent
  - see decision 3), and the wiki's measured leak rate under
  prompt-only discipline was real (~8/127 redundant records in
  three weeks, sweep + librarian defenses notwithstanding). The
  mechanical backstop rides the tool result: create never refuses
  (two records on one date are legitimate - a semantic-dedup
  refusal would contradict that), but the create result carries
  the recipe's same-date sibling records alongside the new row -
  AND the recipe's most recent prior record (date + preview),
  because the wiki gotcha's second duplicate shape is a later
  conversation re-describing yesterday's event, which same-date
  siblings cannot catch. The model sees the likely duplicate in
  the same turn without a second call. The plan accepts a higher duplicate rate
  than the wiki's (no sweep, no librarian) as the price of no
  sweep.
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
  cross-recipe journey the outcome column exists for. With an
  empty `query` the edge tool throws (matching the twin; the
  empty-query short-circuit lives in the data-layer merge the UI
  search box uses).

Writes - join `cookingToolbox`:

- `recipe_record_create` - `recipe_id`, `date` (ISO `YYYY-MM-DD`,
  read from the conversation, not assumed today), `content`,
  optional `tags`, optional `outcome`. Stamps
  `source_conversation_id` from the thread the tool call runs in.
- `recipe_record_update` - `id` plus at least one of `date`,
  `content`, `tags`, `outcome`; omitted fields unchanged, `tags`
  replaces the whole array (the `record_update` patch shape).
  Passing `outcome: null` counts as the one-required-field and
  clears the classification; the UI's outcome selector gets an
  "unclassified" option to match.
- `recipe_record_delete` - `id`.

Wire schemas: `src/lib/tools/recipe_record_*.schema.ts` (schema-only
exports, with `formatArgs` overrides mirroring `record_create`'s so
the tool-call pill renders date/outcome as a header and the Markdown
body as a section, and a `shortDescription` on each - the ToolDef
type requires it and the catalog renders it verbatim). Edge impls:
`supabase/functions/venice/tools/recipe_record_*.ts`. Toolbox
membership is asserted in `tests/tools.test.ts` (the existing
tripwire).

### UI: Records section in the Cookbook detail pane

The Cookbook view's detail pane gains a Records section (the
article view's Records section is the anatomy), rendered by a new
`src/components/RecipeRecords.svelte`. Placement: at the bottom of
the detail pane, below the History panel - the article view renders
Records at the bottom too, and the reading order "recipe, then its
history, then its log" is the narrative. (Older docs call the
surface a "modal"; the component renders inline in the chat shell
today - the plan fixes that wording in cookbook.md rather than
inheriting it.)

- **Add form**: date, content (Markdown), comma-separated tags,
  outcome selector. The compose/edit draft AND the expanded-row
  state RESET when the open recipe id changes (a kept draft
  would silently retarget to the newly opened recipe and save a
  record against the wrong recipe
  - the one-keystroke retype is the cheap loss; the
  misattribution is not; the expanded row the twin cleared for
  free via its keyed remount).
- **Rows**: date ("Mon D, YYYY"), outcome chip, tag chips, truncated
  preview; a row expands to the full content with Edit / Export /
  Delete (the twin's expanded-row shape).
- **Filters**: from/to date range, tag dropdown, outcome dropdown,
  and a semantic search box (debounce + abort-controller supersede
  wired like RecipeList's search; the merge itself is
  `searchWikiRecords`' shape - see the search tool above). The
  combined filter rule: outcome applies in BOTH browse and search
  modes (a set outcome dropdown is passed into the search call as
  its `outcome` param, so "failures about X" works in the UI,
  not just via the tools); date/tag apply to browse only - search
  results bypass them by design (the twin's behavior), so the
  twin's hide-filters-while-searching block gets SPLIT: date/tag
  controls hide during a live search (the twin's mechanism; the
  search box's clear-on-empty is the only exit needed, matching
  RecipeList), the
  outcome dropdown renders and stays live in BOTH modes. An empty
  search box clears results back to browse (RecipeList's
  clear-on-empty); the search result cap is a named tunable next
  to RecipeList's `RECIPE_SEARCH_LIMIT`, not a hardcoded number.
  Changing
  the outcome dropdown while results are live re-runs the search
  through the same debounce/abort controller (an outcome change
  that only refetched the log would silently stop affecting the
  displayed results); with no live search it just refetches the
  log. Relay events re-run a live search through the same
  controller, so a record-writing chat turn cannot thrash the
  search.
- **Search scope: cross-recipe, decided.** The search box searches
  every recipe's records (mirroring `recipe_record_search`), not
  just the open recipe's log; a hit on another recipe is annotated
  with that recipe's title (resolved with one batched
  `.in('id', hitRecipeIds)` title query per result set - not one
  read-through call per hit; a miss means the recipe is gone,
  rendering "(deleted recipe)" with a no-op click, since a saved
  result set can outlive a recipe; the twin's bare "(other
  article)" label is not enough once hits are clickable) and
  clicking it navigates
  the detail pane to that recipe through the view's routed-recipe
  resolution (`route.recipe` from `src/lib/routing.svelte.ts`).
  Navigation KEEPS the query and its results (a cross-recipe
  search lives to survive its first click - "failed rye bakes
  across everything" is a multi-hit journey, and clearing the
  query on navigation would turn it into search, click, re-type,
  click, re-type); only the date/tag filters reset (they are
  per-recipe narrowing, meaningless once another recipe is open).
  Keeping the query needs the section MOUNTED across navigation,
  which is a real design constraint, not a freebie: the detail
  pane gates on `{#if activeRecipe}`, and `activeRecipe` is
  undefined while the by-id fallback fetch resolves a recipe
  outside the loaded drawer window - the common case for
  cross-recipe hits in a multi-page cookbook. RecipeRecords
  therefore mounts on "detail pane open AND a recipe id
  selected", NOT inside that gate: the section needs only the id
  to fetch its log (the recipe title for the export zip arrives
  as a nullable prop). It also must not be keyed by recipe id;
  only the per-recipe log refetches. (Found in round 8: inside
  the gate, the first hit on an old recipe would unmount the
  section mid-navigation and silently kill query, results, and
  highlight.) Because the Records section sits below History,
  the navigation also scrolls the section into view, and the
  scroll-highlight marks the clicked hit inside the
  still-visible results list - "you are here" (promoted into M2
  by the round-4 review: without both, the user lands at the top
  of the pane, blind to the results). Relay events re-run the
  active search when one is live (the twin just refetches the
  log and lets its results go stale; with results this
  long-lived, staleness would show records deleted by a tool
  turn). A hit whose recipe was deleted after the search saved
  resolves at CLICK time: a hit on an offline-cached recipe
  still opens (the read-through decides - clicks always
  navigate); a resolved null while online re-renders the hit row
  "(deleted recipe)" with a no-op click, and the title batch is
  not re-run for the whole set. Offline-uncached hits open onto
  the pane's offline-no-data state. The label consults offline
  status first (`getRecipeCached` returns null for
  offline-uncached and fetch errors too): offline
  or errored shows the offline/no-data treatment, and
  "(deleted recipe)" only for a resolved null while online.
  Clicking a hit on the OPEN recipe (navigation is a no-op)
  still fires the scroll-into-view + highlight. The scroll pins
  to after the pane's resolution settles and the log refetch
  lands - a scroll issued at click time would land on a section
  that the body render then pushes out of view. Searching the
  whole cooking log from any recipe is the point; per-recipe
  narrowing is the filters' job. Outcome survives navigation
  ONLY while a search is live (resetting it then would desync
  the dropdown from the displayed results); in browse mode it
  resets with date/tag on any recipe-id change - a surviving
  failure-filter would read as "recipe B has almost no
  history". Date/tag reset on EVERY navigation path (hit click
  or sidebar click), keyed on the open recipe id changing.
  During the resolution window the
  pane's placeholder would lie ("Recipe not found." for a recipe
  that exists), and on this hot path (a hit on a recipe outside
  the loaded drawer window) it lies often - so the pane placeholder
  becomes the existing unit-tested primitive
  `missingRecordMessage({ fetching, online, noun: 'recipe' })`
  (`src/lib/ui/offline-status.ts`, already consumed by the wiki
  pane): a loading state while the by-id fetch resolves, an
  offline-cache-miss state, and "Recipe not found." only on a
  resolved null. None of the three moves the
  section, so the round-8 unmount bug stays fixed. The known
  live-search losses are accepted and match the twin: entering
  the edit pane, deselecting back to the list pane, and leaving
  the Cookbook view all unmount the section and clear the query.
- **Export**: single record to `yyyy-mm-dd-<slug>.md` with
  date/tags/outcome front matter, and Export all to a zip holding
  `recipe.md` plus one `records/` entry per record (wiki's Export
  all shape; recipes have no file downloads at all today -
  copy-to-clipboard only - so this is the cookbook's first).
  Export all ignores the active filters/search and exports the
  full log - a DIVERGENCE from the twin, verified against source
  after two review rounds disagreed: the twin's Export all passes
  `records`, which `load()` has already server-filtered by
  date/tag (its "always the full set" comment means "not search
  results"), so the twin respects date/tag filters and ignores
  only search. Recipes export the whole diary by design; state
  the divergence per the non-conforming rule so nobody "fixes" it
  back after reading the twin. Like the twin, Export all hides at
  zero records. The section
  receives the resolved `Recipe | null` (nullable exactly during
  the resolution windows above, not a bare title - `recipeToMarkdown`
  needs title + cooklang + source), and Export all disables while
  it is null.
  The export helpers live in a new recipe-typed
  `src/lib/recipe-records-export.ts` (a sibling of
  `src/lib/wiki-export.ts`, which is article-typed), reusing the
  twin's filename-collision dedup (it appends a numeric suffix,
  starting at `-2`, for same-date records).
- **Offline**: records stay online-only, but reads degrade soft:
  offline, the section keeps rendering its last fetch FOR THE SAME
  recipe. The rows are keyed by the recipe id they were fetched
  for, and that keying governs navigation everywhere: online, an
  id with no cached fetch renders the loading state - never
  another recipe's rows. Offline, navigating to another recipe
  shows the offline-no-data line, not the previous recipe's log
  under a new title. A mid-cook "what did I note last time" on
  the open recipe still works. The
  add/edit/delete controls disable with copy, the way the
  bookmark controls degrade. The filter and search controls
  disable too - both are server queries, and a failed refetch
  must not look like an empty log. A fresh load with nothing yet
  fetched (no cached rows) shows that same offline-no-data line,
  keyed off the offline status Cookbook.svelte already computes -
  never the "no records yet" empty state, which would lie about
  the log being empty. This is a deliberate improvement over the
  twin, which surfaces a load error on a failed records fetch
  (the divergence is stated per the non-conforming-code rule). The
  records relay does NOT call `syncOfflineCache` - records join no
  IndexedDB mirror.

Supporting moves:

- Mount point: `src/screens/Cookbook.svelte` renders the section in
  the detail pane, gated on pane + selected id so it survives
  routed-recipe resolution windows (see the search-scope bullet)
  rather than on the `{#if activeRecipe}` content gate. The pane
  passes its resolution state down (a `'resolving' | 'found' |
  'missing'` union or an equivalent fetching flag -
  `resolveActiveRecipe` returns null for BOTH still-fetching and
  gone, so the section cannot distinguish them without it). The
  mount-void case is scoped to BROWSE mode: no live search +
  resolution failed = the section renders nothing (an empty log
  under a not-found pane would read as "no records yet"; another
  device may have deleted the open recipe). With a live search
  the section stays mounted and renders the results list -
  dead hits get their "(deleted recipe)" label - and only the
  per-recipe log, add form, and Export all void. Cookbook.svelte
  already computes the offline state the bookmark controls use,
  and already hosts the History panel Records sits below.
- Recipe delete names the log cost. The cookbook's delete
  confirmation is a `window.confirm` (not an inline strip); its
  message gains "This deletes the recipe and its N records", with
  N from a head-count query at confirm time (the section's loaded
  row count can be filtered or stale); the count/copy logic is a
  pure helper in `src/lib/ui/cookbook-screen.ts` (covered by
  `tests/cookbook-screen.test.ts`); the Delete handler awaits
  the count and then opens the dialog - an async confirm is fine
  at this scale, but the count is never cached at section-load
  (stale) and a failed count shows the confirm without the count
  clause rather than blocking the delete. With no changelog (decision 2), the cascade delete
  of the log is silent everywhere else - this is the one place it
  is announced.
- Data layer: `src/lib/supabase/recipe-records.ts`, plain async
  functions taking the shared client (the `wiki-records.ts` shape:
  no class, no state), one-for-one delegation from the
  SupabaseService facade; the list call's filter set is date
  range, tags (AND), outcome, limit - outcome is the one the
  twin's list lacks, and it exists because browse-mode outcome
  filtering is a promised surface, not just a search param. Row
  types + coercer (`RecipeRecord`,
  `coerceRecipeRecord`) in `src/lib/supabase/types/cookbook.ts`
  (the module's first coercer - recipes are cast raw today; wiki's
  coercers live in `types/wiki.ts`), re-exported through the
  existing `types/index.ts` barrel.
- Realtime: `subscribeToRecipeRecordChanges` in `realtime.ts` (a
  clone of `subscribeToWikiRecordChanges` over `recipe_records`),
  wired in `Chat.svelte` alongside the existing relays, publishing
  a `nak:recipe-records:changed` window event through
  `src/lib/cookbook-events.ts` (the same emit/on pair shape the
  cookbook already uses); RecipeRecords.svelte listens and
  refetches, so agent-side record writes land live. The
  section's OWN writes emit the same event directly after the
  write succeeds (the twin does exactly this) - realtime is the
  agent-writes path, and a user whose websocket is down but REST
  is fine still sees their save land.
- Screen primitives: `src/lib/ui/recipe-records.ts`, pure helpers
  (filter predicates, outcome chip labels and colors, export
  filename slugs), unit-tested next door. The search chain's
  query-embedding step gets a named home too -
  `searchRecipeRecordsSemantic({ query, limit, outcome, supabase,
  signal })` in
  `src/lib/recipe-records-search.ts` (a new `$lib` sibling; the
  options-object signature is a deliberate divergence from the
  twin's positional `(query, limit, deps)`, but the deps are
  load-bearing either way: the service and abort signal are
  injected (no `app` import), so the .svelte file stays
  embed-free AND supersede-able; outcome threading
  made the options shape readable; the `src/lib/wiki.ts` analog of
  `searchWikiRecordsSemantic`: it calls the embedder itself - no
  embedding parameter, the twin embeds internally too - then the
  facade, then the data-layer merge; `outcome` threads through
  wrapper, facade, merge, and both legs) - so the embed call
  never lands inside the .svelte file.

## Milestones

The three milestones land as ONE PR: M2 ships user-visible UI, and
the mandatory same-PR docs rule forbids splitting the doc updates
away from it.

- **M1 - Schema + data layer.** Table, triggers, RLS, the two
  realtime deliverables (publication membership + the
  `(id, user_id)` replica-identity index - omit either and M2's
  relay silently receives nothing, the exact failure the wiki
  gotcha documents), embedding RPCs, `EMBED_SOURCES` entry,
  `_shared/recipe-record-limits.ts`, types, SupabaseService slice,
  and `subscribeToRecipeRecordChanges` in `realtime.ts` (data-layer
  work, so M2's wiring has something to call), plus the head-count
  query the delete confirm needs (`countRecipeRecords(recipe_id)`
  in the data layer), and a pointer comment in
  `src/lib/recipe-limits.ts` toward the new
  `_shared/recipe-record-limits.ts` (the two neighboring
  "recipe limits" homes have opposite canonical directions - the
  comment prevents a future reader from "fixing" the split
  brain). Two required test
  edits land here: `supabase/functions/tests/embed-input.test.ts`
  asserts `EMBED_SOURCES`' name list by exact equality, and
  `tests/realtime-subscribe.test.ts` pins every realtime helper's
  topic contract. Gate: `mise run sync` green, the backfill embeds
  a seeded record, unit tests pass.
- **M2 - UI.** The Records section in the detail pane (mounted by
  Cookbook.svelte): add / edit / delete, filters, cross-recipe
  search with navigation + scroll-highlight of the clicked hit
  (including the `searchRecipeRecordsSemantic` wrapper), export
  module, offline degradation, realtime refresh wired through
  `Chat.svelte` + `cookbook-events.ts`, plus the two
  Cookbook.svelte behavior changes the spec commits to (the
  pane's `missingRecordMessage` placeholder states and the
  delete-confirm "N records" line) and their doc updates landing
  with the code (cookbook.md's Records section, the
  components.md entry).
- **M3 - Chat tools.** Six tools wired into the two toolboxes and
  registered in the edge tool barrel
  (`supabase/functions/venice/tools/index.ts`), shared edge helpers
  in a new `venice/tools/_recipe_record_helpers.ts` (the
  `_record_helpers.ts` clone: column list, date/tag normalizers,
  ownership pre-check, plus outcome normalizing; its file
  preamble names the distinction from the easily-confused
  `_recipe_helpers.ts` - photo meta, a different thing), formatArgs, the
  capture trigger + dedup/merge guards in the descriptions, the
  two toolbox description strings (both catalog-visible:
  `cookingToolbox` gains the capture trigger, `alwaysOnToolbox`'s
  read-surface enumeration gains the three record reads), the
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
  export filenames, and the search merge (dedup by id, cap,
  empty-query short-circuit, outcome pass-through - stubbed
  client, plain vitest; the twin has no merge test, so this is a
  deliberate improvement on it).
- `tests/tools.test.ts`: three loops updated for the six new
  tools - the cookingToolbox membership array (writes), the
  always-on read list (`toContain`), and the no-writes-leak loop
  (records writes must not appear outside the cooking toolbox;
  while in that loop, drop its pre-existing `recipe_update`
  ghost - no such tool exists).
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
  detail pane shows it, which doubles as the realtime-relay
  proof; a
  second report of the same event exercises the dedup guard; a
  detail correction exercises the get-then-merge update), the
  outcome filter end to end (set via tool and via the dropdown,
  including the failure-across-recipes search), cross-recipe
  search click-through + scroll-highlight INCLUDING the
  resolution-window case (click a hit on a recipe not in the
  loaded drawer window; query, results, and highlight must
  survive the by-id fallback fetch), the delete confirm's
  "N records" count, export, embedding backfill, and the offline
  degradation (stale rows visible on the same recipe, writes and
  filter/search controls disabled, offline-no-data line on a
  fresh load AND on an offline recipe switch, and the
  offline-uncached-recipe placeholder on the deep-link path). Index
  it in `docs/qa/README.md`'s use-case list.
- Docs: `../cookbook.md` gains a Records section (and fixes its
  stale inventory in passing: "nine LLM tools" and "five
  recipe tools registered" predate the photo tools, the
  `recipe_search` ghost appears twice (:24 and :601), the
  backfill line's "alongside the other six sources" is a
  hardcoded count that is already wrong, the same paragraph's
  `GATED_TOOLS` reference is a removed
  mechanism, and the "modal" wording - the component renders
  inline now);
  the user-facing
  doc `docs/user/cookbook.md` gains the "why records vs History
  panel" story AND its delete-confirmation description gains the
  "N records" copy (the `docs/user/` update is mandatory in the
  same PR, not optional); `docs/dev/offline-cache.md`'s Interactions
  ledger gains the "recipe records are online-only, degrade soft"
  line (the dev-docs rule: a feature coupling to another feature's
  ledger must update it); `docs/dev/tools.md`'s write-toolbox
  section re-enumerates the cooking toolbox (and fixes its
  pre-existing `recipe_update` ghost mention on that same line -
  no such tool exists in the registry);
  `docs/dev/components.md`'s inventory gains the RecipeRecords
  entry; `docs/dev/architecture.md`'s facade-slice list gains
  `recipe-records`; `docs/dev/embeddings.md`'s EMBED_SOURCES registry
  description gains the `recipe-records` source (and its source
  count stops being a hardcoded number); `docs/dev/tools.md`'s
  always-on section names the three record reads;
  `docs/dev/README.md`'s "Cookbook modal" mention joins the
  inline-viewer wording fix;
  `docs/qa/use-cases/realtime-relays.md`'s Covers line and
  pg_class audit query gain the fourth relay and its
  replica-identity index (the doc already lags - `wiki_records`
  and the grocery relays are missing too; catch it up here
  rather than inherit the gap).
- Existing QA use-case delta: `cookbook-recipe-lifecycle.md`
  step 12 pins the delete confirm's copy, which this feature
  changes - update that expectation and re-execute the use-case
  before/after in the same PR (the QA discipline's baseline
  rule).

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
- **No recall-pipeline or `context` coverage.** Wiki records join
  neither the `context` umbrella tool nor the recall pipeline,
  and recipe records join neither either - records are surfaced
  through their own tools and the Records section. Stated so a
  future session does not relitigate it.
- **No ToC jump link to the section.** The wiki twin surfaces a
  Records link with a live count in the article ToC; the recipe
  TOC stays Ingredients/Instructions-only, so reaching the
  section on a long recipe is scroll (or a hit-click, which
  scrolls there). A "Records (N)" link is a cheap follow-on if
  the scroll annoys.
- **No "unclassified" mode on the outcome filter.** The
  form/`recipe_record_update` can set outcome to null, but the
  browse filter enumerates only success/mixed/failure - "show me
  my unclassified bakes" is not promised; an IS NULL filter mode
  is the follow-on if it's missed.

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
6. **Refinement resolutions (rounds 2-6):** capture logs directly
   and says so in the reply (no confirmation round-trip; ask only
   when the cook report is ambiguous), matching how Jeff described
   using it; a cross-recipe hit click navigates while the query
   and results stay live (round 6: reset-on-navigate would defeat
   the multi-hit search the cross-recipe scope exists for), with
   the date/tag filters resetting and the scroll-highlight marking
   the clicked hit; offline keeps reads on the last fetch and
   disables writes (cooking is the most offline-prone context in
   the app).
