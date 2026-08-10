# Architecture audit fixes (in progress)

> **Status: planning complete; implementation not started.** Thirteen issues found by a full-codebase audit for
> separation of concerns and code reusability. This doc is the work plan. We go through them one at a time, test with
> Playwright as we go, and mark each complete here. When all are done, graduate any durable lessons into permanent docs
> and retire this file.

## How to use this doc

Each fix has a status marker:

- `[ ]` - not started
- `[~]` - in progress
- `[x]` - complete

Fixes are ordered by priority: divergences and dead code first (small diffs, high risk), then structural splits (large
diffs, medium risk), then minor cleanups.

Run `mise run check` after each fix. For fixes that touch the chat streaming path, also smoke-test with Playwright (send
a message, verify the response streams, check that tools still dispatch). For fixes that touch only edge function code,
run `mise run functions-check` and `mise run functions-test`.

### Running notes

Each fix gets a companion scratch doc at `docs/dev/in-progress/audit-fix-N.md` (e.g. `audit-fix-5.md`). The scratch doc
tracks the conceptual stack: things discovered mid-fix, ordering changes, sub-problems that push or append. Refactoring
uncovers dependencies. The scratch doc is where the stack gets worked out before the code lands.

Create the scratch doc when starting a fix. Update it as the stack grows. Delete it (or fold durable findings into the
plan doc or permanent dev docs) when the fix completes.

## Fix 1: Align RETRY_TEMPERATURE_SCHEDULE [x]

**Problem.** The stream guard retry schedule is defined in two places and has already drifted. The browser has `[0.8,
1.0]` (2 entries). The edge has `[0.8, 1.0, 1.2, 1.4]` (4 entries). The edge was expanded for deepseek-v4-flash. The
browser was never updated.

The browser copy is in `src/lib/stream-guards.ts:91`. The edge copy is in
`supabase/functions/venice/stream-guards.ts:42`.

**Root cause.** Guard execution moved server-side. The browser file kept its own copy of the schedule but no longer runs
it. The edge copy got updated independently.

**Fix.** This is coupled to Fix 5 (delete dead browser guard code). The browser's `RETRY_TEMPERATURE_SCHEDULE` is dead -
the browser never executes retries. Rather than aligning the values, delete the browser copy entirely as part of Fix 5.
Leave the edge copy as the single source.

**If Fix 5 is deferred** and this is done standalone: update the browser value to match the edge (`[0.8, 1.0, 1.2,
1.4]`) so they don't diverge further, and add a parity test that compares the two arrays.

**Test.** `mise run check`. No Playwright needed - the browser schedule is not on the production path.

**Files.** `src/lib/stream-guards.ts`, `supabase/functions/venice/stream-guards.ts`, possibly
`tests/stream-guards.test.ts`.

## Fix 2: Split venice.ts into three modules [x]

**Problem.** `src/lib/venice.ts` is 2036 lines and mixes three transport layers that have nothing to do with each other:

1. Venice API wire types and client (~800 lines)
2. Supabase Realtime Broadcast subscription (~360 lines)
3. Chat-loop recovery and control (~130 lines)

It also contains ~320 lines of test-only code (`streamChatDirect` + `parseSseFrame`) in a production module, and dead
exports (`ImageGenRequest`, `ImageGenResult`) with zero consumers.

**Fix.** Split into:

- `src/lib/venice.ts` - wire types, `VeniceClient`,
`buildChatBody`, `parseChatCompletion`. Drops to ~1100 lines and matches its docstring.
- `src/lib/chat/stream-transport.ts` -
`setupStreamSubscription`, `StreamSubscription`, `StreamEnvelope`, `streamChatViaFunction`, `awaitStreamSettled`,
`cancelStream`, `StreamDisconnectedError`. The producer half of the `stream-events.ts` consumer. ~580 lines.
- Delete `ImageGenRequest` / `ImageGenResult` (dead
exports, zero consumers).
- Move `parseSseFrame` + `streamChatDirect` to a test
helper or co-locate with the test-only direct path. These are ~320 lines of test scaffolding in a production module.

**Migration approach.** Move in this order to keep the diff reviewable:

