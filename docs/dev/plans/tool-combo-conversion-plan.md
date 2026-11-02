# Tool Combo Conversion Plan (Tier 1 + Tier 2)

Status: PROPOSED 2026-11-02. One cluster per milestone; each milestone
ships as its own deploy.

Read [`../tools.md`](../tools.md) first - this plan assumes its
vocabulary (`ToolDef`, `buildToolList`, `performToolCall`, agent
toolboxes, `asAgentTool`) and its "Toolbox model" section for why
nothing here changes enablement.

## SYNOPSIS

Convert 39 verb-shaped tools into 11 combination tools behind `op`
enum discriminators, following the `skills` precedent (the first and
only combo tool today). Eight merged clusters plus a final audit
milestone take the main-chat catalog from 65 tools to 26. Each
milestone merges the browser schema, merges the edge impl behind an
op switch, adapts any agent toolboxes that wrap the merged impls,
updates prompt prose and docs and tests, deletes the retired files,
deploys, and verifies in a live thread.

## PURPOSE

1. **Wire token cost.** The full declared set measured ~72k chars
   (~18k tokens) at a then-60-tool catalog
   (`../tools.md:73-82`); the registry has since grown to 65.
   Removing 39 per-verb schemas and adding 11 merged ones saves on
   the order of 5k tokens off the uncached prefix (first turn of
   every conversation, every cache miss) and drops ~39 lines from
   the system-prompt catalog. Prompt caching absorbs repeat cost
   either way; this attacks the uncached floor.
2. **LLM uncertainty.** The catalog's near-duplicate name families
   (`record_get` / `wiki_get` / `doc_get` / `recipe_record_get`;
   `record_list` / `recipe_record_list`) are the fat-finger surface.
   Resource-named combos with op enums collapse the choice to "which
   store, which op".
3. **The combo form is proven in production here.** The 2026-10-29
   live calibration found no tools-array cap, flat latency through
   ~69 tools, and the model composing op + params reliably under
   free choice; the enum form is smaller on the wire than oneOf
   variants (`src/lib/tools/skills.schema.ts:5-10`).

## BACKGROUND: the skills template

Every milestone copies this shape; cited so reviewers can diff
against it.

- **Browser schema** (`src/lib/tools/skills.schema.ts:51-133`): one
  tool name, `op` enum in `required`, flat optional per-op params
  with "X only" pairing descriptions, `formatArgs` that renders the
  op first (`:26-49`). Per-op required fields (name+body on save,
  query on search) cannot be expressed in one flat JSON Schema -
  the edge validates them via `ArgErrors`, recorded in the schema
  header (`:14-18`).
- **Edge impl** (`supabase/functions/venice/tools/skills.ts:39-65`):
  one `registerTool` def, a `VALID_OPS` const, an op switch, and
  `ArgErrors` accumulation (`tools/_validate.ts`) for every
  per-op required field.
- **Retired-name rendering is already safe.** `getToolFormatters`
  returns `undefined` for unknown names and the detail panel falls
  back to the generic JSON formatter (`src/lib/tools/index.ts:658-662`),
  so old persisted `tool_calls` rows keep rendering after a merge.
  The recovery synthesizer is name-agnostic. No data migration.
- **Agent adaptation precedent.** `asAgentTool(tool, wire)`
  (`supabase/functions/venice/agents/_agent_tools.ts:23-36`) wraps a
  registered impl with an agent-pinned wire schema. The librarian's
  `asAgentToolNoCreate` wrapper
  (`agents/wiki_librarian.ts:435-452`) is the model for narrowing a
  merged surface per agent: the wire enum narrows what the model
  sees, the impl's op switch + ArgErrors still reject anything the
  enum should have prevented.

## DESIGN: what changes per merged cluster

1. **Browser schema.** N schema files become one `<name>.schema.ts`
   (op enum + flat params + op-aware `formatArgs`). Retired schema
   files deleted. The merged tool keeps a `<50-char`
   `shortDescription` for the catalog.
2. **Edge impl.** The per-op bodies survive as internal functions;
   the combo file registers one ToolDef whose `execute` switches on
   `op`. Retired impl files deleted; `tools/index.ts` barrel
   imports updated.
3. **Agent toolboxes** (only clusters with agent consumers). Each
   consuming agent swaps its N `asAgentTool` wraps for one combo
   wrap whose wire schema narrows the op enum to that agent's
   authority. Prompt strings inside agent files that name tools
   op-ify too (e.g. reflection.ts:345-361 names
   followup_list/save/close in prose).
4. **Prompt prose + docs.** Toolbox description prose that names
   tools by hand (`alwaysOnToolbox` reads list,
   `src/lib/tools/index.ts:286-294`; `cookingToolbox` names
   `recipe_record_create`, `:349-352`; `followupsToolbox` names
   `followup_list`, `:471-472`; `libraryToolbox` names reads,
   `:506-510`) updates in the same milestone. So does `docs/user/`
   (observable tool names), the per-feature dev doc, `../tools.md`
   counts, and the cluster's QA use case.

