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

The original three phases of the split (P1 dead-leaf drop, P2 fleet
migration, P3 demolition), plus **Phase 4 - edge-to-drawer log
streaming** (an observability gap the split opened: server-side agents
can no longer reach the Logs drawer), plus a **Phase 5 ledger** of tech
debt the migration surfaces along the way. **Each phase is
independently shippable** - if a phase 2 migration stalls, phase 1
still leaves the tree cleaner than it found it. Phase 4 is likewise
independent and arguably wants to land mid-Phase-2 (see its Timing
note). The Phase 5 items aren't sequenced at all - they're
opportunistic cleanups logged as the deletions reveal them.

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
wants a server-aware trigger (recipes-table Realtime) - logged in the
Phase 5 ledger below. Gate + knip green.

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
**reflection** (simplest) [DONE - see concrete design below],
**wiki** (autonomous) [DONE - see concrete design below],
**wiki-librarian** [DONE - see concrete design below],
**rem**, **deep-sleep**.
After each one lands, the browser impls of its tools may newly fall
dead - drop them alongside the migration PR (not a separate cleanup).

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

**Why reflection first.** No cron - it piggybacks on the streaming
tail instead of a scheduled poll, so it isolates the per-agent port
work without standing up pg_cron. Land it, learn the shape, repeat.

(Correction from research: reflection is NOT "no claim/save RPCs" as
an earlier draft of this line claimed. It reuses the existing
day-gated `claim_next_thread_for_reflection` /
`mark_thread_reflected_if_claimed` queue - see the concrete design
below. It's still the simplest fleet because the cron half is
replaced by a `waitUntil` off the chat turn, but it does touch the
claim RPCs.)

#### Reflection: concrete design (from the migration research) [LANDED, pending prod verify]

**Status.** Reflection is the first fleet to land. Shipped: the
server-side agent (`supabase/functions/venice/agents/reflection.ts`,
`reflectOneThread`), the `getStreamingResponse` terminal-tail hook
(`edgeWaitUntil`, gated on `terminalKind === 'completed'`), the two
prereqs (server-side `memory_invalidate` + the `p_user_id` claim/mark
RPC overloads), and the full browser cutover: the supervisor's
`reflection` unit is gone (5 units remain), `src/lib/agents/reflection/`
and `src/lib/tools/memory_toolbox.ts` are deleted, and the supervisor's
now-vestigial timezone plumbing (holder cell, `setTimezone`, the
`'timezone'` postMessage, the `SupervisorStartOpts.timezone` field) is
removed - reflection was the only supervised unit with a day-gate, and
the server side reads the timezone from `profiles.settings` directly.
The toolbox-composition invariant (soft-decay set, no `memory_delete`,
no `ask_user`) moved to `supabase/functions/tests/reflection.test.ts`.
Local gate + Deno tests + knip green. **Production verification still
owed** per the Phase 2 gate below (reflection is invisible UI-wise -
verify via memory writes after a terminal round on an OLDER eligible
thread, or the edge function logs).

