# Reorganize the workshop: collapse the tool-dispatch split

## SYNOPSIS

**Collapse the tool-dispatch split.** All tools currently live in two
places - the venice edge function's `performToolCall` registry, and the
browser's `executeToolCall` / `executeToolboxCall`. The streaming-root
migration moved main-chat dispatch server-side; what's left is the
**agent fleet** (reflection, rem, deep-sleep, wiki, wiki-librarian)
still driving its tool loops in Web Workers. End state: **one
dispatcher, one registry**, both living in the edge function. Browser
becomes purely "express user intent, render system state."

## PURPOSE

Right now the **same tool name** (e.g. `memory_search`) has **two live
implementations** - one in `src/lib/tools/memory_search.ts` for the
agents, one in `supabase/functions/venice/tools/memory_search.ts` for
main chat. They're independently maintained and the schemas drift on
their own. The browser `execute()` paths are also a mix of "alive" and
"dead-because-chat-loop-moved" - the live-or-dead split is invisible
without grepping. This is the kind of state-shape you can only hold in
your head while it's fresh, and which the next session will get wrong.

**Two dispatchers for one contract is the anti-attractor.** Until both
halves collapse into the function side, the cleanup work after every
edge-function feature has a parallel-impl tax: write the tool, write
its browser twin, hope they stay in sync. The remaining browser-side
agent fleets are what keep that tax alive.

## END STATE

**One registry** at `supabase/functions/venice/tools/` + `agents/`,
**one dispatcher** at `performToolCall` + `_run.ts`'s
`runHeadlessAgent`. Browser-side `src/lib/tools/*.ts` is **schema-only**
(`*.schema.ts` files) - just enough to populate the wire `tools` array
the request body carries. `src/lib/agents/` is **dispatchers, not
implementations** - they POST to function endpoints and observe
progress over Realtime. `runHeadlessToolLoop`, `executeToolCall`,
`executeToolboxCall`, and `dispatch.ts` are deleted.

## THE PLAN

Three phases. **Each phase is independently shippable** - if a phase
2 migration stalls, phase 1 still leaves the tree cleaner than it
found it.

### PHASE 1 - drop the already-dead browser dispatch leaf [DONE]

**Landed.** `serverSideTool(schema)` helper added at
`src/lib/tools/server_side.ts`; all ~33 dead chat-tool impls deleted
(schemas kept), their `index.ts` entries repointed to
`serverSideTool`; the 3 recall agents + 3 recall toolboxes dropped;
`executeToolCall` + its tests removed. Two landmines the triage doc
had left open got resolved on the way: `sanitizeTitle` (a live
non-tool export of `update_title.ts`) relocated into
`src/lib/title-gen.ts`, and the `ask_user` content helpers/types
relocated into `src/lib/ask-user.ts` (the tool's browser `execute()`
was dead but `Chat.svelte` / `chat-loop.ts` / `AskUserCard` still use
the parse/build helpers). Deleting the dead tools transitively
orphaned 7 helper exports (knip-flagged) - all deleted: the `docs.ts`
dev-docs corpus loaders, `VENICE_IMAGE_MODEL`, `sha256HexFromBase64`,
`WIKI_LIST_EXCERPT_CHARS`, and `notifyCookbookChanged`. **One gap
surfaced** by that last one: the cookbook-change event bus
(`cookbook-events.ts`) lost its only publisher when the `recipe_*`
tools went server-side - `onCookbookChange` subscribers (Cookbook
modal, Recipes tab) remain but nothing browser-side fires the event
now. Re-driving a cookbook refresh after a chat-driven recipe write
wants a server-aware trigger (recipes-table Realtime), tracked as
separate work. Gate + knip green.

**Scope:** the ~33 browser tool impl files whose `execute()` has had
no caller since the streaming-root migration. The triage doc at
[`./browser-tool-dead-code.md`](./browser-tool-dead-code.md) **already
itemizes** this - file lists, naming traps, special flowers, the
`serverSideTool(schema)` helper pattern.

**Do not duplicate that work here.** Phase 1 is "execute the existing
triage doc." The mechanics:

1. **Add the `serverSideTool(schema)` helper.** A `ToolDef` whose
   `execute()` throws with a "moved server-side" message. One helper
   replaces ~25 hand-written throwing stubs.