Verified facts the milestones rely on:

- **Image harvest is structural, not name-keyed.**
  `extractGeneratedImage(o.result)` reads the result envelope;
  a combo `image` tool needs zero orchestrator changes
  (`getStreamingResponse.ts:1028-1033`).
- **Recipe, doc, and image tools have no agent consumers** - grep
  of every `asAgentTool` call site shows none. Those milestones are
  chat-only.
- **`followups` has exactly one agent consumer**: reflection uses
  `followupList` / `followupSave` / `followupClose` and never
  `followup_dismiss` (`agents/reflection.ts:383-385`, wires at
  `:184`, `:198`, `:245`).
- **`wiki` + `records` have three agent consumers**:
  `agents/wiki.ts` (wiki search/save/delete; record list/create/
  update/delete/link_create/file_attach; toolbox at `:1022-1032`),
  `agents/wiki_librarian.ts` (wiki search + no-create save via
  `asAgentToolNoCreate`; record list/create/update/delete +
  link_create/link_delete; `:458-464`), and `agents/wiki_records.ts`
  (wiki search/list; record list/create/link_create/file_attach;
  `:341-350`).

## MILESTONES

Order rationale: chat-only clusters first to build muscle on the
merge pattern with zero agent coupling; then the one-consumer
cluster; then the three-consumer cluster; close-out last. Each
milestone is a branch, PR, merge (deploy via CI), and live-thread
verification.

### M1 - `recipe_photos` (4 tools to 1)

- Ops: `attach` / `remove` / `reorder` / `label`.
- Edge: `tools/recipe_photos.ts` already holds all four impls in one
  file - collapse the four registrations into one combo def; bodies
  become per-op internals unchanged. Delete the four browser schema
  files; add `recipe_photos.schema.ts`.
- Chat-only. The `cookingToolbox` description says "attach, remove,
  reorder, and caption" without naming tools - no prose change.
- Tests: port the photo-tool assertions to op-parameterized form;
  add a registry test (retired names gone, combo registers once).

### M2 - `image` (4 tools to 1)

- Ops: `generate` / `edit` / `upscale` / `remove_bg`.
- The four impls share `_image_ops.ts` + the `__generated_image`
  envelope (`../tools.md:245-258`); the envelope, the per-round
  attach, and the descriptor flow are untouched.
- Chat-only. `formatArgs` renders op first, then filename/prompt.
- Tests: `image-op-tools.test.ts`, `tests/generated-image.test.ts`.

### M3 - `recipes` (4 tools to 1)

- Ops: `list` / `get` / `save` / `delete`. The save op keeps
  `recipe_save`'s full guard set - its schema is the largest in the
  catalog (`src/lib/tools/recipe_save.schema.ts`, 7KB source) and
  every observed-failure guard survives verbatim, compressed
  per the collapse pattern.
- Chat-only. Tests: `recipe_save.test.ts`,
  `recipe_save_edit_form.test.ts` (edit-by-id form becomes
  `op=save` + id), `orchestrator.test.ts` fixtures that name
  recipe tools.

### M4 - `recipe_records` (6 tools to 1)

- Ops: `list` / `get` / `search` (absorbed always-on reads) +
  `create` / `update` / `delete`.
- First read-absorbing milestone: the combo rides the `cooking`
  toolbox; `alwaysOnToolbox` description prose drops the
  recipe_record reads (`index.ts:291-294`) and `cookingToolbox`
  op-ifies its `recipe_record_create` capture trigger (`:349-352`).
- Chat-only. Tests: `recipe_record_tools.test.ts`. QA:
  `recipe-records.md` baseline + re-run.

### M5 - `docs` (6 tools to 1)

- Ops: `list` / `get` / `grep` / `read` / `save` / `delete`.
- Chat-only. Fix pre-existing drift while in the file:
  `libraryToolbox`'s description says "(doc_update)" but no such
  tool exists - save updates by id (`index.ts:506-510`).
- Tests + QA: `library-document-workflow.md` baseline + re-run.

### M6 - `followups` (4 tools to 1) - first agent-coupled milestone

- Ops: `list` / `save` / `close` / `dismiss` (read absorbed).
- reflection.ts gets one `followups` combo wire with ops narrowed
  to `[list, save, close]`; its prompt prose
  (`reflection.ts:345-361`) switches to op forms; its three wire
  consts are deleted.
- `followupsToolbox` + `alwaysOnToolbox` prose updated.
- Tests: `reflection.test.ts`. QA: `followup-capture.md`,
  `followup-inspector.md` baselines + re-runs.

### M7 - `wiki` (5 tools to 1)

- Ops: `search` / `list` / `get` / `save` / `delete` - the exact
  skills op-set. `wiki_librarian` stays solo (a delegation agent,
  not a resource verb).
- Agent consumers: `wiki.ts` (search/save/delete), `wiki_librarian.ts`
  (search + save under `asAgentToolNoCreate`, delete under
  `asAgentToolNoThread`), `wiki_records.ts` (search/list). The
  no-create guard re-expresses cleanly: the combo's save is
  create-or-update-by-id, and the wrapper's id-present check
  (`wiki_librarian.ts:440-448`) already rejects the create form.
