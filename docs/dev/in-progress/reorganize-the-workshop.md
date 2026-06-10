# Reorganize the workshop: collapse the tool-dispatch split

## STATUS (2026-06-10)

**Phases 1-4 are all landed; the end state below is the actual state
of the tree.** What remains:

- **Production verification** for everything that landed local-only:
  reflection, the edge-to-drawer log streaming, wiki, wiki-librarian,
  and rem + deep-sleep. Per-fleet checklists live in each fleet's
  Status block; the bar is the Phase 2 verification gate (watch a
  hosted cron tick claim and process real work, confirm the drawer
  sources, round-trip the manual runs).

The Phase 5 ledger closed 2026-06-10: the Deno type errors are fixed
and the Deno island joined the `mise run check` gate; the cookbook
realtime relay landed (and surfaced a DELETE-delivery gap fixed for
all three relays); the no-tool agents re-inspection is recorded in
`../planned-changes.md` under "Retire the browser supervisor."

## SYNOPSIS

**Collapse the tool-dispatch split.** Tools used to live in two
places - the venice edge function's `performToolCall` registry, and the
browser's `executeToolCall` / `executeToolboxCall`. The streaming-root
migration moved main-chat dispatch server-side; this project moved the
**agent fleet** (reflection, rem, deep-sleep, wiki, wiki-librarian)
out of its Web Workers to finish the job. End state, now reached:
**one dispatcher, one registry**, both living in the edge function.
Browser is purely "express user intent, render system state."

## PURPOSE

Before this project, the **same tool name** (e.g. `memory_search`) had
**two live implementations** - one in `src/lib/tools/memory_search.ts`
for the agents, one in `supabase/functions/venice/tools/
memory_search.ts` for main chat. They were independently maintained
and the schemas drifted on their own (the wiki librarian's inline
copies were caught carrying wrong caps; the edge confidence-band
mirror had drifted bands - both found and fixed mid-migration, both
instances of exactly this disease). The browser `execute()` paths
were also a mix of "alive" and "dead-because-chat-loop-moved" - the
live-or-dead split was invisible without grepping.

**Two dispatchers for one contract is the anti-attractor.** Until both
halves collapsed into the function side, the cleanup work after every
edge-function feature had a parallel-impl tax: write the tool, write
its browser twin, hope they stay in sync. The browser-side agent
fleets were what kept that tax alive.

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
**rem + deep-sleep** [DONE - one PR; see the combined design below].
All five fleets are server-side; Phase 2 is complete pending the
production verifications listed per fleet.
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
| **rem** | memory librarian set | scheduled batch + user-triggered | pg_cron + HTTP POST |
| **deep-sleep** | memory librarian set | scheduled batch + user-triggered | pg_cron + HTTP POST |

(Correction from research: rem has a manual "run now" path too - the
Memories top-bar drives BOTH librarians through a shared progress
strip, not just deep-sleep as an earlier draft of this table said.)

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

#### Rem + deep-sleep: concrete design (combined fleet) [LANDED, pending prod verify]

**Status.** Shipped across two commits (server, then browser
cutover): `agents/rem.ts` + `agents/deep_sleep.ts` with the shared
toolbox/guard module (`agents/_memory_librarian_tools.ts`), the
`memory_consolidate` tool port, the global definer claims + shared
in-flight guard + two hourly crons (minutes 17/47) in schema.sql, the
four routes (`/rem-sweep`, `/deep-sleep-sweep` service-role;
`/rem-run`, `/deep-sleep-run` user-JWT with agent-runs progress
events), the dev-shim ticks, and the full browser cutover - which
took most of PHASE 3 with it (see there; the impls fell dead with
their last dispatcher). Both agents thread the completion seam from
day one; deep-sleep adds an `embed` seam so the batch pipeline tests
run without network
(`supabase/functions/tests/memory_librarian{,_behavior}.test.ts`,
`memory_consolidate.test.ts`). `memories` joined the realtime
publication; Chat.svelte relays the postgres_changes echo into
`emitMemoryChange`. Drift bug fixed in passing: the edge mirror of
`classifyMemoryConfidence` had wrong bands (tagged the neutral
[1.5, 5.0) band 'hedged'; dropped 'shaky' below 0.05) - realigned to
the browser's. Gate (1417 vitest) + Deno (118) + knip + markdownlint
green. **Locally verified end-to-end**, including in-browser: sweep
ticks (rem reviewed a real co-occurrence batch; deep-sleep performed
a real consolidation with changelog row), cadence gates, busy
collision, 403/401, and the Memories strip streaming live step
events over the Broadcast pipe with the model-narrated activity
labels (a real `memory_relate` edge landed during the eyeball run).
**Production verification still owed** per the Phase 2 gate.