1. Delete dead exports (`ImageGenRequest`,
`ImageGenResult`). Run `mise run check`.
2. Move `awaitStreamSettled` + `cancelStream` +
`StreamDisconnectedError` to `src/lib/chat/stream-transport.ts`. Update imports in `Chat.svelte`. Run `mise run check`.
3. Move `setupStreamSubscription` +
`StreamSubscription` + `StreamEnvelope` + `streamChatViaFunction` to the same file. Update imports. Run `mise run
check`.
4. Move `parseSseFrame` + `streamChatDirect` to a test
helper. Run `mise run check`.

**Test.** `mise run check` after each sub-step. Playwright after step 3: send a chat message, verify the response
streams, verify cancel works (stop a mid-generation response), verify reconnect works (refresh during a stream).

**Files.** `src/lib/venice.ts`, new `src/lib/chat/stream-transport.ts`, `src/Chat.svelte`,
`src/lib/chat/stream-events.ts`, `src/lib/chat/loop.ts`, `tests/venice.test.ts`.

## Fix 3: Extract MCP OAuth handlers from router [x]

**Problem.** Three MCP route handlers in `supabase/functions/venice/index.ts` contain ~410 lines of inline OAuth
orchestration:

- `handleMcpRegister` (lines 1521-1751, 230 lines):
scope resolution, DCR, PKCE, row persistence
- `handleMcpTokenExchange` (lines 1768-1879, 112 lines):
token exchange, store, status update
- `handleMcpRefresh` (lines 1886-1954, 68 lines): token
refresh, store

The pure helpers already live in `mcp/oauth.ts` and `mcp/token-store.ts`. The routing layer should be validation +
delegate, matching every other route.

**Fix.** Extract the orchestration to `supabase/functions/venice/mcp/handlers.ts` (or per-route modules:
`mcp/register.ts`, `mcp/token-exchange.ts`, `mcp/refresh.ts`). index.ts goes back to one-line delegation for these
routes.

**Test.** `mise run functions-check` + `mise run functions-test`. Playwright: open Settings > Integrations, add an MCP
server URL, verify the OAuth redirect flow fires, verify a configured integration shows up in the list.

**Files.** `supabase/functions/venice/index.ts`, new `supabase/functions/venice/mcp/handlers.ts` (or per-route files).

## Fix 4: Extract agent model IDs to shared module [x]

**Problem.** Every edge agent hardcodes its model ID as a const with a "Mirror of agentModel('xxx').id" comment.
Ten-plus files, no parity test. A model swap in the browser's `AGENT_MODELS` registry with no matching edge edit means
agents silently run on the wrong model.

**Fix.** Create `supabase/functions/_shared/agent-models.ts` with the model ID constants. The browser's `AGENT_MODELS`
map in `src/lib/models/index.ts` is already pure data - it could be the source of truth, exported through `$shared`.
Each edge agent imports from the shared module instead of hardcoding.

Check whether the browser can import `AGENT_MODELS` from `$shared/agent-models` or whether the browser's model registry
has non-portable deps (Svelte, DOM). If it does, extract just the model ID strings to the shared module and keep the
capability metadata browser-side.

**Test.** `mise run check` + `mise run functions-check`. No Playwright needed - this is constant consolidation.