2. **Delete each dead impl file** in the lists under "DEAD chat-only
   tools" + "DEAD browser agent code (recall family)" from the triage
   doc. Keep its `.schema.ts`. Repoint the chat toolbox in
   `src/lib/tools/index.ts` to `serverSideTool(xSchema)`.
3. **Per-file checklist** before delete: schema companion exists,
   no non-test imports of helpers from the impl, tool is in NO live
   agent toolbox. (Full checklist in the triage doc.)
4. **Drop the recall agent directories** (`agents/recall`,
   `conversation_recall`, `wiki_recall`) and the matching read-only
   toolboxes (`recall_toolbox.ts`, `conversation_recall_toolbox.ts`,
   `wiki_recall_toolbox.ts`). These are only reachable from the dead
   recall tools above.
5. **Verify** `executeToolCall` itself has no remaining production
   caller (tests excluded). Tests in `tests/tools.test.ts` that
   exercise it die alongside.

**Risk:** low. No behavior change for any live path; the deleted
files were never reached. Build and knip catch dangling imports
loudly. Phase 1 leaves the live browser-agent dispatchers intact, so
nothing user-observable changes.

**Done when:** browser-side `src/lib/tools/*` carries only the 13
live-via-agent impl files + their schemas + the shared infra
(`dispatch.ts`, `run.ts`, `types.ts`, `wire.ts`, `lazy.ts`, the 4
agent-side toolbox aggregators).

### PHASE 2 - migrate agent fleets server-side, one at a time

**Five fleets to move.** Each one is a self-contained PR:
**reflection** (simplest), **wiki** (autonomous), **wiki-librarian**,
**rem**, **deep-sleep**. After each one lands, the browser impls of
its tools may newly fall dead - drop them alongside the migration PR
(not a separate cleanup).

**The function side already has the runner.** `supabase/functions/
venice/agents/_run.ts` exports `runHeadlessAgent` - a mirror of
`src/lib/tools/run.ts`'s `runHeadlessToolLoop`, with the same depth
cap and abort semantics. Tools register against `performToolCall`'s
shared registry; an agent assembles its toolbox by referencing
registered tools by name. **No new framework work** for the
function-side host - just per-agent ports.

**Per-fleet template** (the embeddings backfill / streaming-root
pattern, applied to each agent):

- **Function endpoint** at `supabase/functions/venice/agents/<name>.ts`
  exporting a route the chat orchestrator OR an HTTP caller can drive.
  The agent's prompt assembly + tool loop + result write all live here.
- **Trigger surface** depends on the agent's drive shape (table below).
- **Auth + RLS.** Service-role admin client only, gated by
  `isServiceRole(bearer)` for cron, or by the gateway-validated user
  JWT for user-triggered calls. SECURITY DEFINER for any cross-row
  claim/save RPC. See [edge-function-auth.md](../edge-function-auth.md)
  for the b-strict model.
- **Progress streaming** for user-visible runs: publish step events to
  a `nak-agent:<runId>` Realtime channel; the browser subscribes
  pre-POST (avoid the subscribe-after-POST race that bit streaming
  chat - see [chat.md](../chat.md) "Pre-subscribe before /stream").
- **Browser cutover.** Replace the Web Worker's `runHeadlessToolLoop`
  call with a `functions.invoke('venice/agents/<name>', ...)` plus a
  Realtime subscription for progress. The supervisor (or manual
  runner) keeps owning the **scheduling decision** (when to dispatch);
  only the **execution** moves.
- **Delete on the way out.** The agent's browser-side `agent.ts`,
  `loop.ts`, and any tool impl files that became dead because of the
  cutover. Don't leave the parallel impl as "in case we want to roll
  back" - that's exactly the two-implementation state we're escaping.

#### Order + drive-shape

Smallest first. Each agent's trigger shape decides the surface:

| Agent | Tools | Drive | Trigger surface |
|---|---|---|---|
| **reflection** | memory CRUD (8) | per-thread, post-round | inline in `getStreamingResponse` tail (via `waitUntil`) |
| **wiki** (autonomous) | wiki CRUD + memory_search | per-thread, becomes-substantive | pg_cron scan + claim/save RPC |
| **wiki-librarian** | wiki edits + conversation/memory_search | scheduled batch + user-triggered | pg_cron for batch; HTTP POST for "run now" button |
| **rem** | memory librarian set | scheduled batch | pg_cron + claim/save RPC |
| **deep-sleep** | memory librarian set | scheduled batch + user-triggered | pg_cron + HTTP POST |