**Trigger reframe - it drains *older* threads, not "this" one.** The
claim RPC only claims threads whose newest message lands on a
**prior calendar day** in the user's timezone (so a memory derived
from a half-finished thought can't ride straight back into the same
conversation via `memory_recall`, which has no per-conversation
source attribution) and that carry **>= 2 user messages** (a one-shot
Q&A isn't worth reflecting). So firing reflection from the terminal
round's `waitUntil` tail does NOT reflect the thread that just
completed - it **opportunistically drains one reflection-eligible
thread from the existing queue** on each turn completion. Faithful to
today's behavior (same queue, same gate); only the *driver* changes
from a supervisor poll to a chat-activity piggyback.

**Auth - the claim/mark RPCs need SECURITY DEFINER variants.** The
current `claim_next_thread_for_reflection` /
`mark_thread_reflected_if_claimed` are `security invoker`, gated on
`auth.uid()`. The edge function holds a service-role admin client
where `auth.uid()` is null (the embeddings-403 trap). Add
`security definer` overloads that take an explicit `p_user_id`
(matching the plan's "SECURITY DEFINER for any cross-row claim/save
RPC" rule) and filter on it instead of `auth.uid()`. The browser
keeps calling the invoker versions until the cutover; the overloads
are additive (idempotent `schema.sql` edits).

**Prerequisite - port `memory_invalidate` server-side.** The
reflection toolbox is the agent-only set (soft-decay, NOT hard
delete): `memory_search/create/update/invalidate/reaffirm/doubt/
relate/unrelate`. The edge function registers all of those EXCEPT
`memory_invalidate` (it has `memory_delete` instead, which agents
must never get). Port `tools/memory_invalidate.ts` (wraps the
`decayMemoryConfidence` RPC; template: `tools/memory_doubt.ts`) and
register it in `tools/index.ts`.

**Shape:**

1. Port `memory_invalidate` + register it (additive, no behavior
   change). `[prereq]`
2. Add `SECURITY DEFINER` `p_user_id` overloads of the two reflection
   RPCs to `schema.sql` (additive). `[prereq]`
3. Write `agents/reflection.ts`: gather the thread slice up to
   `terminal_msg_id`, build the reflection prompt (port from
   `src/lib/agents/reflection/prompt.ts`), assemble the 8-tool memory
   toolbox, run `runHeadlessAgent`. Template: `agents/recall.ts`.
4. Hook it into `getStreamingResponse`'s terminal tail via
   `edgeWaitUntil`: claim (definer, `p_user_id`) -> run -> mark. One
   cycle per turn completion.
5. Browser cutover: drop the supervisor's `reflection` unit (the
   other 5 units stay), delete `src/lib/agents/reflection/`, and
   delete `memoryToolbox` (`memory_toolbox.ts`) - reflection is its
   only consumer. `runHeadlessToolLoop` STAYS (wiki / wiki-librarian
   / rem / deep-sleep still use it). -> Phase 3 demolition list.

#### Wiki (autonomous): concrete design [LANDED, pending prod verify]

**Status.** Shipped across two commits (server side, then browser
cutover): `agents/wiki.ts` (`runWikiSweepTick` + `retryWikiThread`),
the `wiki_create`/`wiki_update`/`wiki_delete` tool ports with shared
`_wiki_helpers.ts`, the `/wiki-sweep` (service role) + `/wiki-retry`
(user JWT) routes, the global SECURITY DEFINER claim sweep +
`p_user_id` overloads + hourly `nak-wiki-sweep` cron in schema.sql,
the dev-shim wiki tick, the full browser cutover (worker fleet
deleted; `agent.ts` keeps only the manual `updateOne` flow; Settings
toggle is a plain settings write the claim predicate reads), and the
`wiki_articles` postgres_changes subscription that re-drives
`emitWikiChange` for server-side writes. The shared agent plumbing
(`asAgentTool`, `loadThreadSliceUpTo`, the memory_search wire schema)
moved to `agents/_agent_tools.ts`, consumed by reflection and wiki
both. Toolbox/sentinel/prompt invariants live in
`supabase/functions/tests/wiki.test.ts`. Gate + Deno + knip green.
**Production verification still owed** per the Phase 2 gate (watch a
hosted cron tick claim and process an eligible thread; confirm the
drawer shows the `wiki` source lines and the Skipped panel's Retry
round-trips). Known unit-coverage gap: the in-run content-filter
fallback ordering and the retry pointer semantics have no injection
seam server-side (`runHeadlessAgent` calls `toolComplete` directly).
Restoring that seam is a MANDATORY Phase 3 item (see "restore the
agent-loop test seam" there); live verification covers these
behaviors only until then.

**Trigger: pg_cron, per the original table.** The reflection-style
chat-turn piggyback was considered (wiki's queue is the same
day-gated drain-older-threads shape) and rejected in favor of the
planned cron drive - wiki should drain even when the user isn't
chatting, and the cron surface is needed for the remaining three
fleets regardless, so it gets built here against the simplest
consumer. The infrastructure is a clone of the embed-backfill
pattern, NOT new framework work: a `nak_trigger_wiki_sweep()`
SECURITY DEFINER function reads the `project_url` /
`service_role_key` Vault secrets and `net.http_post`s to
`/functions/v1/venice/wiki-sweep`; a guarded `cron.schedule` block
runs it hourly (wiki eligibility only changes at day boundaries
per user, so the embed backfill's 5-minute cadence would be
wasted LLM-budget polling). Each tick processes a bounded number
of threads; the schedule resumes the drain.

**Claim redesign - the cron has no user JWT.** The current
`claim_next_thread_for_wiki(p_holder_id, p_ttl, p_timezone)` is
`security invoker` gated on `auth.uid()`, and the *caller* supplies
the timezone. A cron-driven sweep has neither a user identity nor a
single timezone. The redesign follows the embeddings-backfill
precedent (`claim_next_pending_wiki_article`: global SECURITY
DEFINER sweep, EXECUTE locked to `service_role`): the claim joins
`profiles` per candidate thread to read
`settings->>'displayTimezone'` (UTC fallback) for the day-gate AND
to gate on `coalesce((settings->>'wikiAutomaticEnabled')::boolean,
true)` - the Settings toggle keeps working, it just becomes a
DB-read on the server instead of a worker start/stop on the client.
The claim returns `user_id` alongside the thread columns so the
agent can scope its run. The mark / failure / retry RPCs
(`mark_thread_wiki_processed_if_claimed`,
`record_wiki_failure_or_skip`, `compute_wiki_terminal_msg_id`,
`manual_advance_wiki_pointer`) get the same `p_user_id` b-strict
overload treatment reflection's RPCs got; the old invoker-only
signatures die with the browser worker.

**The Skipped-panel Retry button forces a second endpoint.** The
browser `WikiAgent` carries three flows: the autonomous loop (this
migration), `retrySkippedThread()` (the Wiki Skipped panel's Retry
button - runs the SAME tool loop, on the main thread), and
`updateOne()` (the per-article "ask agent to update" flow - a
single `response_format=json_object` completion, NO tool loop). The
retry flow must move in this PR too, or the browser wiki tool impls
can't die and the two-dispatcher state survives. It becomes a
user-JWT `POST /wiki-retry` route (the "HTTP POST for run now"
shape the plan table assigns wiki-librarian) returning the same
`{toolCalls, reasoning} | no-op | error` union the panel already
renders. `updateOne()` stays browser-side - it's a no-tool
completion, same category as auto_title/summary.

**Agent port shape** (`agents/wiki.ts`, template
`agents/reflection.ts`): autonomous prompt + user-profile block
ported verbatim (the profile block's HARD anti-name-fabrication
wording is load-bearing - see the prompt.ts preamble history);
profile fields read from `profiles.settings.userName/userLocation`;
5-tool toolbox (wiki CRUD + read-only `memory_search`) via the
`asAgentTool` adapter; model hardcoded `deepseek-v4-flash`
(static `AGENT_MODELS.wiki` slot) with the single
content-filter-fallback retry on `arcee-trinity-large-thinking`
(the Venice classifier sentinel survives the port - VeniceError
messages embed the response body); `reasoningEffort: 'medium'`;
per-thread failure counter (cap 3) through
`record_wiki_failure_or_skip`. Progress logs through
`createEdgeLogger(userId, 'wiki')` + flush, so the drawer keeps
its picked-up/finished/skipped lines.

**Prerequisite tool ports.** The edge registry has `wiki_search` /
`wiki_get` / `wiki_list` / `memory_search` but not the write
tools. Port `wiki_create` / `wiki_update` / `wiki_delete`
faithfully: char caps, best-effort changelog rows, source
attribution (auto-attach `ctx.threadId`; validate
`source_thread_ids` against the threads table), and create's
unique-violation rephrasing ("already exists -> wiki_search +
wiki_update").

**Browser cutover + what survives.** Delete
`agents/wiki/{worker,manager,loop,types}.ts`, `wiki_toolbox.ts`,
and the autonomous half of `prompt.ts`; `agent.ts` shrinks to the
manual `updateOne` flow. Only the `wiki_create` browser impl falls
dead (repoint to `serverSideTool`) - `wiki_update` / `wiki_delete`
/ `wiki_search` impls stay alive because the still-browser
**wiki-librarian** toolbox uses them; they die with that fleet.
`state.svelte.ts` drops the wiki manager wiring (start/stop/
setProfile/setTimezone); the Settings toggle becomes a plain
settings write.

**UI refresh - the worker's `processed` event dies.** The Wiki
drawer/panel refreshed via `emitWikiChange()`, fired from the
browser tool impls and the manager's progress handler. Server-side
writes can't reach a window event bus - the same blind spot as the
Phase 5 cookbook-events item, fixed here with the shape that item
prescribes: a user-scoped Realtime `postgres_changes` subscription
on `wiki_articles` that fires `emitWikiChange()`. (The cookbook
item stays open - recipes are a different table - but this PR
establishes the pattern it wants.)

**Local verification.** The dev stack has no pg_cron/pg_net;
`scripts/dev-backfill-cron.mjs` grows a wiki-sweep tick alongside
the backfill one (same loopback-only guard, same service-role
bearer).

#### Wiki-librarian: concrete design [LANDED, pending prod verify]

**Status.** Shipped across two commits (server, then browser
cutover): the runner's injectable completion seam + onProgress hook
(the Phase 3 gate item - landed here as planned), the global
`claim_next_user_for_wiki_librarian` with the per-user in-flight
guard pair and hourly `nak-wiki-librarian-sweep` cron, the converged
`agents/wiki_librarian.ts` (full two-variant prompt, registered-tool
toolbox - killing the drifted inline caps - and all three entry
points sharing the guard), the `/wiki-librarian-sweep` +
`/wiki-librarian-run` routes with per-run step events on the
`agent-runs:<userId>` Broadcast channel (per-USER topic with the
runId in the payload, NOT the per-run topic the open question below
recommended - the per-user shape gets channel auth for free from one
literal-equality policy), the dev-shim tick, and the full browser
cutover (librarian fleet deleted; Wiki strip on subscribe-then-POST;
the last setProfile/worker-push plumbing gone from state.svelte.ts).
Behavioral tests restored through the seam
(`supabase/functions/tests/{agent_run,wiki_behavior,wiki_librarian}.test.ts`).
Gate + Deno (96) + knip green. **Production verification still owed**
per the Phase 2 gate.

**This fleet is a CONVERGENCE, not just a port.** The librarian
already runs server-side for one of its three trigger paths: the
chat-dispatched `wiki_librarian` tool
(`supabase/functions/venice/agents/wiki_librarian.ts`) carries its
own copy of the custom-instructions prompt AND its own inlined
`wiki_update` / `wiki_delete` implementations - which have **drifted**
(title cap 300 vs the real 200, content cap 50k vs the real 16k;
`src/lib/wiki.ts` and the registered function-side ports both say
200/16000). That drift is the two-dispatcher disease in miniature,
inside one runtime. The migration collapses all three paths
(scheduled 12h sweep, sparkles-button manual run, chat-dispatched
tool) onto ONE server-side prompt builder and ONE toolbox built from
the registered tool ports.

**Trigger surfaces:**

- **Scheduled**: hourly pg_cron -> `nak_trigger_wiki_librarian_sweep()`
  -> `POST /wiki-librarian-sweep` (isServiceRole). The browser's
  per-user `claim_wiki_librarian_run` (invoker, auth.uid()) is
  replaced by a global SECURITY DEFINER
  `claim_next_user_for_wiki_librarian(p_min_interval_seconds)`:
  atomically stamps `profiles.wiki_librarian_last_run_at` for the
  most-overdue eligible user and returns their `user_id`; gated on
  `settings->>'wikiLibrarianEnabled' is distinct from 'false'` (the
  same string-compare-not-cast rule as the wiki sweep). Stamp-before-
  run is faithful to the browser claim: a crashed run waits out the
  interval rather than retrying hot. The
  `LIBRARIAN_MIN_ARTICLES` (3) skip runs post-claim, also faithful.
  One user per tick - librarian runs are the heaviest agent cycles,
  and the hourly schedule catches up a multi-user backlog fine at
  this scale.
- **Manual** (sparkles button): user-JWT `POST /wiki-librarian-run`
  with `{instructions: string|null}`. Does NOT touch the cadence
  stamp (faithful: manual and scheduled runs were independent). The
  Wiki strip's **live step list survives** via the plan's per-run
  channel recommendation: `runHeadlessAgent` gains an optional
  `onProgress` hook (server twin of the browser
  `HeadlessToolLoopEvent`: thinking rounds + tool calls with the
  model-emitted `activity` narration), the route publishes each event
  to a `nak-agent:<runId>` private Broadcast channel, and the browser
  subscribes BEFORE the POST (the pre-subscribe rule from chat.md).
- **Chat-dispatched**: the existing `wiki_librarian` ToolDef stays,
  rewired to the shared prompt builder + shared toolbox. Its drifted
  inline tools die.

**Toolbox.** wiki_search + conversation_search + memory_search +
wiki_update + wiki_delete (no wiki_create), built from the registered
ToolDefs via `asAgentTool`. One deliberate context split: the write
tools get a BLANKED `threadId` in their context so the delegating
chat thread is never auto-attached as an article source (the
librarian attributes via model-supplied `source_thread_ids` only -
current behavior on every path), while `conversation_search` keeps
the real threadId for its self-exclude.

**Busy coordination changes shape.** The browser's
`wikiLibrarianRunner` rune (workerBusy + manualBusy, per-tab) becomes
a DB-level in-flight guard shared by all three server paths: an
atomic claim with a TTL, taken at run start and released at run end,
so a manual run during a scheduled run (or a chat-dispatched run
during either) returns a clean "a librarian run is already in
flight" error instead of racing. The UI keeps a local manualBusy for
its own button spinner; the preemptive "gray the button while the
SCHEDULED run is in flight" affordance is dropped (the browser only
knew about it via worker postMessage; server-side the collision error
covers the same safety with a worse-case UX of one error message per
12 hours).

**The Phase 3 test seam lands here** (it gates the project; landing
it with this fleet stops the coverage bleed): `RunHeadlessAgentOptions`
gains an injectable completion override (default `toolComplete`), and
the behavioral tests return - librarian prompt-variant selection and
discipline invariants, plus the wiki agent's fallback ordering and
retry pointer semantics from the deleted browser suites.

**Browser cutover.** Delete `src/lib/agents/wiki-librarian/` (all
seven files incl. the worker fleet, `runner.svelte.ts`, and the
690-line prompt), `wiki_librarian_toolbox.ts`, and the browser
`wiki_search` / `wiki_update` / `wiki_delete` impls (the librarian
toolbox was their last live dispatcher; `conversation_search` and
`memory_search` STAY - the memory-librarian fleet still dispatches
them browser-side). `state.svelte.ts` drops the librarian manager
wiring and - with the last setProfile consumer gone - the
`setUserName` / `setUserLocation` worker-push plumbing entirely.
Wiki.svelte's strip swaps `runManually` for the new SupabaseService
method + progress subscription; Chat.svelte's
`wikiLibrarianRunner.busy` gray-out goes with the rune.

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
- The 1 surviving agent-side toolbox aggregator
  (`memory_librarian_toolbox.ts`). The other three
  (`memory_toolbox.ts`, `wiki_toolbox.ts`,
  `wiki_librarian_toolbox.ts`) already went in Phase 2 - each was
  exclusive to its fleet, so it died with that fleet's cutover
  rather than waiting for demolition.
- The remaining 10 browser tool impl files (the 9 memory tools +
  `conversation_search`), all owned by the memory-librarian fleet.
  The wiki impls already died with their fleets' cutovers. Schemas
  stay - `buildToolList` still uses them.
- `src/lib/tools/lazy.ts` if it has no remaining caller.
- The agent class shells in `src/lib/agents/{wiki-
  librarian,rem,deep-sleep}/agent.ts` if their last reader was the
  Web Worker (the worker becomes a thin dispatcher). Reflection's
  shell already went in Phase 2; the wiki shell survived its cutover
  deliberately - `WikiAgent` now carries only the manual `updateOne`
  flow (a no-tool completion, outside the dispatcher split).

**Also in this phase - NOT optional: restore the agent-loop test
seam.** [DONE - landed with the wiki-librarian fleet, as
recommended.] `RunHeadlessAgentOptions.complete` is the injectable
completion override (default `toolComplete`); the behavioral tests
the browser suites used to carry are back through it -
`supabase/functions/tests/wiki_behavior.test.ts` restores the wiki
agent's primary-then-fallback ordering and the retry flow's
pointer/skip-marker semantics, and `agent_run.test.ts` covers the
seam + progress hook themselves. The rem/deep-sleep ports must use
the seam from day one so their browser test inventories migrate
instead of dying.

**Done when:** `src/lib/tools/` contains only `.schema.ts` files +
`types.ts` + `wire.ts` + `index.ts` (now a schema-only catalog), and
the server-side agents' in-run behaviors are unit-tested through the
runner's injection seam. One dispatcher, one registry, end of split.

### PHASE 4 - edge-to-drawer log streaming [LANDED, pending prod verify]

**Status.** Shipped: `createEdgeLogger` (`supabase/functions/_shared/
edge-log.ts`) - browser-logger-shaped API that console-mirrors AND
POSTs each entry to the private `logs:<userId>` Realtime Broadcast
topic via the HTTP endpoint, with `flush()` for waitUntil tails; the
`realtime.messages` "log channel: owner subscribe" policy; the browser
end (`appendFromEdge` ingress + `SupabaseService.subscribeToUserLogs`,
wired in `Chat.svelte`); and reflection rewired as the first consumer
(it logs claim/run/mark/outcome through the edge logger and flushes
before returning, so `reflectOneThread` is now non-throwing). Gate +
Deno + knip + markdownlint green. **Verify locally:** with the dev
stack up, set the drawer to a low tier, complete a chat turn against a
seeded older eligible thread, and confirm `reflection` entries appear
in the drawer (this is the verification surface the earlier "watch the
drawer" plan wanted - it now exists). One thing to confirm on the live
stack: that the HTTP broadcast endpoint delivers to `private:true`
subscribers (the documented path; if not, swap `broadcastLogEntry` to
the websocket-join approach `getStreamingResponse` uses).

**The split blinded the Logs drawer to server-side work.** The in-app
Logs drawer (`src/lib/logger.svelte.ts` + the panel in `Chat.svelte`)
shows main-thread logs directly and relays Web Worker logs into the
same ring buffer via `appendFromWorker` (workers `postMessage`
`{type:'nak-log', entry}`; each manager routes it in). Once an agent
moves into the venice edge function, that pipe is severed - the edge
function's `console.log` lands only in Supabase's function logs, never
the drawer. Reflection is the first casualty; every remaining fleet
migration widens the blind spot. This phase restores the drawer as the
single observability surface for background work regardless of where it
runs.

**Mechanism: Realtime Broadcast, the same transport streaming chat
already uses.** The edge function publishes structured log entries to a
per-user Broadcast channel; the browser subscribes and feeds them into
the existing ring buffer. Broadcast is ephemeral pub/sub with no table
backing (contrast Supabase Queues / `pgmq`, which is table-backed and
pull-based - wrong tool). The streaming publisher (`broadcast.ts`,
`channel.send({type:'broadcast', ...})`) is the working reference.

**Shape:**

- **Per-user log channel** (e.g. `logs:<userId>`). Browser subscribes
  on sign-in (or on drawer-relevant lifecycle); edge functions publish
  to it.
- **Reuse the wire shape.** `SerializableLogEntry` already crosses the
  worker boundary intact (Errors flattened to name/message/stack).
  Send the same shape over Broadcast; add an `appendFromEdge` that is
  `appendFromWorker` with a different ingress. Edge logs then render in
  the drawer indistinguishably from worker logs.
- **Edge-side `createLogger`.** A Deno-side logger mirroring the
  browser API that publishes to the user's channel instead of (or
  alongside) `console.log`. Reflection's `[orchestrator <runId>]
  reflection ...` line is the natural first consumer + test case.

**Open questions (design forks, resolve at implementation):**

- **Channel auth.** A user must only receive their own logs. Either a
  Realtime *private channel* with an authorization policy on
  `realtime.messages`, or an unguessable channel name. Check how the
  `thread:<id>:stream` channels are secured today and mirror it.
- **Subscribe-gated publishing.** TRACE can be high-volume; the
  project-wide budget is ~500 msg/sec (see `broadcast.ts`). Don't
  broadcast logs nobody is watching - gate edge publishing on a live
  subscriber, and decide whether the level filter applies client-side
  (simpler, more bandwidth) or is pushed to the edge (less bandwidth,
  more coupling). Reuse the adaptive-tier backpressure from
  `broadcast.ts` if volume warrants.
- **Ephemerality.** Logs emitted while the drawer is disconnected are
  lost from the UI (still in Supabase function logs server-side).
  Acceptable for a live debug surface; name it so it isn't mistaken
  for a gap.

**Timing.** Independent of the dispatcher split - it can land any time.
But it pays for itself earliest if it lands NEXT, before the remaining
Phase 2 fleets migrate: each fleet that moves server-side before this
exists loses drawer observability (the same blind spot reflection just
hit), and reflection is a ready-made first consumer to validate it
against. Sequenced here per the "before the cleanup ledger" framing,
but bringing it forward is the stronger call.

### PHASE 5 - surfaced tech debt (running ledger)

**Not a sequenced phase - a ledger.** Collapsing the split keeps
kicking up collateral: code that was load-bearing only for a path the
migration severed, or a contract that quietly lost one of its ends.
Each phase's deletions reveal more (Phase 1's knip pass alone orphaned
7 helper exports). These items are **independent and opportunistic** -
none gate Phase 2/3, and most are a small PR each. Log them here as
they surface so the next session can pick one up without re-deriving
the context, and so "we deleted the caller but left the callee
half-alive" never reads as intentional.

**Open items:**

- **Re-inspect the no-tool completion agents after Phase 3.** The
  "What stays browser-side" list excludes the plain-completion agents
  (`auto_title`, `summary`, `topics`, `memory_topics`,
  `recipe_topics`, `bias`, `intuition`, `samskara`) from the
  dispatcher split on the grounds that they dispatch no tools. Once
  the split closes, revisit each: whether the server-side patterns
  the migration established (cron sweep / waitUntil tail / edge
  logger) now make a server port cheap enough to justify, and whether
  any browser-only assumptions in them have quietly become
  anti-patterns next to the migrated fleets. Sequencing constraint:
  samskara has an upstream change landing shortly - after it lands
  and the branch rebases, that whole area needs a fresh read before
  any plan touches it.
- **Pre-existing Deno type errors, surfaced by a Deno upgrade.**
  `deno check venice/index.ts` fails on three errors in files this
  migration never touched (found 2026-06-09 while checking the wiki
  port; a brew-upgraded Deno tightened the checks):
  - `venice/getStreamingCompletion.ts:299` and `:519` - the code
    compares/constructs a `VeniceError` with kind `'truncated'`, but
    `'truncated'` is not a member of the `VeniceErrorKind` union in
    `_shared/venice.ts`. Either the union is missing a legitimate
    kind or the truncation path can never match - both readings are
    a bug; figure out which behavior is intended.
  - `venice/tools/recipe_photos.ts:39` - `crypto.subtle.digest`
    rejects `Uint8Array<ArrayBufferLike>` under the newer
    `BufferSource` typing (the SharedArrayBuffer-aware split).
  Latent because nothing in the gate runs `deno check` over these
  files - `deno test` only type-checks what the test files import,
  and the deploy bundles with esbuild, no type check. Worth deciding
  whether the functions tree should get a `deno check` gate once the
  errors are fixed, so the next strictness bump surfaces in CI
  instead of mid-task.
- **Cookbook-change event bus lost its publisher.**
  `src/lib/cookbook-events.ts` exposes `onCookbookChange` (subscribe)
  and used to expose `notifyCookbookChanged` (a `window` CustomEvent
  dispatch). The only publisher was the browser `recipe_*` tools'
  `execute()`; those went server-side, so Phase 1 deleted the orphaned
  publisher (knip-flagged). The **subscribers stay live** - the
  Cookbook modal and the drawer's Recipes tab subscribe to refresh
  their lists - so a **chat-driven recipe write no longer refreshes
  those views**. Pre-existing since the streaming migration (the
  browser `execute()` was already dead); Phase 1 only made it visible.
  Direct UI edits in `Cookbook.svelte` (which call
  `SupabaseService.createRecipe/updateRecipe/revertRecipe` directly,
  still live) refresh their own local state and never used the bus.
  **Fix shape:** re-drive the refresh with a server-aware trigger - a
  `recipes`-table Realtime subscription is the natural shape (mirrors
  how other server-side writes notify the browser). Same pattern the
  Phase 2 agent runs will want for progress streaming, so it may fall
  out of that work.

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
  block the dispatcher consolidation. **Marked for re-inspection once
  Phase 3 closes** (user directive, 2026-06-09) - see the Phase 5
  ledger entry. Samskara in particular has an upstream change landing
  shortly; whatever the re-inspection decides for it must wait for
  that rebase and a fresh read of the area.
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