**Why one PR for two fleets.** The two memory librarians are
conjoined to a degree wiki/wiki-librarian were not: one toolbox
(`memory_librarian_toolbox` - the sole consumer of
`memory_consolidate`), one model slot (both `deepseek-v4-flash`),
one Settings toggle (`memoryLibrarianEnabled` starts/stops both),
one cross-device mutex (the shared `'memory-librarian'` lease
partition), and one Memories-screen UI (a single
`memory-librarian-run.svelte.ts` state module drives both manual-run
buttons through one progress strip). Migrating rem alone would leave
that shared strip running two protocols at once (Broadcast events
for rem, in-page callbacks for deep-sleep), open a transitional
mutex gap (a server rem sweep cannot see the browser lease
deep-sleep holds), and force a second pass over every shared file.
Deep-sleep's marginal cost on top of rem is small - simpler prompt
than the wiki librarian, and its one extra ingredient (server-side
query embedding) already exists in `_shared/backfill.ts` +
`tools/memory_search.ts`.

**What each agent does** (unchanged - the prompts port verbatim):
deep-sleep consolidates SIMILARITY neighborhoods (oldest-unvisited
seed -> embed -> top-8 cosine neighbors above 0.80 -> the agent
merges/relates/doubts); rem integrates CO-OCCURRENCE batches (oldest
eligible conversation from `memory_conversation` -> the memories the
recall agent surfaced together -> the agent draws the missed graph
edges). Both bottom out in the same toolbox; both treat "no changes"
as the default outcome. The hint queue rem drains is already fed
server-side - `agents/recall.ts` upserts `memory_conversation` rows -
so the browser's `upsertMemoryConversationRows` is already dead and
dies in the cutover.

**Trigger surfaces** (the librarian pattern, twice):

- **Scheduled**: two hourly pg_cron jobs at offset minutes -
  `nak_trigger_rem_sweep()` (minute 17) and
  `nak_trigger_deep_sleep_sweep()` (minute 47) - POSTing to
  `/rem-sweep` and `/deep-sleep-sweep` (isServiceRole). The per-user
  invoker claims (`claim_rem_run` / `claim_deep_sleep_run`,
  auth.uid()-gated booleans) are replaced by global SECURITY DEFINER
  `claim_next_user_for_rem` / `claim_next_user_for_deep_sleep`
  (clones of the wiki librarian's: stamp the cadence column BEFORE
  the run, gate on `settings->>'memoryLibrarianEnabled' is distinct
  from 'false'`, most-overdue user first, FOR UPDATE SKIP LOCKED,
  EXECUTE service_role only). The cadence columns
  (`rem_last_run_at`, `deep_sleep_last_run_at`) stay independent so
  the 12h cycles drift apart naturally, same as today.
- **Manual** (Memories top-bar): user-JWT `POST /rem-run` /
  `POST /deep-sleep-run` with `{runId}`. No cadence stamp (faithful:
  the browser manual runners bypassed the claim). Step events ride
  the existing `agent-runs:<userId>` Broadcast channel with the
  client-minted runId for demux; the strip subscribes BEFORE the
  POST.