**Why reflection first.** Single thread, no scheduling, no claim/save
RPCs to author. It's just "after this turn's chat completion lands,
also run this prompt with this toolbox in a headless loop." That
isolates the per-agent port work without the cron / claim machinery
complexity. Land it, learn the shape, repeat.

**Why wiki-related agents before memory librarians.** wiki/
wiki-librarian touch a much smaller live data shape than rem/
deep-sleep; mis-migrations there are easier to roll back without user
data implications. memory librarians are heavier (per-user
consolidation across the full memory set) and want the most
end-to-end confidence before touching.

### PHASE 3 - demolition

**After all 5 agents are server-side**, the entire browser dispatcher
becomes orphaned. Drop in one cleanup PR:

- `src/lib/tools/run.ts` (`runHeadlessToolLoop`).
- `src/lib/tools/dispatch.ts` (`executeToolboxCall`, the wire
  projector stays - it serves `buildToolList`).
- `src/lib/tools/index.ts`'s `executeToolCall` export and the agent-
  side toolbox re-exports.
- The 4 agent-side toolbox aggregators (`memory_toolbox.ts`,
  `memory_librarian_toolbox.ts`, `wiki_toolbox.ts`,
  `wiki_librarian_toolbox.ts`).
- The remaining 13 browser tool impl files (memory CRUD, wiki CRUD,
  conversation_search). Schemas stay - `buildToolList` still uses
  them.
- `src/lib/tools/lazy.ts` if it has no remaining caller.
- The agent class shells in `src/lib/agents/{reflection,wiki,wiki-
  librarian,rem,deep-sleep}/agent.ts` if their last reader was the
  Web Worker (the worker becomes a thin dispatcher).

**Done when:** `src/lib/tools/` contains only `.schema.ts` files +
`types.ts` + `wire.ts` + `index.ts` (now a schema-only catalog). One
dispatcher, one registry, end of split.

## toggle_toolbox: not actually an exception

Worth surfacing because it looked like the candidate for "leave this
one browser-side" - but it **isn't**. The edge function already has a
working `toggle_toolbox` port at `supabase/functions/venice/tools/
toggle_tools.ts`; it's the live copy. The browser impl is already
dead (caught by Phase 1).

**Why no action-at-a-distance.** The toggle is a turn-boundary
capability switch, not a mid-round one. `getStreamingResponse` reuses
the request's initial `tools` array across all rounds of one turn - so
a toggle fired in round 2 takes effect on the **next user turn**, when
the browser rebuilds `buildToolList` from the now-mutated
`thread.toolboxes_enabled` column. The browser-owned composer popover
reads/writes the same column directly. Both writers (popover + the
server-side toggle tool) write through the same store. **The
Postgres column is the rendezvous point**; neither side has to know
about the other.

**The only thing the browser keeps** for toggling is composing the
wire `tools` array per request. That's intentional - the catalog
metadata (`GATED_TOOLBOX_META`) is what the popover renders, and
keeping the build local saves a function round-trip per turn. Moving
`buildToolList` server-side would be code-shuffle, not architecture
win.

## What stays browser-side (not part of the split)

These look like agents or tool-adjacent code but are NOT part of the
dispatcher consolidation. **Leave them alone** until/unless their own
case justifies migration:

- **`context-recall/gather.ts`** - deterministic SQL fan-out, not a
  tool dispatcher. Called by `chat-loop.ts` to compose the synthetic
  context `<think>` block before `streamChat`. Can optionally fold
  into `/stream` later but it's not in the dispatcher-split problem.
- **No-tool agents** - `auto_title`, `summary`, `topics`,
  `memory_topics`, `recipe_topics`, `bias`, `intuition`, `samskara`.
  These are plain Venice completions, not tool loops. They're
  candidates for the same waitUntil pattern eventually, but they don't
  block the dispatcher consolidation.
- **The composer popover + thread state UI** - reads
  `thread.toolboxes_enabled` directly, writes via
  `setThreadToolboxesEnabled`. No dispatcher coupling.