**Files.** `src/lib/models/index.ts`, new `supabase/functions/_shared/agent-models.ts`, every edge agent file that
hardcodes a model ID (`reflection.ts`, `wiki.ts`, `rem.ts`, `summary.ts`, `bias.ts`, `wiki_records.ts`,
`wiki_librarian.ts`, `wiki_manual.ts`, `recipe_topics.ts`, `memory_topics.ts`, and others - grep for "Mirror of
agentModel").

## Fix 5: Delete dead browser stream-guards.ts [x]

**Problem.** `src/lib/stream-guards.ts` (218 lines) is largely dead code. `streamGuardsFor` is exported but never
imported by production code (only by `tests/stream-guards.test.ts`). `GuardExhaustedError` is the only export used in
production (by `Chat.svelte`).

The file defines its own copies of `AttemptProgress`, `GuardVerdict`, `StreamGuard`, `combineVerdicts`, and
`GuardExhaustedError` that all exist in `_shared/venice-stream.ts` - which the browser already imports from via the
`$shared` alias.

The actual guard execution moved to the edge function. The browser file is a fossil.

**Fix.** Delete the browser file. Import `GuardExhaustedError` from `$shared/venice-stream` in `Chat.svelte` instead.
Update `tests/stream-guards.test.ts` - either delete it (if it only tests the dead code) or point it at the shared
module.

This also resolves Fix 1: the dead `RETRY_TEMPERATURE_SCHEDULE` in the browser goes away.

**Test.** `mise run check`. Playwright: send a chat message using a model that triggers the special-token leak guard
(deepseek-v4-flash), verify the guard still fires server-side and the retry behavior is unchanged from the user's
perspective.

**Files.** `src/lib/stream-guards.ts`, `src/Chat.svelte`, `tests/stream-guards.test.ts`.

## Fix 6: Extract getSession to shared module [x]

**Problem.** Ten slice modules in `src/lib/supabase/` each define a private 4-line `getSession(client)` function. Same
code, 10 copies, 40 lines total.

The slices: `memories.ts`, `cookbook.ts`, `threads.ts`, `settings.ts`, `messages.ts`, `wiki.ts`, `wiki-records.ts`,
`wiki-sources.ts`, `documents.ts`, `grocery.ts`.

**Fix.** Extract to `src/lib/supabase/session.ts` (a plain function taking `SupabaseClient`, returning the session
user). The slices already import from `./error.ts` and `./query-utils.ts` - this follows the same pattern. Delete the 10
private copies, update the 10 imports.

No circular dependency: the facade imports the slices, the slices import the new session module, the session module
imports nothing from the facade.

**Test.** `mise run check`. No Playwright needed - this is mechanical dedup with no behavioral change.

**Files.** New `src/lib/supabase/session.ts`, the 10 slice modules listed above.

## Fix 7: Consolidate MAX_WIKI_CONTENT_CHARS edge-internal copies [x]

**Problem.** `MAX_WIKI_CONTENT_CHARS = 16000` appears in 5 locations. Three of those are edge-internal copies that don't
even import from the edge's own `_shared/embed-input.ts` mirror:

1. `src/lib/wiki.ts:64` (source of truth)
2. `supabase/functions/_shared/embed-input.ts:39` (edge
mirror)
3. `supabase/functions/venice/agents/wiki.ts:184`
(independent)
4. `supabase/functions/venice/tools/wiki_update.ts:36`
(independent)
5. `supabase/functions/venice/tools/wiki_create.ts:24`
(independent)

Same pattern for `MAX_WIKI_RECORD_CONTENT_CHARS = 8000` across 4 locations.

**Fix.** The edge-internal copies (items 3-5) should import from `_shared/embed-input.ts`. The cross-runtime duplication
(browser vs edge) is the Deno island pattern and stays.

After consolidation, the edge has one copy in `_shared/embed-input.ts`. The browser has one copy in `src/lib/wiki.ts`.
Add a parity test that compares the two values (same pattern as `bias-catalog-parity.test.ts`).

**Test.** `mise run check` + `mise run functions-check`. No Playwright needed - constant consolidation.

**Files.** `supabase/functions/venice/agents/wiki.ts`, `supabase/functions/venice/tools/wiki_update.ts`,
`supabase/functions/venice/tools/wiki_create.ts`, `supabase/functions/venice/agents/wiki_records.ts`,
`supabase/functions/venice/tools/_record_helpers.ts`, `supabase/functions/_shared/embed-input.ts`, new parity test file.

## Fix 8: Extract validateCooklangSource to shared module [x]

**Problem.** `validateCooklangSource` is duplicated 3 times with diverged error messages:

1. `src/lib/cooklang.ts:1332-1369` (canonical, most
complete)
2. `supabase/functions/venice/tools/recipe_save.ts:23-44`
(shorter messages)
3. `supabase/functions/venice/tools/recipe_update.ts:22-41`
(shortest messages)

The regex logic is identical. The error messages drifted: the browser copy added inline emphasis mention and expanded
remediation advice. The edge copies stayed terse.

`recipe-limits.ts` already proved the extraction pattern for this exact Deno island situation.

**Fix.** Extract `validateCooklangSource` to a standalone module both runtimes can import. Two options:

- Put it in `src/lib/recipe-limits.ts` (already exists,
already imported by both sides). Add the function there. The edge already mirrors `recipe-limits.ts` constants, so
adding the function to the mirror is natural.
- Or create `supabase/functions/_shared/cooklang-validate.ts`
and have both sides import via `$shared`.

Check which approach fits the existing import graph. The `recipe-limits.ts` approach is simpler if the edge already
imports it.

**Test.** `mise run check` + `mise run functions-check` + `mise run functions-test`. Playwright: save a recipe with a
backtick code span in the cooklang source, verify the validation error surfaces in the UI.

**Files.** `src/lib/cooklang.ts`, `src/lib/recipe-limits.ts` (or new `_shared/cooklang-validate.ts`),
`supabase/functions/venice/tools/recipe_save.ts`, `supabase/functions/venice/tools/recipe_update.ts`, edge mirror of
`recipe-limits.ts` if applicable.

## Fix 9: Extract logger wire types to shared module [x]

**Problem.** `_shared/edge-log.ts:31-40` serializes log entries that `src/lib/logger.svelte.ts:123-133` deserializes
with no runtime schema check. The edge comment warns: "MUST stay structurally identical... a drift here surfaces as a
silently mis-rendered drawer entry." No parity test.

The browser file is a `.svelte.ts` (Svelte rune module) that Deno can't import. But the types are plain TS.

**Fix.** Extract `SerializableDetail`, `SerializableLogEntry`, `LogLevel` to `supabase/functions/_shared/log-wire.ts` (a
plain `.ts` module both sides import). The browser's `logger.svelte.ts` imports the types from `$shared/log-wire` and
keeps its Svelte-specific logic. The edge's `edge-log.ts` imports from the same module.

Add a parity test if the types are structurally comparable (they're plain interfaces - deep equality on a sample entry
should work).

**Test.** `mise run check` + `mise run functions-check`. Playwright: open the Logs drawer, verify log entries render
with correct level, source, and detail fields.

**Files.** `src/lib/logger.svelte.ts`, `supabase/functions/_shared/edge-log.ts`, new
`supabase/functions/_shared/log-wire.ts`, possibly new parity test file.

## Fix 10: Extract terminal-write block from getStreamingResponse.ts [x]

**Problem.** The finally block of `getStreamingResponse.ts` (lines 1026-1178, ~155 lines) handles commit-vs-transition
branching, the `commit_assistant_message` RPC call, conflict detection, `transitionRowTo`, `stream_started_at` clearing,
`threads.last_error` assembly, and END event publishing. This is a distinct concern embedded in the orchestration flow.

Also: `attachGeneratedImages` (lines 1463-1529, 67 lines) does Storage uploads + inserts. It's a self-contained IO
side-effect.

**Fix.** Extract `commitTerminalState(opts)` to a helper module (e.g. `supabase/functions/venice/stream-commit.ts`).
Extract `attachGeneratedImages` to `supabase/functions/venice/tools/_attachment_io.ts`.

The inline closures (`ensureAssistantRow`, `scheduleRowUpdate`, `flushRowUpdate`) close over function-scoped state. Pass
that state as parameters to the extracted helper, or return an object with the closures and let the orchestrator call
them.

**Test.** `mise run functions-check` + `mise run functions-test`. Playwright: send a chat message, verify the assistant
response commits to the DB (refresh the page, the message persists). Verify a generated image tool call produces an
attachment that shows up in the message. Verify a tool error sets `threads.last_error` correctly (the error banner
shows).

**Files.** `supabase/functions/venice/getStreamingResponse.ts`, new `supabase/functions/venice/stream-commit.ts`, new
`supabase/functions/venice/tools/_attachment_io.ts`.

## Fix 11: Extract resolveStreamContext from index.ts [x]

**Problem.** `resolveStreamContext` in `supabase/functions/venice/index.ts` (lines 1089-1264, 175 lines) contains the
stale-row janitor and the `stream_started_at` pre-row probe. This is stream-lifecycle business logic, not routing glue.

**Fix.** Extract to `supabase/functions/venice/stream-probe.ts`. index.ts calls it and gets back the resolved context.

**Test.** `mise run functions-check` + `mise run functions-test`. Playwright: start a chat message, close the tab
mid-stream, reopen the thread, verify the stale-row janitor cleans up and the next message works.

**Files.** `supabase/functions/venice/index.ts`, new `supabase/functions/venice/stream-probe.ts`.

## Fix 12: Extract cooklang.ts validation and rendering [ ]

**Problem.** `src/lib/cooklang.ts` (1369 lines) mixes 6 concerns: types, parser, HTML rendering, TOC, plain-text export,
markdown export, and validation. Nearly half the file is rendering/export code with no implementation coupling to the
parser beyond the `Recipe` type.

**Fix.** This is the lowest-priority structural fix. The file is well-sectioned and the parser+renderer co-location
argument in the preamble is reasonable. Do the validation extraction (already covered as Fix 8) first. Then consider:

- Extract `recipeToHtml`, `recipeToc`, and helpers to
`src/lib/cooklang-render.ts` (~435 lines). The parser and types stay in `cooklang.ts`.
- The plain-text and markdown exports (~230 lines)
could go to `src/lib/cooklang-export.ts`. But they're small and well-sectioned. If the HTML extraction drops
`cooklang.ts` below 900 lines, the exports can stay.

**Test.** `mise run check`. Playwright: open a recipe, verify the ingredient list, instructions, and TOC render
correctly. Export a recipe to markdown, verify the output.

**Files.** `src/lib/cooklang.ts`, new `src/lib/cooklang-render.ts` (if proceeding).

## Fix 13: Fix CohortPanel inline number formatting [x]

**Problem.** `src/components/CohortPanel.svelte` lines 210, 215, 216 format `score`, `confidence`, and `health` with
inline `.toFixed()` while the adjacent line 214 calls `formatValence()` from the companion module `cohort-panel.ts`. The
inconsistency is visible within three consecutive lines.

**Fix.** Add `formatScore`, `formatConfidence`, `formatHealth` (or a shared `formatFixed(value, digits)`) to
`src/lib/ui/cohort-panel.ts`. Replace the inline `.toFixed()` calls in the markup with calls to the primitives.

**Test.** `mise run check`. Playwright: open the Samskara browse panel, navigate to a cohort view, verify the fire
metadata (score, valence, confidence, health) displays with correct formatting.

**Files.** `src/components/CohortPanel.svelte`, `src/lib/ui/cohort-panel.ts`, `tests/cohort-panel.test.ts`.

## Fix 14: Centralize tool argument validation at the dispatch points [ ]

**Problem.** Every tool hand-rolls its own argument validation. There is no central validator. The browser is the source
of truth for tool specs (`src/lib/tools/*.schema.ts`, composed by `buildToolList` in `src/lib/tools/index.ts`). The edge
function treats the wire defs as opaque (`tool_catalog.ts` reads only `function.name`). Each tool's `execute()` does its
own type checks, required-field checks, and bounds checks. The specs and the implementations have already drifted in
multiple places (`recipe_photo_label_set` read `photos`/`id` where the schema said `labels`/`photo_id`; impl caps were
lower than advertised; search limits were higher than the impl truth).

Today, 18 write tools call `rejectUnknownArgs` from `_validate.ts` to catch hallucinated parameter names. 17 read-only
tools (get, list, search) have no unknown-arg rejection at all. 21 other write/action tools also skip it, doing
hand-rolled `typeof args.x === 'string'` checks that never reject unknown keys. The result is inconsistent enforcement:
some tools reject hallucinated params, most silently ignore them.

The `ArgErrors` accumulator and `rejectUnknownArgs` helper in `_validate.ts` are good primitives. The problem is that
they are opt-in per tool, called from inside each tool's `execute()` with a hand-maintained known-arg list. If a tool
author forgets to call `rejectUnknownArgs`, or lists a known arg wrong, the model gets no feedback. The spec is the
single source of truth for what arguments are valid, but the spec never reaches the dispatch point.

**Two dispatch points, two gaps.**

The chat path: `performToolCall` (`supabase/functions/venice/performToolCall.ts:188`) takes a `ToolCallRequest` (`{ id,
name, args }`). The `REGISTRY` (`Map<string, ToolDef>`) stores only `name` and `execute`. The full JSON Schemas sit in
`body.tools` / `toolCatalog` at the orchestrator level in `getStreamingResponse.ts`, unused for validation. The schemas
never reach `performToolCall`.

The agent path: `executeToolboxCall` (`supabase/functions/venice/agents/_run.ts:186`) finds the tool by name in the
toolbox. The `AgentTool` interface (`_run.ts:71-86`) carries the wire schema alongside `execute`, so the schema IS
accessible at the agent dispatch point. But `executeToolboxCall` does no validation either.

Both dispatch points strip the `activity` narration param before calling `execute()`: the chat path at
`performToolCall.ts:199`, the agent path at `_run.ts:462-463`. The `activity` param is injected into every tool def by
`src/lib/tools/wire.ts` (`injectActivityParam`, line 236) and by `withProgressNarration` in `_run.ts:175`. It is a
harness concern, not a tool concern. Centralized validation must account for this: validate WITH `activity` (it is
declared in the schema), then strip it before `execute()`.

**Fix.** Build a central validator that runs at both dispatch points, using the tool's JSON Schema to check arguments
before `execute()` sees them. This replaces the per-tool `rejectUnknownArgs` boilerplate and closes the gap on the 38
tools that currently have no unknown-arg rejection.

What the validator checks (from the JSON Schema):

- `additionalProperties: false` rejects unknown keys (replaces
`rejectUnknownArgs`).
- `required` fields are present.
- `properties.*.type` matches the value's type.
- `properties.*.maxLength` / `minLength` bounds on strings.
- `properties.*.minimum` / `maximum` bounds on numbers.
- `properties.*.enum` values are in the set.

What the validator does NOT do:

- Coercion. The `requireFiniteNumber` helper in `_validate.ts`
accepts quoted numerics (`"5.0"`) and parses them. The central validator should either do the same coercion or leave it
to the tool. Decision: leave it to the tool for now. The central validator rejects type mismatches; tools that want
coercion keep their own `requireFiniteNumber` calls. This keeps the validator simple and avoids changing tool behavior
for the tools that already handle coercion.
- Semantic validation. "Provide at least one of X, Y" rules,
cross-field dependencies, and domain-specific bounds (like memory confidence being 1.0-10.0 "NOT a 0-1 probability")
stay in the tool. The schema can express simple constraints; the tool handles the rest.

**Implementation approach.**

1. Add a `validateToolArgs(schema, args)` function to
`supabase/functions/venice/tools/_validate.ts` (or a new `_schema_validate.ts`). It takes the tool's
`function.parameters` JSON Schema and the parsed args, runs the checks above, and throws an `ArgErrors`-style combined
error if anything fails. It must handle `activity` being present (declared in the schema, so it passes the
`additionalProperties` check).

2. Chat path: thread the `toolCatalog` (or `body.tools`) down
to `performToolCall`. Build a `Map<string, JSONSchema>` from the catalog at the start of the turn. Pass it to
`performToolCall` (or store it on `ToolContext`). The dispatcher looks up the schema by name, runs `validateToolArgs`,
then strips `activity` and calls `execute()`. An alternative is adding a `schema` field to `ToolDef` so each tool
registers its schema alongside `execute`. That avoids threading the catalog but duplicates the schema in the registry.
The catalog-threading approach is cleaner (single source of truth).

3. Agent path: `executeToolboxCall` already has the `AgentTool`
with its `wire` schema. Look up the tool by name, extract `wire.function.parameters`, run `validateToolArgs`, then strip
`activity` and call `execute()`.

4. Delete `rejectUnknownArgs` calls from the 18 tools that
currently call it. The central validator now handles unknown args. Keep `ArgErrors` for tools that still do semantic
validation (confidence range, "at least one of" rules).

5. Do NOT change `ask_user`. It clamps instead of rejecting by
design. The central validator would reject its over-length values. The fix: either exclude `ask_user` from central
validation, or make the central validator's bounds checks opt-out per tool. The simplest path: run the central
validator's `additionalProperties` and `required` checks on all tools, but skip `maxLength` / `minimum` / `maximum`
bounds checks for tools that have their own clamping. An `opts.skipBounds` flag on the tool def, or a Set of exempt tool
names.

**Gotchas.**

- The `activity` param is required in the schema but stripped
before `execute()`. The validator must see `activity` as valid (it is in `properties`) and not flag it as unknown. This
works naturally if the validator uses the wire schema (which includes `activity`) rather than the browser's
pre-injection schema.
- MCP tools have no server-side schema. `dispatchMcpTool`
passes args through to the MCP server, which validates its own schema. The central validator should skip MCP-routed
tools (`isMcpToolName` check, same as the existing `ToolNotImplementedError` path).
- The `tool_catalog.ts` `ToolCatalog` interface uses
`unknown[]` for the def arrays. The validator needs to extract `function.parameters` from the opaque def. A
`wireSchemaForName(catalog, name)` helper in `tool_catalog.ts` would bridge this.
- Agent wire schemas are defined per-agent file, not in the
browser's `*.schema.ts`. Some agent schemas are copies with different descriptions or slightly different params. The
validator uses whichever schema the dispatch point has: the catalog for chat, the `AgentTool.wire` for agents.

**Test.** `mise run check` + `mise run functions-check` + `mise run functions-test`. Playwright: send a chat message
that triggers a tool call (e.g. "save a memory about X"). Verify the tool call succeeds. Send a message that triggers a
tool call with a bad argument (e.g. ask the model to save a memory with confidence "high" instead of a number). Verify
the error message names the bad argument. Verify a hallucinated parameter name gets rejected with the "unrecognized
parameter" message.

**Files.** `supabase/functions/venice/tools/_validate.ts` (or new `_schema_validate.ts`),
`supabase/functions/venice/performToolCall.ts`, `supabase/functions/venice/tool_catalog.ts`,
`supabase/functions/venice/agents/_run.ts`, the 18 tool files that call `rejectUnknownArgs`, `supabase/functions/tests/`
(new or updated validation tests).

## Ordering rationale

Fixes 1 and 5 are paired (the browser retry schedule is dead code; deleting it resolves the divergence). Do them
together.

Fixes 6, 7, 8, 9, 13 are small mechanical changes with low risk. Do them early to build momentum and reduce the noise in
the codebase before the larger structural fixes.

Fixes 2, 3, 10, 11 are the structural splits. Each is a medium-to-large diff. Do them after the mechanical fixes so the
codebase is cleaner when you start moving code around.

Fix 4 (agent model IDs) is small but touches many files. Do it after the structural fixes so the file list is stable.

Fix 12 is the lowest priority. Do it last, or defer it entirely if the file is working well in practice.

Fix 14 (central tool validation) is a high-value structural fix but touches many tool files. It is independent of the
other fixes (no shared files with fixes 1-13 except `_validate.ts`). Do it after the mechanical fixes (6, 7, 8, 9, 13)
but before or alongside the structural splits (2, 3, 10, 11). It does not depend on Fix 2 (venice.ts split) or Fix 10
(getStreamingResponse.ts split).

Suggested sequence: 5+1, 6, 7, 8, 9, 13, 14, 3, 10, 11, 2, 4, 12.

## Completion criteria

Each fix is complete when:

1. `mise run check` passes (all gates: test, typecheck, svelte-check, lint, build, knip).
2. `mise run functions-check` passes (for fixes touching edge function code).
3. Playwright smoke test passes (for fixes touching the streaming path, UI, or user-visible behavior).
4. The fix's checkbox above is marked `[x]`.
5. Any dev docs that reference the old structure are updated in the same change.

## Final cleanup (after all fixes are complete)

When every fix is marked `[x]`:

1. Audit all dev docs (`docs/dev/*.md`) for stale references to
old file paths, deleted modules, or pre-refactor structure. Grep for any path that was moved or deleted during the
cleanup.
2. Audit `supabase/functions/README.md` for accuracy against the
final file layout.
3. Review QA use-cases (`docs/qa/use-cases/`) for any that
reference removed code or changed behavior. Update or add use-cases for behavioral changes (e.g. the guard-exhausted
error message fix from Fix 5).
4. Delete all `docs/dev/in-progress/audit-fix-*.md` scratch docs.
5. Delete this plan doc
(`docs/dev/in-progress/architecture-audit-fixes.md`).
6. Graduate any durable lessons from
`docs/dev/in-progress/refactoring-lessons.md` into permanent dev docs or thatch memory, then delete that doc too.
7. Run `mise run check` (including markdownlint, which covers
the doc tree).