- `alwaysOnToolbox` prose drops the wiki reads it names.
- Tests: `wiki.test.ts`, `wiki_librarian.test.ts`,
  `tests/wiki-librarian-run.test.ts`. QA: `wiki-chat-crud.md`,
  `wiki-editor-agent-update.md` baselines + re-runs.

### M8 - `records` (6 tools to 1)

- Ops: `list` / `get` / `search` / `create` / `update` / `delete`.
- **Split decision (D1):** `record_file_attach` / `_remove` and
  `record_link_create` / `_delete` stay verb tools. A 10-op flat
  param space crowds descriptions with per-op qualifiers (the exact
  confusion this plan is removing), and keeping them verbal keeps
  every agent's file/link wires untouched.
- Agent consumers per combo: `wiki.ts` (list/create/update/delete),
  `wiki_librarian.ts` (list/create/update/delete),
  `wiki_records.ts` (list/create). Each gets a narrowed op enum.
- `alwaysOnToolbox` prose drops the record reads;
  `wikiToolbox` description names ops.
- Tests: `tests/wiki-records.test.ts`,
  `wiki_records.test.ts`, `wiki_favorite_lock.test.ts`. QA:
  `wiki-records.md`, `wiki-record-files-and-links.md` (the latter
  should pass unchanged - its tools are untouched).

### M9 - audit + close-out

- `rg` for every retired tool name across `src/`,
  `supabase/functions/`, `docs/`, prompts: zero hits outside
  commentary about persisted history. Knip green (no orphaned
  helpers in `_recipe_helpers.ts` / `_record_helpers.ts`).
- `../tools.md` counts + examples refreshed; feature dev docs
  (`cookbook.md`, `library.md`, `followups.md`, `wiki.md`)
  consistent; `docs/user/` sweep verified (known mention counts at
  proposal time: cookbook.md 3, wiki.md 9, followups.md 1,
  background.md 1, models.md 1, README.md 1).
- Full gate + one final live-thread pass over a representative
  recipe / doc / wiki / record flow.

### Per-milestone procedure (every milestone)

1. Baseline: re-execute the cluster's QA use case against unchanged
   code; append the run to its results log.
2. Merge the browser schema; delete retired schema files.
3. Merge the edge impl behind the op switch; delete retired impls;
   update the `tools/index.ts` barrel (both sides).
4. Adapt agent toolboxes (where any) with narrowed combo wires;
   op-ify agent prompt strings that name tools.
5. Update toolbox-description prose, `docs/user/`, the feature dev
   doc, and `../tools.md` counts in the same commit.
6. Update tests; run `mise run check` and
   `cd supabase/functions && deno test --allow-all`.
7. Re-execute the QA use case; log both runs (before/after pairs).
8. Merge (deploy), then verify the op surface in a live thread.

## TESTING

- Per-op required-field validation moves into ArgErrors; per the
  `_validate.ts` contract, every existing error substring survives
  verbatim so assertions port mechanically.
- New per-combo registry test mirroring `skills_barrel.test.ts`:
  retired names absent from `TOOLS`, combo registers once, unknown
  op rejected.
- `tests/system-prompt.test.ts` catalog assertions update per
  milestone (line counts and names).
- The `activity` narration param is untouched - injected once per
  call at `toOpenAIToolDef` regardless of combo shape.

## RISKS

- **Cache re-warm per milestone.** The wire array is byte-stable
  within a milestone but changes at each merge; Venice re-warms the
  prefix once. Accepted; the end-state array is ~30% smaller.
- **Model re-learning at each merge.** The skills mitigation - op
  pairings carried in per-param descriptions - is copied to every
  combo, so the model rarely needs the ArgErrors round trip to
  learn a pairing.
- **Agent prompt drift.** Three agents name merged tools in prose;
  missing one in M6/M7/M8 leaves the agent model calling a retired
  name, which the dispatcher reports as unknown-tool (recoverable
  but noisy). The per-milestone checklist includes the prose sweep.
- **Old rows.** Persisted `tool_calls` rows keep retired names;
  they render via the generic formatter fallback. No migration.

## DECISIONS (resolved)

- **D1 - `records` splits from files/links.** CRUD merges (6 ops);
  the four file/link tools stay verbs. Rationale above.
- **D2 - `memories` stays verb-shaped.** The agent toolboxes
  substitute `memory_invalidate` for `memory_delete` on purpose
  ("don't collapse the two", `src/lib/tools/index.ts:37-45`); a
  combo would need divergent op enums over one impl. Deferred to
  Tier 3 thinking.
- **D3 - `wiki_librarian` stays solo.** Delegation agent, not a
  resource verb.
- **D4 - Tier 3 deferred.** The recall trio (layer enum),
  `conversations`, and the analyze pair are future work; this plan
  ships Tiers 1-2 only.