- **`buildToolList`** - schema-only catalog composer. Stays in the
  browser; runs per chat turn against `thread.toolboxes_enabled`.
- **`ask_user` parse/build helpers** - `parseAskUserContent`,
  `buildAskUserAnswerContent`, the `ASK_USER_*_FLAG` constants.
  Consumed by `Chat.svelte` for the UI suspend/resume flow. Move to a
  non-tool location during Phase 1 if `ask_user.ts` is otherwise
  deletable.

## Verification gates

Per phase. **All of these are mandatory before the PR ships**, not
nice-to-haves.

**Phase 1:**

- `mise run check` - Rollup catches dangling dynamic imports loudly
  if a `lazyTool(() => import('./x'))` points at a deleted file.
- `mise run knip` - flags newly-unused schemas or helpers.
- **Browser smoke test:** open a chat, fire a tool from each toolbox
  category, confirm the function still dispatches. The tools array
  build path is what's at risk, not the impls (those were already
  dead).

**Phase 2 (per fleet):**

- Local `mise run dev-start` stack: trigger the agent end-to-end,
  confirm the function-side runHeadlessAgent loop produces the same
  result shape the browser worker produced. **Compare against the
  browser run on the same input** before cutting over.
- For scheduled fleets: confirm the pg_cron entry fires locally with
  a synthetic 1-minute schedule, the claim RPC is service-role-only,
  and the function POST returns 200 (the embeddings-backfill 403 trap
  from [cron-to-edge-function auth](../edge-function-auth.md) is the
  pattern to avoid).
- For user-triggered fleets: subscribe-then-POST in the browser
  (the [streaming chat reconnect race](../chat.md) pattern); verify
  no events get dropped on a slow first round.
- **Production verification mandatory** before declaring the fleet
  done. Local-only confidence is not enough - the
  [embeddings milestone retro](../embeddings.md) called out three
  bugs invisible from a green deploy.

**Phase 3:**

- `mise run check` and `mise run knip` are the floor.
- **Manual: spawn each migrated agent live**, confirm it still
  resolves a result. A demolition PR that breaks one quietly is
  exactly the failure mode this whole exercise exists to prevent.

## Open questions

Surfaced now so they don't bite mid-migration.

- **Should the agent's progress channel be per-run or per-thread?**
  Streaming chat uses per-thread (one stream per response holder).
  An agent run is per-user-per-agent. A `nak-agent:<runId>` channel
  matches the run lifecycle cleanly; per-thread would couple agent
  progress to thread state for no obvious win. Recommend per-run.
- **Where does the supervisor's scheduling state live after cutover?**
  Reflection's trigger is currently "supervisor decides after a thread
  turn ends." If the function fires reflection inline via waitUntil,
  the supervisor's role for reflection ends - it just decides
  scheduling for the no-tool agents (auto_title, summary, topics). The
  supervisor shrinks; doesn't disappear.
- **Do we need a generic `/venice/agents/run` dispatcher or one
  endpoint per agent?** Per-endpoint is more explicit and easier to
  reason about; generic is fewer files. Recommend per-endpoint until
  we have 5+ agents and the boilerplate ratio justifies the
  abstraction. Premature consolidation is the same anti-pattern we're
  fixing here in a different layer.
- **Reflection inline vs separate endpoint?** Inline (after the
  terminal chat round, inside getStreamingResponse's
  waitUntil-protected tail) is simpler - one function, one transaction
  shape. Separate endpoint costs an HTTP hop and gains testability
  isolation. Recommend inline first; refactor out if it complicates
  the orchestrator's error handling.

## Where to go next

- [`./browser-tool-dead-code.md`](./browser-tool-dead-code.md) - the
  Phase 1 triage doc; the file-by-file lists and the
  `serverSideTool(schema)` helper recipe.
- [`../architecture.md` "Production-path ownership"](../architecture.md#production-path-ownership-browser-vs-edge-function) -
  the row-ownership framing this plan builds on.
- [`../edge-function-auth.md`](../edge-function-auth.md) - the
  b-strict admin-client + SECURITY DEFINER pattern every Phase 2
  migration uses.
- [`../tools.md`](../tools.md) - the current tools subsystem doc.
  Will need updates as each phase lands (start with Phase 1: the
  dispatcher section needs to drop browser execution from its claims).
