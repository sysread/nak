# Grocery Combination Tool Plan

Status: DRAFT (rev 2 - deltas-from-template ledger added pre-round-1).
Branch `grocery-tool` off main 75e43e7c. This doc is the
reviewable artifact; refinement edits this file, not code.

Read [`../tools.md`](../tools.md) first - this plan assumes its
vocabulary (ToolDef, serverSideTool, TOOLBOXES, the no-gating
model, `x-per-op-required`, ArgErrors) and its combination-tool
contract. Read [`../grocery-list.md`](../grocery-list.md) for the
grocery domain (catalog/list split, open entries, purchase vs
un-plan, auto-filing, the realtime relay).

## SYNOPSIS

Add one `grocery` combination tool (op enum: list / add / remove /
update) so the chat model can read, search, and edit the grocery
list. Mirrors the `recipes` combo shape end to end: browser
schema-only module + edge impl behind an op switch + service-role
DB access scoped by `ctx.userId`. A new `groceryToolbox` joins the
catalog after `cooking`. No schema.sql changes, no new RPCs, no
nested LLM calls - the chat model itself files items into
sections.

## PURPOSE

The chat model can manage recipes but not the list built from
them. If the user says "what's on my grocery list" or "add butter
to the list," the model has no surface to answer or act - it can
only see Cooklang ingredients indirectly through `recipes op=get`.
The grocery domain was built tool-ready and explicitly left
tool-less ("LLM tools - none, deliberately" - the list is
user-driven UI; the schema and service layer are tool-ready if a
groceries toolbox ever earns its keep,
`docs/dev/grocery-list.md:453-455`). The user has now asked for
the tool, so the toolbox earns its keep.

## BACKGROUND

Two precedents cover everything this plan builds; nothing here is
novel machinery.

### The recipes template (what to copy)

- **Browser schema** (`src/lib/tools/recipes.schema.ts`): exports
  `{ name, description, shortDescription, formatArgs, parameters }`.
  One flat object schema: `op` string enum in `required`, every
  per-op param as a sibling property with an op-scoped
  description, `additionalProperties: false`. Per-op requireds
  that a flat schema cannot express are enforced edge-side via
  ArgErrors, accumulated all-at-once
  (`supabase/functions/venice/tools/_validate.ts:74-99`).
- **Registration** (`src/lib/tools/index.ts`): import the schema,
  wrap with `serverSideTool` (execute throws - dispatch is
  edge-side by design, `src/lib/tools/server_side.ts:24-36`), add
  to a toolbox's `tools` array, toolbox into `TOOLBOXES`
  (`:468-477`). The system-prompt catalog and the wire `tools`
  array are built live from the registry; nothing else is touched
  (`src/lib/chat/system-prompt.ts:395-444`, `src/lib/chat/loop.ts`
  ships `buildToolList()`).
- **Edge impl** (`supabase/functions/venice/tools/recipes.ts`):
  one `ToolDef { name, execute(args, ctx) }`, `registerTool` at
  the bottom, one side-effect import in the edge
  `tools/index.ts` barrel. Every query carries
  `.eq('user_id', ctx.userId)` under a `// RLS OFF: filter by
  userId` comment (b-strict service-role discipline,
  `docs/dev/edge-function-auth.md`). Tools throw plain Errors with
  model-actionable messages; the orchestrator shapes outcomes
  (`getStreamingResponse.ts` `runOneToolCall`).
- **Tests both islands**: vitest registry/catalog pins
  (`tests/tools.test.ts`, `tests/system-prompt.test.ts`); Deno
  per-op suites driving a `run(op, args, ctx)` seam over a
  stubbed `fakeCtx` adminClient
  (`supabase/functions/tests/recipe_tools.test.ts:25-87`).

### Deltas from the recipes template

This plan clones the recipes combo; the ledger records every
divergence, verified against `recipes.schema.ts` /
`venice/tools/recipes.ts` as of main 75e43e7c. Reviewers check
template-behavior claims against this ledger, not re-derived from
the template source.