**Mutual exclusion: one shared in-flight guard.** The browser lease
made the two SCHEDULED librarians mutually exclusive per user but
left manual runs only locally guarded (a manual run could overlap a
remote device's scheduled run). The server replaces all of it with
one `claim_memory_librarian_inflight` / `release` pair (holder +
TTL, on profiles - the wiki librarian's guard shape) taken by all
four paths (2 sweeps, 2 manual routes). That preserves the stated
intent ("only one of the two can run at a time per user") and closes
the manual-run hole for free. Collisions return `{kind:'busy'}`.

**Server-side prerequisites:**

- Port `memory_consolidate` (the one librarian tool the registry
  lacks). Validation verbatim; calls the `consolidate_memories` RPC;
  changelog entry via `_memory_changelog.ts`.
- `p_user_id` b-strict overloads for `pick_rem_eligible_conversations`,
  `search_memories_by_embedding_scored`, and `consolidate_memories`
  (all invoker + auth.uid() today; the admin client needs the
  explicit-user escape hatch). The plain table reads/writes
  (seed pick, batch fetch, mark-processed, mark-visited) go through
  the admin client with explicit `user_id` scoping, like the wiki
  helpers.
- Shared toolbox builder in `agents/_memory_librarian_tools.ts`
  (both agents consume it; the composition invariants - no
  memory_create/update/reaffirm/delete, no ask_user - get one Deno
  test). Wire schemas for invalidate/doubt/relate/unrelate move from
  reflection.ts to the shared module where both consumers need them.

**UI refresh.** Server-side memory writes can't fire the in-page
`emitMemoryChange`. Add `memories` to the `supabase_realtime`
publication and a `subscribeToMemoryChanges` postgres_changes
subscription that re-drives `emitMemoryChange` - the exact shape of
the wiki fleet's `wiki_articles` subscription. (This also fixes a
pre-existing gap: the browser WORKER runs called `emitMemoryChange`
inside the worker's module instance, which never reached the main
thread's Memories panel anyway.)

**Browser cutover.** Delete `src/lib/agents/rem/` and
`src/lib/agents/deep-sleep/` (7 files each),
`memory_librarian_toolbox.ts`, and every browser tool impl that
falls dead with them - this is the LAST fleet, so the expectation is
all 10 remaining impls (9 memory + conversation_search) plus the
aggregator go, leaving Phase 3 only the shared infra
(`runHeadlessToolLoop`, `lazy.ts`, dispatch plumbing).
`memory-librarian-run.svelte.ts` is rewritten subscribe-then-POST
(the navigation-stable singleton design survives; only the transport
changes). `state.svelte.ts` drops both lazyManagers;
`setMemoryLibrarianEnabled` becomes a plain settings write the claim
predicates read. The Memories top-bar keeps both buttons; the
workerBusy gray-out goes the way of the librarian's (the guard's
busy error covers the collision).

**Tests through the seam from day one** (the Phase 3 gate rule):
toolbox/prompt invariants plus fake-admin behavioral coverage - rem
agent error leaves the conversation UNprocessed (retry next cycle),
too-small batches mark processed, deep-sleep's lonely seed stamps
its visit and skips Venice entirely, an agent error skips the visit
stamps. The browser suites
(`tests/memory-librarian-run.test.ts`,
`tests/memory-consolidate-tool.test.ts`) port or die with their
subjects; `tests/memory-librarian-ui.test.ts` (pure UI primitives)
stays.

### PHASE 3 - demolition [DONE - landed with the rem + deep-sleep cutover]

**After all 5 agents are server-side**, the entire browser dispatcher
becomes orphaned. The plan called for a separate cleanup PR, but the
Phase 2 rule ("the browser impls of its tools may newly fall dead -
drop them alongside the migration PR") swallowed the whole list when
the last fleet landed: with rem + deep-sleep gone, NOTHING dispatched
tools in the browser, so the final cutover commit took the lot.
Dropped:

- `src/lib/tools/run.ts` (`runHeadlessToolLoop`).
- `src/lib/tools/dispatch.ts` whole: `executeToolboxCall` and
  `buildToolboxWireList` died; the wire projector (`toOpenAIToolDef`
  plus the activity-parameter injection, which `buildToolList` still
  needs) moved to `wire.ts` with the other wire-shape helpers.
- The last agent-side toolbox aggregator
  (`memory_librarian_toolbox.ts`). The other three
  (`memory_toolbox.ts`, `wiki_toolbox.ts`,
  `wiki_librarian_toolbox.ts`) already went in Phase 2 - each was
  exclusive to its fleet, so it died with that fleet's cutover.
- All 10 surviving browser tool impl files (the 9 memory tools +
  `conversation_search`) plus `memory_invalidate`'s impl + schema
  (agent-only - it was never in a chat toolbox, so its schema died
  too). Every other schema stays - `buildToolList` uses them; every
  chat ToolDef is a `serverSideTool` now.
- `src/lib/tools/lazy.ts` (`lazyTool` lost its last caller).
- The browser test suites whose subjects died
  (`tools-run`, `memory-volitional-tools`, `memory-consolidate-tool`,
  `memory-librarian-run`, `conversation-search-own-thread`); their
  invariants live in the Deno suites. `SupabaseService` shed the
  agent-only methods (the librarian claim/queue/visit family, plus
  the orphaned `decay`/`bumpMemoryConfidence` pair).

The wiki agent shell (`src/lib/agents/wiki/agent.ts`) survives
deliberately - it carries only the manual `updateOne` flow, a no-tool
completion outside the dispatcher split.

**Also in this phase - NOT optional: restore the agent-loop test
seam.** [DONE - landed with the wiki-librarian fleet, as
recommended.] `RunHeadlessAgentOptions.complete` is the injectable
completion override (default `toolComplete`); the behavioral tests
the browser suites used to carry are back through it -
`supabase/functions/tests/wiki_behavior.test.ts` restores the wiki
agent's primary-then-fallback ordering and the retry flow's
pointer/skip-marker semantics, and `agent_run.test.ts` covers the
seam + progress hook themselves. The rem/deep-sleep ports used the
seam from day one as required
(`memory_librarian_behavior.test.ts`, plus deep-sleep's `embed`
seam for the network-free batch pipeline).

**Done when:** `src/lib/tools/` contains only `.schema.ts` files +
`types.ts` + `wire.ts` + `server_side.ts` + `index.ts` (a schema-only
catalog), and the server-side agents' in-run behaviors are
unit-tested through the runner's injection seam. One dispatcher, one
registry, end of split. **This is now the actual state of the
tree.**

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

- **Re-inspect the no-tool completion agents after Phase 3.**
  [CLOSED 2026-06-10.] All eight plain-completion agents
  re-inspected (samskara got its mandated fresh read of the tier-2
  area first). Full assessment recorded in
  `../planned-changes.md` under "Retire the browser supervisor";
  the verdict in one breath: the five supervisor units should port
  (the migration turned memory_topics / recipe_topics into a
  server-writes/browser-drains anti-pattern - rem rewrites a
  memory's label at 3am and the tags wait for a browser tab; the
  three thread-shaped units ride the reflection-style waitUntil
  tail), which deletes the supervisor worker and its whole lease
  apparatus; bias is portable but optional (no structural gap);
  intuition is turn-coupled, not a fleet - it only moves if
  context-recall ever folds into /stream; samskara stays
  browser-side until tier-2 bakes.
- **Pre-existing Deno type errors, surfaced by a Deno upgrade.**
  [CLOSED 2026-06-10.] All three fixed, and the gap that hid them is
  closed:
  - The `'truncated'` errors were type-level drift between two
    parallel `VeniceErrorKind` unions - `_shared/venice.ts` (owning
    the `VeniceError` class, 5 kinds) and `_shared/venice-stream.ts`
    (the wire contract, 7 kinds). Runtime behavior was fine (the
    throw and the catch agreed on the string); the class union was
    just stale. Fix: venice.ts now type-imports the union from
    venice-stream.ts - one vocabulary, no second copy to drift.
  - `recipe_photos.ts` - `sha256Hex` now takes
    `Uint8Array<ArrayBuffer>`; its only caller constructs a fresh
    ArrayBuffer-backed view.
  - The gate decision: YES. New `functions-check` task runs
    `deno check` over all three function entrypoints (full deploy
    import graph), and the `check` gate now depends on both
    `functions-check` and `functions-test` - so the Deno island
    gates PRs and CI like the rest of the tree. Fixing this also
    surfaced that `createEdgeLogger`'s env reads threw `NotCapable`
    under deno test's default sandbox; the logger now treats a
    denied env read as "unset" (console-only logging), keeping the
    test suite permission-free.
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
  `recipes`-table Realtime subscription is the natural shape. The
  worked pattern now exists twice: `subscribeToWikiArticleChanges`
  (wiki fleet) and `subscribeToMemoryChanges` (rem + deep-sleep
  fleet), both publication members + a Chat.svelte effect relaying
  into the feature's event bus. Recipes is a copy of either.
  [CLOSED 2026-06-10.] Landed exactly as the fix shape describes:
  `recipes` publication member, `subscribeToRecipeChanges`,
  Chat.svelte relay into a resurrected `emitCookbookChange`.
  Verified live (SQL insert/delete as the dev user refreshed an open
  Recipes tab with no reload). The live test caught a gap the
  INSERT/UPDATE-only verification of the first two relays missed: a
  DELETE's WAL record carries only the replica identity (pkey by
  default), so realtime can't match the `user_id` filter and drops
  the event - server-side deletes never refreshed any of the three
  panels. Fixed for all three tables with a unique `(id, user_id)`
  index as the replica identity (REPLICA IDENTITY FULL would have
  worked too, but writes whole old rows - including vector(2048)
  embeddings - into WAL on every update/delete). Gotcha recorded in
  cookbook.md, wiki.md, and memory.md.

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
  ledger entry; Phase 3 has closed, so this is actionable. Samskara's
  upstream change (the tier-2 compound mint phase) has landed and the
  branch is rebased onto it; the re-inspection still owes that area a
  fresh full read before deciding anything - it is a six-phase loop
  with new schema machinery now, not the shape prior plans knew.
- **The composer popover + thread state UI** - reads
  `thread.toolboxes_enabled` directly, writes via
  `setThreadToolboxesEnabled`. No dispatcher coupling.
- **`buildToolList`** - schema-only catalog composer. Stays in the
  browser; runs per chat turn against `thread.toolboxes_enabled`.
- **`ask_user` parse/build helpers** - `parseAskUserContent`,
  `buildAskUserAnswerContent`, the `ASK_USER_*_FLAG` constants.
  Consumed by `Chat.svelte` for the UI suspend/resume flow. [Moved to
  `src/lib/ask-user.ts` during Phase 1, as planned.]

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

## Open questions [all resolved]

Surfaced before the migration so they wouldn't bite mid-flight; kept
with their outcomes since the reasoning is reusable.

- **Should the agent's progress channel be per-run or per-thread?**
  [Resolved: NEITHER - per-USER.] The recommendation here was per-run
  (`nak-agent:<runId>`), but the wiki-librarian fleet landed a
  per-user `agent-runs:<userId>` topic with the client-minted runId
  in the payload for demux: one literal-equality `realtime.messages`
  policy covers every run, where per-run topics would have needed
  pattern-matched channel auth. All three manual-run strips (wiki
  librarian, rem, deep-sleep) share it.
- **Where does the supervisor's scheduling state live after cutover?**
  [Resolved as predicted: the supervisor shrank.] Reflection's unit
  was dropped when its trigger moved to the chat-turn waitUntil tail;
  the supervisor now schedules only the no-tool units (auto_title,
  summary, topics, memory_topics, recipe_topics, attachment_expiry).
- **Do we need a generic `/venice/agents/run` dispatcher or one
  endpoint per agent?** [Resolved: per-endpoint, as recommended.]
  Nine agent routes exist (`/wiki-sweep`, `/wiki-retry`,
  `/wiki-librarian-sweep`, `/wiki-librarian-run`, `/rem-sweep`,
  `/rem-run`, `/deep-sleep-sweep`, `/deep-sleep-run`, plus
  reflection's inline tail) and the per-route boilerplate stayed
  small enough that the generic dispatcher never earned its keep.
- **Reflection inline vs separate endpoint?** [Resolved: inline.]
  Fires from `getStreamingResponse`'s terminal tail via
  `edgeWaitUntil`; the testability isolation worry was answered by
  the runner's `complete` seam instead of an HTTP boundary.

## Where to go next

- [`./browser-tool-dead-code.md`](./browser-tool-dead-code.md) - the
  Phase 1 triage doc; the file-by-file lists and the
  `serverSideTool(schema)` helper recipe.
- [`../architecture.md` "Production-path ownership"](../architecture.md#production-path-ownership-browser-vs-edge-function) -
  the row-ownership framing this plan builds on.
- [`../edge-function-auth.md`](../edge-function-auth.md) - the
  b-strict admin-client + SECURITY DEFINER pattern every Phase 2
  migration uses.
- [`../tools.md`](../tools.md) - the tools subsystem doc, rewritten
  at project close to describe the single-dispatcher reality.
