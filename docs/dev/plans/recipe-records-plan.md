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
  `created_at` (when the row was written). Lists sort `date desc`.
- `content text not null` (Markdown) - what happened: the iteration,
  observations, what went right and wrong.
- `outcome text null` - optional enum `success | mixed | failure`
  with a check constraint, null meaning "not classified". This is
  the one deliberate divergence from wiki records: "historical
  success and failures" is a stated purpose of the feature, and a
  filterable outcome column ("show me my failures") beats parsing
  prose for it. Tags remain freeform for everything else
  ("variation", "rye", "less-salt").
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
  trio with the same `for update skip locked` claim discipline.
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
browser-side via the `$shared` alias, per the shared-module dedup
pattern (wiki predates that pattern and duplicates its constants;
this feature starts on the good side of it).

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

### Chat tools (six new)

Wiki owns the `record_*` names, so recipe records get the
`recipe_record_*` prefix (explicit, greppable, no collision).

Capture is manual by design: the model logs records during cooking
discussions (the tool call IS the capture path - there is no
background sweep), and the user can add records by hand in the UI.
That moves the discipline the wiki puts in its sweep prompts into
the write tools' descriptions:

- **Dedup guard on create**: before `recipe_record_create`, check
  `recipe_record_list` on the recipe - if the event is already
  logged, `recipe_record_update` it instead of stacking a duplicate.
- **Merge, don't duplicate, on update**: details arrive piecemeal
  ("the crumb was actually fine on day two"). `recipe_record_get`
  the record first and pass the merged body; `content` is a
  full-replacement patch, so an update that omits it leaves the
  body untouched.

Reads - join `alwaysOnToolbox`, mirroring how wiki's record reads
ride always-on:

- `recipe_record_list` - one recipe's log. Params: `recipe_id`
  (required), optional `date_from` / `date_to`, `tag`, `limit`.
- `recipe_record_get` - one record by id.
- `recipe_record_search` - semantic search across every recipe's
  records, optional `recipe_id` scope. Embed + ILIKE-on-content
  merge, same shape as `searchRecipes`.

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
`src/components/RecipeRecords.svelte`:

- **Add form**: date, content (Markdown), comma-separated tags,
  outcome selector.
- **Rows**: date ("Mon D, YYYY"), outcome chip, tag chips, truncated
  preview; a row expands to the full content with Edit / Delete.
- **Filters**: from/to date range, tag dropdown, and a semantic
  search box (debounced embed-then-merge with abort-controller
  supersede, the same shape as RecipeList's search).
- **Export**: single record to `yyyy-mm-dd-<slug>.md` with
  date/tags/outcome front matter, and Export all to a zip holding
  `recipe.md` plus one `records/` entry per record (wiki's Export
  all shape; the recipe itself has only single-file exports today).

Supporting moves:

- Data layer: `src/lib/supabase/recipe-records.ts`, plain async
  functions taking the shared client (the `wiki-records.ts` shape:
  no class, no state), one-for-one delegation from the
  SupabaseService facade. Row types + coercer (`RecipeRecord`,
  `coerceRecipeRecord`) in `src/lib/supabase/types/cookbook.ts`.
- Realtime: `subscribeToRecipeRecordChanges` in `realtime.ts` (a
  clone of `subscribeToWikiRecordChanges` over `recipe_records`);
  Cookbook.svelte refetches the section when it fires, so agent-side
  record writes land live.
- Screen primitives: `src/lib/ui/recipe-records.ts`, pure helpers
  (filter predicates, outcome chip labels and colors, export
  filename slugs), unit-tested next door.

## Milestones

- **M1 - Schema + data layer.** Table, triggers, RLS, embedding
  RPCs, `EMBED_SOURCES` entry, types, SupabaseService slice. Gate:
  `mise run sync` green, the backfill embeds a seeded record, unit
  tests pass.
- **M2 - UI.** The Records section in the detail pane: add / edit /
  delete, filters, search, export, realtime refresh.
- **M3 - Chat tools.** Six tools wired into the two toolboxes,
  formatArgs, the dedup/merge guards in the descriptions, docs, QA
  use-case run end to end.

## Testing

- `tests/recipe-records.test.ts`: coercers, filters, chip labels,
  export filenames (plain vitest, stubbed client, mirroring the
  wiki-records tests).
- `tests/tools.test.ts`: toolbox membership assertions updated for
  the six new tools.
- Edge tests mirroring where wiki's record tools are covered
  (`supabase/functions/tests/wiki.test.ts`): create/update/delete
  handlers, argument validation, `source_conversation_id` stamping.
- `tests/schema-dml-columns.test.ts` floors: adding a table may trip
  the floor assertions (>= 40 tables). Bumping a floor is expected
  and mechanical; a test failing DOWNWARD is a scanner regression,
  not this change.
- QA use-case: `docs/qa/use-cases/recipe-records.md`, mirroring
  `wiki-records.md` minus the sweep step (manual CRUD, filters,
  search, export, embedding backfill, realtime relay).
- Docs: `../cookbook.md` gains a Records section; the user-facing
  doc gains the "why records vs History panel" story.

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
- **Offline cache.** Records stay online-only in v1; the
  favorite/upcoming offline reconcile is untouched.
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