| # | Point | recipes (template) | grocery (this plan) |
|---|---|---|---|
| 1 | Ops | list / get / save / delete | list / add / remove / update (no get; list+query covers it) |
| 2 | Write target | single recipe per save | add is a BATCH (items[]) with per-item outcomes |
| 3 | Write path | SECURITY DEFINER RPCs (`recipe_create_with_version` / `recipe_update_with_version`) with `p_user_id` | direct table writes - no SECURITY DEFINER RPCs exist for grocery; the invoker RPCs cannot run service-role |
| 4 | `x-per-op-required` | absent - all requireds conditional | present, partial map: `{ add: ['items'] }` - the one unconditional required |
| 5 | Dup guard | upsert heuristics: exact-title match routes create to update; near-match refused with candidates (`_upsert_heuristics.ts`) | normalized-name probe with THREE outcomes: revive / already_on_list / create; never routes to update |
| 6 | Delete semantics | hard delete, honest miss | remove = un-plan (deletes the open entry only); product row survives |
| 7 | Grammar gate | Cooklang validated, save refused with problem list | no equivalent - count/unit are free text by design (gotcha) |
| 8 | Caps | mirrored from `src/lib/recipe-limits.ts` (documented mirroring discipline) | new tool-side guards (DB stores free text); mirrored between islands with citations |
| 9 | Toolbox | `cookingToolbox` | new `groceryToolbox` after cooking |
| 10 | formatArgs tail | cooklang rendered in a fenced code block | items rendered as a bulleted list |

### The grocery domain (what the tool must respect)

- **Catalog/list split** (`supabase/schema.sql:4296-4319`):
  `grocery_products` is the durable catalog; "on the list" is an
  OPEN `grocery_list_entries` row (`acquired_at is null`, at most
  one per product, `grocery_list_entries_open_uidx:4393-4394`).
  Buying STAMPS `acquired_at` (the row stays as purchase history);
  un-planning DELETES the open entry.
- **Purchase is a user gesture.** The two uncheck verbs are
  different on purpose; "wiring a planning surface to the purchase
  verb pollutes the purchase log with things never bought"
  (`docs/dev/grocery-list.md:470-474`). Every existing stamp of
  `acquired_at` is a row tap in the panel.
- **Name normalization is the only ingredient identity**
  (`trim().toLowerCase()`, `src/lib/ui/grocery-list.ts`): the
  browser's add-all path revives an off-list product by normalized
  name before creating anything, so the learned section and
  purchase history survive (`src/screens/Cookbook.svelte:1189-1225`
  -> `partitionIngredientsForAdd`, `grocery-list.ts:585-601`).
  The name index is NOT unique (`grocery_products_user_name_idx`,
  `schema.sql:4348-4350`) - name lookups can match multiple rows.
- **`section_source`** stamps who filed a row: 'user' = chosen in
  the UI, 'auto' = filed by a machine, null = unfiled/intake
  (`schema.sql:4327-4333`). The auto-classifier may only file rows
  where it is null; user refiling always wins.
- **Acquired history is a recency window, never fetched whole**
  (`docs/dev/grocery-list.md:475-477`).
- **Recipe-linked products** carry `recipe_id` + note "For
  <title>"; the cooklang invalidation trigger deletes recipe
  products whose name no longer parses on recipe edit, and that
  trigger deliberately covers server-side write paths
  (`schema.sql:4430-4479`).
- **Edge writes refresh open tabs for free**: all three grocery
  tables are in the realtime publication; the browser relay
  (`src/lib/supabase/realtime.ts:535-563`, wired in
  `src/screens/Chat.svelte:2378-2381`) turns any `user_id`-scoped
  postgres change into a `nak:grocery:changed` reload. The tool
  needs no event side-channel.
- **Deno island stance**: the venice function never imports from
  `src/lib`; small mirrors are duplicated with a comment citing
  the browser source-of-truth
  (`supabase/functions/README.md:59-84`, e.g. the caps mirror in
  `recipes.ts:47-54`).

## DESIGN

### Tool contract

