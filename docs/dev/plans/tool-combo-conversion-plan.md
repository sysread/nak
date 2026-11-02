# Tool Combo Conversion Plan (Tier 1 + Tier 2)

Status: PROPOSED 2026-11-02, revised after deep-mode refinement round 1
(seven lenses; findings folded in). One cluster per milestone; each
milestone ships as its own deploy.

Read [`../tools.md`](../tools.md) first - this plan assumes its
vocabulary (`ToolDef`, `buildToolList`, `performToolCall`, agent
toolboxes, `asAgentTool`) and its "Toolbox model" section for why
nothing here changes enablement.

## SYNOPSIS

Convert 39 verb-shaped tools into 8 combination tools behind `op`
enum discriminators, following the `skills` precedent (the first
combo tool, and the #544 upsert consolidation before it). Eight
merged clusters plus a final audit milestone take the main-chat
catalog from 65 tools to 34. Each milestone merges the browser
schema, merges the edge impl behind an op switch, adapts the agent
toolboxes that wrap the merged impls, updates prompt prose and docs
and tests, deletes the retired files, deploys, and verifies in a
live thread.

## PURPOSE

1. **Wire token cost.** The full declared set measured ~72k chars
   (~18k tokens) at a then-60-tool catalog (`../tools.md:73-82`);
   the registry has since grown to 65 tools. The 39 merged verbs
   carry ~47k wire chars at the measured ~1200-char/tool average;
   8 merged defs replace them at a skills-calibrated ~2-3k chars
   each, for a net of roughly 25-30k chars - on the order of 5-7k
   tokens off the uncached prefix (first turn of every conversation,
   every cache miss) and a net -31 lines from the system-prompt
   catalog (39 removed, 8 added). The estimate is hedged on purpose;
   M9 re-measures the real array. Prompt caching absorbs repeat cost
   either way; this attacks the uncached floor.
2. **LLM uncertainty.** The catalog's near-duplicate name families
   (`record_get` / `wiki_get` / `doc_get` / `recipe_record_get`;
   `record_list` / `recipe_record_list`) are the fat-finger surface.
   Resource-named combos with op enums collapse the choice to "which
   store, which op".
3. **The combo form is proven in production here, twice.** The
   #544 consolidation (commit `006ef368`, 2026-09-08) merged the
   create/update verb twins into upsert tools (60 -> 56 tools,
   "~921 tokens saved") and taught the impl-side pattern: the flat
   JSON Schema cannot express conditional requirements, so the
   impl enforces them. The `skills` combo went further (one tool,
   op enum) on 2026-10-29 live calibration: no tools-array cap,
   the model composes op + params reliably under free choice, and
   the enum form is smaller on the wire than oneOf variants
   (`src/lib/tools/skills.schema.ts:5-10`). Token savings was not
   the skills commit's stated driver - it chose the form for a new
   feature after measuring; this plan extends the proven form to
   the existing catalog.

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
- **Edge impl** (`supabase/functions/venice/tools/skills.ts`):
  one `registerTool` def (`:453`), a `VALID_OPS` const (`:65`), an
  op switch (`:432-449`), and `ArgErrors` accumulation
  (`tools/_validate.ts`) for every per-op required field. The
  inline switch is the template - a shared `opSwitch` helper was
  evaluated and rejected in refinement: the per-op required-field
  rules carry bespoke error wording the `_validate.ts` contract
  preserves verbatim (`_validate.ts:11-15`), and a map-driven
  helper pulls that wording away from the per-op bodies.
- **Legacy rows keep rich rendering by construction.** Each combo's
  `formatArgs` renders op-first when `op` is present and falls back
  to the legacy verb-shaped field rendering when it is not (rows
  persisted under a retired name carry no `op`). The generic JSON
  formatter remains the backstop for anything the combo formatter
  does not recognize (`src/lib/tools/index.ts:658-662`).
- **Agent adaptation precedent.** `asAgentTool(tool, wire)`
  (`supabase/functions/venice/agents/_agent_tools.ts:23-36`) wraps a
  registered impl with an agent-pinned wire schema. Two agents
  hand-roll instead: `agents/wiki_recall.ts:155-165` defines its own
  single-tool AgentTool calling `wikiSearch.execute` directly, and
  `agents/context.ts:182-183` calls `wikiSearch.execute` /
  `followupList.execute` inline. Both consume the same registered
  impls the plan merges, so both are in milestone scope. The
  librarian's `asAgentToolNoCreate` wrapper
  (`agents/wiki_librarian.ts:435-452`) is the model for narrowing a
  merged surface per agent: the wire enum narrows what the model
  sees, and the impl's op switch + ArgErrors still reject anything
  the enum should have prevented (the central validator's enum
  check on the agent path runs before the impl,
  `agents/_run.ts:202`).

## DESIGN: what changes per merged cluster

1. **Browser schema.** N schema files become one `<name>.schema.ts`
   (op enum + flat params + op-aware `formatArgs` with the
   legacy-shape fallback above). Retired schema files deleted. The
   merged tool keeps a `<50-char` `shortDescription` for the
   catalog.
2. **Edge impl.** The per-op bodies survive as internal functions;
   the combo file registers one ToolDef whose `execute` switches on
   `op` (inline skills.ts style - no shared helper). Retired impl
   files deleted; `tools/index.ts` barrel imports updated.
3. **Agent toolboxes** (only clusters with agent consumers). Each
   consuming agent swaps its per-verb wraps for the combo def with
   a wire schema that narrows the op enum to that agent's
   authority; hand-rolled consumers (wiki_recall, context) swap
   their direct `execute` calls to the combo def with explicit
   `op`. Prompt strings inside agent files that name tools
   op-ify too (e.g. reflection.ts:345-361 names
   followup_list/save/close in prose). Per the recorded policy
   (`_agent_tools.ts:1-7`, since `b629e3ee` 2026-06-12), wires stay
   per-file when agent-flavored; `_agent_tools.ts` is the shared
   home only if two agents want a byte-identical combo wire.
4. **Prompt prose + docs.** Hand-written prose that names tools:
   toolbox description prose in `src/lib/tools/index.ts`
   (`alwaysOnToolbox` reads list `:286-294`; `cookingToolbox`
   `:349-352`; `followupsToolbox` `:471-472`; `libraryToolbox`
   `:506-510`; `imagesToolbox` `:486-489`), the hand-written prompt
   blocks in `src/lib/chat/system-prompt.ts` (RECALL_BLOCK
   `:146,148`; WIKI_BLOCK `:201-204`; LIBRARY_BLOCK `:217-222`),
   in-app copy (`src/screens/Settings.svelte:2383-2384` names
   `wiki_search`), and source comments that reference retired
   files (e.g. `src/screens/Wiki.svelte:400,576,1183`). So do
   `docs/user/`, the per-feature dev doc, `../tools.md` counts,
   and the cluster's QA use cases. The registry-built catalog
   block updates itself.

Verified facts the milestones rely on:

- **Image harvest is structural on the edge; the browser card is
  name-keyed.** `extractGeneratedImage(o.result)` reads the result
  envelope, not the tool name (`getStreamingResponse.ts:1028-1033`),
  so the edge side of a merged `image` tool needs no changes.
  Browser-side, `src/lib/ui/generated-image.ts:89-94` hardcodes
  `IMAGE_TOOL_NAMES` and `generatedImagesForGroup` filters
  `call.function.name` against it (`:111`) - M2 must update that
  set or the dedicated card silently stops rendering.
- **Recipe, doc, and image tools have no asAgentTool consumers** -
  grep of every `asAgentTool` call site shows none. Those
  milestones are chat-only.
- **`followups` has two consumers**: reflection (list/save/close,
  never dismiss - `agents/reflection.ts:383-385`, wires at `:184`,
  `:198`, `:245`) and context (`followupList.execute` inline,
  `agents/context.ts:26,183`).
- **`wiki` has five consumers and `records` has three**:
  `agents/wiki.ts` (wiki search/save/delete; record list/create/
  update/delete/link_create/file_attach; `:1022-1032`),
  `agents/wiki_librarian.ts` (wiki search; no-create save via
  `asAgentToolNoCreate`; delete via `asAgentToolNoThread`; record
  list/create/update/delete/link_create/link_delete; `:461-471`),
  `agents/wiki_records.ts` (wiki search/list; record
  list/create/link_create/file_attach; `:341-350`),
  `agents/wiki_recall.ts` (hand-rolled wiki_search wrapper,
  `:155-165`), and `agents/context.ts` (inline wikiSearch +
  followupList executes, `:182-183`).

## MILESTONES

Order rationale: chat-only clusters first to build muscle on the
merge pattern with zero agent coupling; then the agent-coupled
clusters smallest-surface first; close-out last. Each milestone is
a branch, PR, merge (deploy via CI), and live-thread verification.

### M1 - `recipe_photos` (4 tools to 1)

- Ops: `attach` / `remove` / `reorder` / `label`. The
  cookingToolbox prose ("caption recipe photos") aligns to `label`
  in this milestone.
- **Intent note (from archaeology):** three of the four verbs were
  a recorded anti-merge decision - commit `a49dd52d` (2026-05-02,
  attach/remove/reorder): "The verbs are split rather than folded
  into a multi-mode tool because 'set the photo set to X' is the
  kind of contract that invites the LLM to forget to enumerate the
  existing photos and silently clear them. Each verb's contract is
  closed." (`recipe_photo_label_set` arrived later, `4dbadf65`
  #545 2026-09-08, with no recorded rationale either way.) The
  merge does not reopen that contract: every per-op body, closed
  contract, and required field survives unchanged - only the
  envelope changes from name-to-name to name-plus-op, the same
  mechanism the skills calibration proved the model composes
  reliably. `reorder` keeps its full-permutation form.
- Edge: `tools/recipe_photos.ts` already holds all four impls in
  one file - collapse the four registrations into one combo def;
  bodies become per-op internals unchanged. Delete the four browser
  schema files; add `recipe_photos.schema.ts`.
- Chat-only.
- **Pre-merge dependency: write impl tests first** - no edge test
  touches `recipe_photos.ts` today (the
  `recipe_record_tools.test.ts` FIFO harness ports directly).
- Tests: the new impl tests; registry test (retired names gone,
  combo registers once).

### M2 - `image` (4 tools to 1)

- Ops: `generate` / `edit` / `upscale` / `remove_bg`.
- The four impls share `_image_ops.ts` + the `__generated_image`
  envelope (`../tools.md:245-258`); the envelope, the per-round
  attach, and the descriptor flow on the edge are untouched
  (harvest is envelope-keyed, `getStreamingResponse.ts:1028-1033`).
- **Browser scope the refinement added:** update
  `IMAGE_TOOL_NAMES` in `src/lib/ui/generated-image.ts:89-94` to
  the merged name (or render op-aware) - the card filter is
  name-keyed and the card exists because assistant-row attachments
  do not rehydrate over realtime (`generated-image.ts:10-19`).
- Chat-only. `formatArgs` renders op first, then filename/prompt.
- `imagesToolbox` description names all four retired tools
  (`index.ts:486-489`) - update.
- Tests: `image-op-tools.test.ts`, `tests/generated-image.test.ts`,
  `tests/message-blocks.test.ts:292-314`. QA:
  `chat-generated-image-card.md`, `image-editing.md`,
  `chat-regenerate-from-here.md` baselines + re-runs.

### M3 - `recipes` (4 tools to 1)

- Ops: `list` / `get` / `save` / `delete`. The save op keeps
  `recipe_save`'s full guard set - its schema is the largest in the
  catalog (`src/lib/tools/recipe_save.schema.ts`, 7033 bytes) and
  every observed-failure guard survives verbatim, compressed per
  the collapse pattern.
- Chat-only. **First read-absorbing milestone:** `recipe_list` /
  `recipe_get` are always-on reads, so this milestone drops them
  from the `alwaysOnToolbox` description prose (`index.ts:291-294`).
- **Pre-merge dependency: write impl tests for `recipe_list` /
  `recipe_get` first** (zero coverage today; save and delete are
  covered by `recipe_save.test.ts`, `recipe_save_edit_form.test.ts`
  - edit-by-id becomes `op=save` + id - and
  `tool-batch.test.ts:251-258`).
- Tests: `tests/tools.test.ts` toolbox-membership arrays.
- QA: `cookbook-recipe-lifecycle.md`, `cookbook-save-validation.md`
  baselines + re-runs.

### M4 - `recipe_records` (6 tools to 1)

- Ops: `list` / `get` / `search` (absorbed always-on reads) +
  `create` / `update` / `delete`.
- The combo rides the `cooking` toolbox; `alwaysOnToolbox`
  description prose drops the recipe_record reads
  (`index.ts:291-294`) and `cookingToolbox` op-ifies its
  `recipe_record_create` capture trigger (`:349-352`).
- Chat-only. Tests: `recipe_record_tools.test.ts` covers all six
  impls (best-covered cluster in the repo) - ports mechanically;
  keep the `['string','null']` null-outcome shape the test pins.
  `tool-batch.test.ts:31` imports `recipeRecordDelete` directly.
  QA: `recipe-records.md` baseline + re-run.

### M5 - `docs` (6 tools to 1)

- Ops: `list` / `get` / `grep` / `read` / `save` / `delete`.
- Chat-only. Fix pre-existing drift while in the file:
  `libraryToolbox`'s description says "(doc_update)" but no such
  tool exists - save updates by id (`index.ts:506-510`).
- **Prompt scope:** `system-prompt.ts` LIBRARY_BLOCK (`:217-222`)
  names all six `doc_*` tools - op-ify.
- **Pre-merge dependency: write impl tests first** (no test
  imports any `doc_*` tool today; cover save + delete + one read).
- QA: `library-document-workflow.md` baseline + re-run.

### M6 - `followups` (4 tools to 1) - first agent-coupled milestone

- Ops: `list` / `save` / `close` / `dismiss` (read absorbed).
- reflection.ts gets one `followups` combo wire with ops narrowed
  to `[list, save, close]`; its prompt prose
  (`reflection.ts:345-361`) switches to op forms; its three wire
  consts are deleted. context.ts swaps its inline
  `followupList.execute` (`:183`) to the combo def.
- The "reflection never dismisses" veto was structural (tool absent
  from toolbox) and becomes enum narrowing - the ported composition
  test must assert the op enum exactly.
- `followupsToolbox` + `alwaysOnToolbox` prose updated.
- **Pre-merge dependency: write impl tests for the four ops first**
  (no test imports any `followup_*` tool today).
- Tests: `reflection.test.ts` composition port. QA:
  `followup-capture.md`, `followup-inspector.md`,
  `followup-semantic-recall.md` (`:112` names `followup_close`),
  `followup-date-due.md` (`:83`) baselines + re-runs.

### M7 - `wiki` (5 tools to 1)

- Ops: `search` / `list` / `get` / `save` / `delete` - the exact
  skills op-set. `wiki_librarian` stays solo (a delegation agent,
  not a resource verb).
- Agent consumers: `wiki.ts` (search/save/delete), `wiki_librarian.ts`
  (search; save under `asAgentToolNoCreate`; delete under
  `asAgentToolNoThread`), `wiki_records.ts` (search/list),
  `wiki_recall.ts` (hand-rolled search wrapper, `:155-165`),
  `context.ts` (inline search execute, `:182`). The no-create guard
  re-expresses cleanly: the combo's save is create-or-update-by-id,
  and the wrapper's id-present check
  (`wiki_librarian.ts:440-448`) already rejects the create form -
  **add a wrapper-rejection test for it** (the guard is untested
  today, and it is the safety invariant this milestone touches).
- `alwaysOnToolbox` prose drops the wiki reads it names;
  `system-prompt.ts` RECALL_BLOCK (`:146,148`) and WIKI_BLOCK
  (`:201-204`) op-ify; `Settings.svelte:2383-2384` copy updates;
  `Wiki.svelte` comments referencing the deleted files rot-fix.
- Tests: `wiki.test.ts`, `wiki_librarian.test.ts`,
  `wiki_favorite_lock.test.ts` (save/delete lock guards),
  `tool-batch.test.ts:27-32` (imports `wikiDelete` directly).
  QA: `wiki-chat-crud.md` and `wiki-editor-agent-update.md`
  baselines with re-runs.

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
- **Pre-merge dependency: write impl tests for the five uncovered
  ops first** (only `recordDelete` has coverage, via
  `tool-batch.test.ts:260-287`).
- Tests: `wiki_records.test.ts` (composition port pins the
  extraction agent's authority narrowing),
  `wiki_favorite_lock.test.ts`. QA:
  `wiki-records.md` baseline + re-run;
  `wiki-record-files-and-links.md` should pass unchanged - its
  tools are untouched.

### M9 - audit + close-out

- `rg` for every retired tool name across `src/`,
  `supabase/functions/`, `docs/`, prompts: zero hits outside
  commentary about persisted history and test fixtures (sample
  strings in `thread-transcript.test.ts:95-117`,
  `empty-rows.test.ts:48`, `accumulator.test.ts:107`,
  `bundle-research-docs.test.ts:58-101` are data, not wiring - the
  sweep whitelists fixture literals).
- Knip green (no orphaned helpers in `_recipe_helpers.ts` /
  `_record_helpers.ts`).
- Re-measure the wire: rebuild `buildToolList()` output and record
  the char count against the pre-conversion baseline (updates the
  figure PURPOSE 1 hedges).
- `../tools.md` counts + examples refreshed; feature dev docs
  (`cookbook.md`, `library.md`, `followups.md`, `wiki.md`)
  consistent; `docs/user/` sweep verified (known baseline at
  proposal time: cookbook.md 5 lines, wiki.md 10 occurrences on 9
  lines, followups.md 1, background.md 1, models.md 1, README.md 1).
- Full gate + one final live-thread pass over a representative
  recipe / doc / wiki / record flow.

### Per-milestone procedure (every milestone)

1. Baseline: re-execute the cluster's QA use case against unchanged
   code; append the run to its results log.
2. Pre-merge dependency first (M1/M3/M5/M6/M7/M8): impl tests for
   uncovered ops, green against the unmerged code.
3. Merge the browser schema; delete retired schema files.
4. Merge the edge impl behind the op switch; delete retired impls;
   update the `tools/index.ts` barrel (both sides).
5. Adapt agent toolboxes (where any) with narrowed combo wires;
   op-ify agent prompt strings that name tools.
6. Update toolbox-description prose, hand-written system-prompt
   blocks, in-app copy, `docs/user/`, the feature dev doc, and
   `../tools.md` counts in the same commit.
7. Update tests, including the
   `supabase/functions/tests/skills_barrel.test.ts:34-36`
   `MIN_REGISTERED_TOOLS` floor (bump DOWN per milestone; the
   comment there says to). Run `mise run check` and
   `cd supabase/functions && deno test --allow-all`.
8. Watch #544's QA-surfaced bug classes on every merge that
   combines create+update paths: natural-key dedup bypassed on the
   create form, ILIKE pattern missing `%` escaping when query
   handling merges.
9. Re-execute the QA use case; log both runs (before/after pairs).
10. Merge (deploy), then verify the op surface in a live thread.

## TESTING

- Per-op required-field validation moves into ArgErrors; per the
  `_validate.ts` contract, every existing error substring survives
  verbatim so assertions port mechanically.
- New per-combo registry test mirroring `skills_barrel.test.ts`:
  retired names absent from `TOOLS`, combo registers once, unknown
  op rejected.
- `tests/system-prompt.test.ts` catalog assertions update per
  milestone (line counts and names). So does `tests/tools.test.ts`
  (exact toolbox tool-name arrays, `:88-176`) - every milestone
  touches it; it is gate-loud, but named here so the sweep is
  mechanical.
- The `activity` narration param is untouched - injected once per
  call at `toOpenAIToolDef` regardless of combo shape.
- Edge tests dispatch by calling registered ToolDefs' `execute()`
  with stubbed clients (the op switch is inside `execute`), so a
  port is "change the import, add `op:` to the args"; the worked
  example is `supabase/functions/tests/skills_tool.test.ts`.

## RISKS

- **Cache re-warm per milestone.** The wire array is byte-stable
  within a milestone but changes at each merge; Venice re-warms the
  prefix once. Accepted; the end-state array is materially smaller
  (re-measured at M9).
- **Model re-learning at each merge.** The skills mitigation - op
  pairings carried in per-param descriptions - is copied to every
  combo, so the model rarely needs the ArgErrors round trip to
  learn a pairing.
- **Agent prompt drift.** Six agent files name merged tools in
  prose or wrap merged impls; missing one in M6/M7/M8 leaves the
  agent model calling a retired name or the agent's import failing
  the deno build (loud, recoverable). The per-milestone checklist
  includes the prose + import sweep.
- **Mixed-version window.** A stale cached PWA arms retired names
  against a deployed merged function; dispatch throws the
  unknown-tool error, which the model sees and can recover from
  (`performToolCall.ts:214-219`). Expected for one deploy window;
  not a defect.
- **Old rows.** Persisted `tool_calls` rows keep retired names;
  combo `formatArgs` handles the legacy arg shape (no `op`), and
  the generic formatter remains the backstop. No migration.

## DECISIONS (resolved)

- **D1 - `records` splits from files/links.** CRUD merges (6 ops);
  the four file/link tools stay verbs. A 10-op flat param space
  crowds per-op qualifier descriptions, and the split keeps three
  agents' file/link wires untouched.
- **D2 - `memories` stays verb-shaped.** The agent toolboxes
  substitute `memory_invalidate` for `memory_delete` on purpose
  ("don't collapse the two", `src/lib/tools/index.ts:37-45`;
  the rule dates to `5897b246` 2026-04-19 and docs/dev/memory.md's
  invalidate-vs-delete gotcha); a combo would need divergent op
  enums over one impl. Deferred to Tier 3 thinking.
- **D3 - `wiki_librarian` stays solo.** Delegation agent, not a
  resource verb.
- **D4 - Tier 3 deferred.** The recall trio (layer enum),
  `conversations`, and the analyze pair are future work; this plan
  ships Tiers 1-2 only.
- **D5 - Alternatives evaluated and dominated** (refinement round
  1, alternatives lens): description-collapse alone delivers
  roughly a quarter of the token savings and none of the
  confusion fix (the near-duplicate names stay); a mega-combo
  (resource+op two-level discriminator) breaks per-agent op-enum
  narrowing and re-bloats descriptions with qualifiers. Both cost
  the same cache re-warm as the merge. Rejected.
- **D6 - M1 rebuts the 2026-05-02 anti-merge rationale on
  record.** The a49dd52d rationale targeted a "set the photo set"
  multi-mode contract; the combo preserves every closed per-op
  contract and swaps only the envelope. Recorded here so a future
  session does not read the merge as an accident.