One tool, name `grocery`, four ops. The description follows the
recipes calibration: op-by-op prose, the contracts the model must
know up front (un-plan vs purchase, revive-not-recreate, honest
misses), short enough to stay combo-calibrated on the wire
(~2k chars).

#### op=list - read + search the list

Params (all optional): `query` (case-insensitive name substring),
`status` enum `on_list` (default) | `acquired` | `all`, `section`
(section name, case-insensitive; `'Other'` matches the unfiled
bucket `section_id is null`), `limit` (default 100, max 500).

Reads `grocery_products_view` directly (VIEW_SELECT mirror, cited
to `src/lib/supabase/grocery.ts:196-199`), filtered
`.eq('user_id', ctx.userId)`:

- `on_list`: `on_list = true`, ordered `updated_at desc` (the
  browser's on-list ordering).
- `acquired`: `on_list = false and acquired_at not null`, ordered
  `acquired_at desc` - a recency window bounded by `limit`, never
  whole.
- `all`: ordered `name asc, id asc` (the browse pager's ordering),
  `query` via the ILIKE pattern (mirror `ilikeFilterPattern`,
  cited to `recipes.ts:56-60` / `src/lib/supabase/query-utils.ts`).

Result: `{ sections: [{id, name}] (the user's rows ordered by
position; 'Other' is the null bucket, not a row), items:
[{id, name, note, section, count, unit, on_list, acquired_at,
recipe_id, recipe_title}] }`. Sections ride along so the model can
file items and answer "what sections are there" without a second
op. No `get` op: `list` with a name substring is the lookup.

#### op=add - add items (batch, idempotent)

Params: `items` (required - array of `{ name (required), count?,
unit?, note?, section? }`), `recipe_id` (optional).

Per item, the browser add-all semantics: probe the catalog by
normalized name; a match that is off-list REVIVES it (open entry;
update count/unit on the entry when provided), a match that is
already on-list is reported as such (idempotent no-op), no match
CREATES the product then opens its entry.

- `section` per item: case-insensitive name match against the
  user's `grocery_sections`; an unknown name is an ArgError
  listing the valid section names. Applies to CREATE only - a
  revive keeps its learned section (browser parity). A section
  provided on create stamps `section_source: 'auto'` (machine
  chose it; the classifier may not touch non-null, user refiling
  still wins - see DECISIONS).
- `recipe_id`: validated to exist and be owned (select
  `recipes` `.eq(id).eq(user_id)`), else ArgError. When given,
  created products carry it, and an item with no `note` defaults
  to `For <title>` - matching the browser payload
  (`groceryProductFromIngredient`, `src/lib/ui/grocery-list.ts:
  611-628`). This is what makes the invalidation trigger clean
  them up on recipe edits.
- Result: per-item outcomes `{ name, status: 'created' |
  'revived' | 'already_on_list', product_id }` - the model can
  report what it did honestly.
- Caps (ArgErrors, mirrored in the browser schema as maxLength/
  maxItems): max 30 items/call; name 200 chars; count 100; unit
  100; note 500. The DB stores free text; these are tool-side
  runaway guards, not DB constraints (unlike the recipes caps,
  which mirror `src/lib/recipe-limits.ts`).

#### op=remove - un-plan one item

Params: exactly one of `id` (product id) or `name` (normalized
match). Deletes the OPEN entry only; the product and its purchase
history survive. Never stamps `acquired_at` - that is the
purchase verb, deliberately absent (see DECISIONS).

Honest reporting per the repo-wide delete contract
(`docs/dev/tools.md:468-477`): `{removed: true}` / `{removed:
false, reason}` where reason names the possibilities without
distinguishing them ("no product matched", "not on the list").

A `name` matching multiple products refuses with the candidates
listed (the name index is non-unique).

#### op=update - edit one item

Params: exactly one of `id` or `name` (locator; multiple name
matches refuse with candidates), then any subset of:

- `rename` (string) - new product name (kept distinct from the
  `name` locator).
- `note` (string | null - null clears) - product note.
- `section` (string | null) - a section name files the product
  there (`section_source: 'auto'`); null UNFILES it (section_id
  null + section_source null - back to intake, where the
  classifier may file it later). `'Other'` is not filable (it is
  not a row); the description says so.
- `count`, `unit` (string | null - null clears) - apply to the
  OPEN entry (the view's `entry_id`); honest refusal when the
  product has no open entry ("not on the list"). Product fields
  and entry fields can mix in one call; entry fields hard-fail
  the call only when there is no open entry.

Result: the updated view row (same shape as list items).

#### Wire schema mechanics

`x-per-op-required: { add: ['items'] }` - the one unconditional
per-op required; remove/update requireds are id-XOR-name
conditionals that stay in ArgErrors (partial maps are the
documented pattern, `docs/dev/tools.md:671-696`). No agent
consumers, so no agent-side mirrored schema to keep in sync.

`formatArgs`: "op leads" - `**Op:**` first, then locators and the
items array as a bulleted list (`name x count unit -> section`),
mirroring `formatRecipesArgs` (`recipes.schema.ts:30-58`).

### Toolbox + catalog

New `groceryToolbox` (name `grocery`), inserted after
`cookingToolbox` in `TOOLBOXES` - cooking-adjacent, but its own
surface (the tool must sit in exactly one toolbox, and reads ride
inside the combo rather than always-on; the skills/recipes
precedent, `src/lib/tools/index.ts:258-261`). Catalog-visible
description carries the reach-for-it trigger, the cooking-toolbox
pattern (`index.ts:271-282`): when the user mentions their
grocery/shopping list, asks what is on it, or asks to add or
remove items. shortDescription: "read and edit the grocery list".

### What this plan deliberately does NOT build

- **No purchase op.** Stamping `acquired_at` is a user gesture in
  every existing path; a model stamp would fabricate purchase
  history and pollute the In-cart split mid-trip. Revisit only
  with an explicit scoped design (e.g. only inside an active
  trip) - future work, recorded in `docs/dev/planned-changes.md`.
- **No section management** (create/rename/reorder/delete
  sections) and **no product delete** (the durable-catalog
  destroy verb). Filing into existing sections via add/update
  covers the model's needs; the destructive surfaces stay UI-only
  for v1. Both are cheap follow-ups if wanted.
- **No nested classifier call.** The chat model picks sections
  itself via the `section` param; the flash-model auto-sectioning
  agent stays browser-side and untouched. Items added without a
  section land in intake, exactly like browser adds with no
  classifier verdict.
- **No schema.sql changes.** Everything rides existing tables,
  the view, and direct writes. (`grocery_sections_reorder` and
  `grocery_item_image_upsert` are security-invoker RPCs that
  cannot run under the service-role client - neither is in this
  tool's op set, so nothing needs replacing.)

## MILESTONES

### M1 - plan (this doc)

Commit the plan to the branch before any code. Refine with
fresh-context reviewers until consensus (2-round cap).

### M2 - implementation

- `src/lib/tools/grocery.schema.ts` - schema-only module
  (op enum, flat params, `x-per-op-required` for add, formatArgs,
  maxLength/maxItems caps).
- `src/lib/tools/index.ts` - import, `serverSideTool`,
  `groceryToolbox`, TOOLBOXES entry.
- `supabase/functions/venice/tools/grocery.ts` - ToolDef + op
  switch + `registerTool`; b-strict `// RLS OFF: filter by
  userId` on every query; mirrors (VIEW_SELECT, normalize,
  ilike pattern, 23505 tolerance) each citing its browser
  source-of-truth.
- `supabase/functions/venice/tools/index.ts` - one barrel import.
- Tests: Deno `supabase/functions/tests/grocery_tools.test.ts`
  (fakeCtx harness, per-op suites); vitest pins updated in
  `tests/tools.test.ts` + `tests/system-prompt.test.ts`.
- `mise run check` green (functions-check covers the new edge
  module's full import graph; knip covers dead exports).

### M3 - docs + QA + graduation

- `docs/dev/tools.md` - Files/toolbox/combo entries.
- `docs/dev/grocery-list.md` - replace the "LLM tools - none"
  line; Files + Entry points + Interactions ledger (tools.md
  coupling); Gotchas additions (purchase stays user-gesture-only;
  edge writes refresh via the realtime relay; model filing stamps
  'auto').
- `docs/dev/planned-changes.md` - the deferred purchase op with
  its rationale.
- `docs/user/grocery-list.md` - new "Ask the assistant" section
  (observable behavior change; same-PR rule).
- `docs/qa/use-cases/grocery-tool.md` - new use-case: chat-driven
  list read/add/remove/update against the local stack, results
  logged.
- Graduate this plan into the docs above and retire it from
  `in-progress/` (plan-completion skill).

## TESTING

- **Deno** (`supabase/functions/tests/grocery_tools.test.ts`,
  ported from `recipe_tools.test.ts:25-87`): list (default
  on_list, query, acquired window + ordering, section filter incl
  'Other', limit clamp, sections payload); add (create, revive
  keeps section, already-on-list idempotent, section resolution +
  unknown-section ArgError, recipe_id validation + default note,
  batch outcomes, caps); remove (by id, by name, ambiguous name
  refuses with candidates, not-found honest, not-on-list honest);
  update (product fields, entry fields, entry fields with no open
  entry refuse, unfile via null section, rename).
- **Vitest pins**: `tests/tools.test.ts` (groceryToolbox
  membership + TOOLS/TOOLBOXES order) and
  `tests/system-prompt.test.ts` (new catalog section, always-on
  no-writes tripwire untouched).
- **Live QA** (M3): local stack, real thread - model reads the
  list, adds with and without sections, removes, updates; verify
  the open tab refreshes via realtime without manual reload.

## RISKS

- **Wire token cost.** Every tool rides every request; a combo is
  the calibrated-cheapest shape (~2k chars). This is a new
  capability, not a consolidation - the cost is accepted, and the
  description stays lean to keep it near the combo average.
- **Name ambiguity.** Non-unique name index; remove/update
  refuse-with-candidates instead of guessing. `add` probes by
  normalized name the same way the browser does, so it inherits
  the same collision behavior the UI already tolerates.
- **Provenance blur.** Model-chosen sections stamp 'auto', the
  same value the flash classifier gets - the rows are
  machine-filed either way. Functionally inert (the classifier
  only files null-source rows; user refiling always wins).
- **Realtime echo.** Each tool write triggers a generation-
  guarded reload in open tabs - the same echo the browser's own
  writes produce; expected and safe.
- **Model fat-finger between `grocery` and `recipes`.** Distinct
  resource names + the toolbox description naming both surfaces
  ("recipes and their cooking logs" vs "the grocery list") is the
  combo plan's own mitigation, already in production.

## DECISIONS (resolved)

1. **Op set = list / add / remove / update.** Read+search folds
   into `list` (query param), matching the recipes `list` browse
   pattern; no `get` op. Purchase, product-delete, and section
   management excluded - rationale above, deferrals recorded.
2. **`remove` = un-plan, single target.** The purchase verb is
   the panel row tap, not a model call. Single id-or-name keeps
   honest-refusal semantics clean; the model loops for batches.
3. **Revive-before-create on `add`.** Browser add-all parity;
   preserves learned sections and purchase history. Already-on-
   list is an idempotent reported no-op, not an error.
4. **Model-chosen sections stamp `section_source: 'auto'`.**
   Machine provenance; keeps the classifier's null-only guard and
   user-refiling-wins intact.
5. **`section: null` on update = unfile** (back to intake), not
   "file in Other" - deliberately-filed-in-Other is a UI-only
   concept (`section_id null + section_source 'user'`).
6. **`x-per-op-required` partial map for `add` only.** Remove/
   update id-XOR-name rules stay in ArgErrors (conditional
   requireds are the documented exclusion,
   `docs/dev/tools.md:671-696`).
7. **Entry-level count/unit edits require an open entry** and
   refuse honestly otherwise; product-level fields (rename, note,
   section) work on any product.
8. **Direct table writes, no RPCs.** The grocery RPCs are
   security-invoker and cannot run service-role; every op here is
   expressible as direct writes + the view read.
