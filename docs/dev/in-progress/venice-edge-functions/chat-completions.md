# Chat completions milestone

*Skeleton - embeddings lessons folded in (step 8); target state
still to define.* Part of the [Venice edge functions](./README.md)
project.

Wraps `POST /chat/completions` - both `VeniceClient.streamChat`
(streaming SSE) and `VeniceClient.completeChat` (holistic) - as
`/complete` routes on the `venice` function.

This is the hardest endpoint and should not be attempted before
embeddings proves the function/test/deploy spine.

These two methods are *not one milestone on one timeline.* In the
call tree (the README's [Strategic
spine](./README.md#strategic-spine-climbing-to-streaming-chat)) the
**non-streaming** `completeChat` is a *leaf* - the primitive that
tools and the intuition pipeline call - and moves early. The
**streaming** `streamChat` is the *root*, the strategic attractor,
and moves last. They share a route name and a wire endpoint; they
do not share a difficulty class or a schedule.

## Why this is the hard one

- **Streaming through a function.** `streamChat` consumes Venice
  SSE frames (`src/lib/venice.ts`, `parseSseFrame`). An edge
  function can return a `ReadableStream`, but proxying SSE means
  preserving frame framing, flush timing, and back-pressure end
  to end, plus mapping Venice's `[DONE]` sentinel.
- **Abort semantics.** The browser aborts mid-stream (user stops
  generation). That abort must propagate through the function to
  the upstream Venice request, not just close the near side.
- **Critical-path latency.** This is the live chat turn. Every
  added hop is felt directly, so phase 4 (move user-facing
  callers) needs a real latency argument, not just consistency.
- **Surviving client disconnect.** The whole point of moving the
  streaming root server-side is that a backgrounded mobile page
  kills the in-flight turn today. A proxy that still lets the
  browser hold the stream and write the message on completion is
  exactly as fragile - the fix only lands if the *function*
  persists the assistant message on its own authority and keeps
  running after the client goes away (`EdgeRuntime.waitUntil`,
  possibly a job row + cron for resume). This, not SSE plumbing,
  is the real hard part.

## Current state

The non-streaming leaf landed in two halves; the streaming root
still sits where this doc originally framed it.

### Front half: tools + intuition + auto-title (milestone 6, DONE)

Branch `claude/complete-edge-function` (commit `f5b2e95`). The
`/complete` route on the venice function runs as a thin proxy:
the browser already owns `buildChatBody` (now a free export from
`src/lib/venice.ts`) and `parseChatCompletion`; the function
attaches the shared key, forwards Venice's wire-shape body, and
relays the response verbatim. On 429 the function reads
Venice's `Retry-After` / `x-ratelimit-reset-*` header into a
`retryAfterMs` field on the JSON error body so the browser's
retry loop can act on the hint - the headers themselves do not
survive the `functions.invoke` round trip.

`SupabaseService.complete` owns the 429 retry loop (same
`COMPLETE_CHAT_RATE_LIMIT_*` schedule the old
`VeniceClient.completeChat` used; the constants are exported
now so the loop lives on one side without duplication). This
sidesteps the wire-shape duplication question raised below -
the body builder stays browser-side rather than being copied
into the Deno helper, and the function ends up ~30 lines.

Migrated callers: the tools `analyze_image`, `research_docs`,
and `web_search`; the full intuition pipeline (perception + 5
drives + synthesis); `generateThreadTitle` and the auto-title
worker's `CycleContext` plus the supervisor wiring.

### Back half: background-agent worker fleet (next milestone, DEFERRED)

`VeniceClient.completeChat` is intentionally NOT deleted yet.
The remaining callers each bootstrap their own `VeniceClient`
inside a Web Worker from a `veniceApiKey` postMessage:

- background agents: `bias`, `samskara`, `summary`, `topics`,
  `memory_topics`, `recipe_topics`, `wiki`, `wiki-librarian`,
  `deep-sleep`, `rem`.
- recall family: `recall`, `conversation_recall`, `wiki_recall`.
- the headless tool-loop driver `tools/run.ts:292`
  (`runHeadlessToolLoop`), which the recall family and the wiki
  librarian drive sub-tool loops with.

Why deferred: migrating means reshaping every worker-start
message protocol (`{ veniceApiKey, ... }` -> `{ supabaseUrl,
supabasePublishableKey, sessionJwt, ... }` or similar), then
threading a `SupabaseService` instance into the worker context
in place of the per-worker `new VeniceClient(...)`. Each
worker has its own caller in the main thread that has to
update in lockstep. That's a bigger blast radius than the
front-half leaf could land cleanly alongside.

`VeniceClient.completeChat` carries an inline docstring naming
this state explicitly so a future session reading the file
cannot mistake the leftover for an intentional divergence.
[migration-inventory.md](./migration-inventory.md) carries the
caller-level punch list.

See [Worker-fleet migration plan](#worker-fleet-migration-plan)
below for the concrete next-milestone shape.

### Streaming root (untouched)

`VeniceClient.streamChat` and its single caller
`src/lib/chat-loop.ts:614` remain browser-direct. The
[Target state](#target-state) section below still describes
where they go; the design fork on client-side stream
collection is still open. No work here this milestone.

## Target state

Two distinct shapes, matching the two positions in the call tree.

**Non-streaming `/complete` (the leaf, moves early).** A thin
proxy: take a `ChatRequest`, call Venice's holistic completion
server-side with the shared key, return the `ChatCompletion` JSON
whole. Per-user JWT auth like `/embed` - synchronous and
user-triggered, no cron or service-role sweep. Tools (web search,
doc research, image analysis) and the intuition pipeline migrate
onto this; then those callers themselves move into edge functions
composed of it.

**Streaming `/complete` (the root, moves last).** The streaming
turn runs server-side: the function reads Venice SSE, persists the
assistant message to the database itself, and the client collects
the live output. The load-bearing invariant is that message
persistence lives in the function, not the browser - that is what
makes a backgrounded page recoverable. *How* the client collects
the stream is the one open fork:

- **dual-sink** - the function tees: live SSE direct to the browser
  *and* a durable write to the DB on completion. Minimize kills the
  SSE; the DB write still lands; the browser reconciles the
  finished message on return. Smallest delta from today's streaming
  path.
- **single-sink** - the function writes incremental chunks to a DB
  row; the browser subscribes via realtime. One channel is both
  live and durable, at the cost of a debounced write cadence and
  realtime fan-out latency (laggier than direct SSE).

The fork stays open until this milestone goes active - naming the
destination lets future tactical choices climb toward it without
committing the channel mechanism prematurely.

## Worker-fleet migration plan

The next driver-B milestone. Scope: move every remaining
`VeniceClient.completeChat` caller (the [Back half](#back-half-background-agent-worker-fleet-next-milestone-deferred)
list above) onto `SupabaseService.complete` so
`VeniceClient.completeChat` can finally delete.

Step shape, in the order that lets each step ship with a
green gate:

1. **Pick the worker-start protocol shape. (DONE: no fork.)**
   Each Web Worker today already receives `{ supabaseUrl,
   supabasePublishableKey, accessToken, refreshToken,
   veniceApiKey, ... }` from the main thread and does
   `client.auth.setSession({ access_token, refresh_token })`
   before wrapping in `SupabaseService`. The migrated protocol
   just drops `veniceApiKey` + `veniceBaseUrl` from the start
   message; the JWT-authenticated SupabaseService is already
   in place, and `SupabaseService.complete` calls
   `functions.invoke('venice/complete')` which inherits the
   session JWT through `verify_jwt`. No architectural fork to
   settle - per-worker migration is purely deletion of the
   venice half. See deep-sleep/rem/wiki/wiki-librarian/bias/
   samskara/supervisor worker.ts for the canonical shape.

2. **Migrate the headless tool-loop driver
   (`tools/run.ts:292`). (DONE.)** Dropped
   `venice: VeniceClient` from `HeadlessToolLoopOptions`;
   the loop now drives `toolCtx.supabase.complete`. The
   recall family + wiki-librarian (which drive sub-tool
   loops through this helper) keep passing `toolCtx`
   unchanged - the swap is inside the driver. The agent
   classes that compose `runHeadlessToolLoop` calls
   (`rem`, `recall`, `conversation_recall`, `wiki_recall`,
   `reflection`, `wiki`, `deep-sleep`, `wiki-librarian`)
   stopped passing `venice: this.venice` at the top level;
   the leftover `toolCtx.venice` field stays populated
   because step 3 hasn't dropped it from `ToolContext`
   yet. Tests for the 6 affected agent / tool surfaces
   were rewritten to script `supabase.complete` instead of
   `venice.completeChat`.

3. **Migrate the recall family. (DONE.)** `RecallAgent`,
   `ConversationRecallAgent`, `WikiRecallAgent` -- all
   main-thread, no workers, all driven through the
   migrated headless tool loop. Each class dropped `venice`
   from its constructor; the three matching tool
   dispatchers (`memory_recall`, `conversation_recall`,
   `wiki_recall`) stopped passing `ctx.venice`. To stop the
   recall agents from having to populate a `venice` slot on
   their `toolCtx` literal, `ToolContext.venice` became
   optional. `wiki_librarian` -- the one remaining
   main-thread consumer of `ctx.venice` until its worker
   family migrates -- uses a non-null assertion at its
   dispatch site (`ctx.venice!`); the chat loop keeps
   populating the field for that path until the
   wiki-librarian sweep ships.

4. **Migrate the worker-resident agent families one at a
   time. (DONE.)** Every family in the worker fleet now
   drives `SupabaseService.complete` for chat completions.
   The shape per migration is unchanged:
   drop `venice: VeniceClient` from the agent constructor
   and the cycle context; replace
   `this.venice.completeChat(...)` with
   `this.supabase.complete(...)`; update the agent's
   worker.ts to stop creating the `VeniceClient` and stop
   reading `veniceApiKey` from the start message; update
   the main-thread caller of the worker to stop sending
   `veniceApiKey`. One agent + its worker + its caller per
   commit so the gate stays green and the diff stays
   reviewable. `deep-sleep` + `rem` shipped first as the
   `memory-librarian` pair (`claude/deep-sleep-rem-complete`)
   because they share a runner-svelte.ts pattern that made
   batching the pair natural. `bias` shipped next
   (`claude/bias-agent-complete`) as the first no-tool-loop
   agent migration -- it calls `SupabaseService.complete`
   directly via a `callOnce` helper rather than going through
   `runHeadlessToolLoop`. `samskara` followed
   (`claude/samskara-agent-complete`) -- same shape, four
   `callOnce` sites across its phase methods plus the
   compound-summary regen path. `wiki`
   (`claude/wiki-agent-complete`) mixes both patterns: its
   main per-thread flow runs through the migrated
   `runHeadlessToolLoop`, while the per-article manual
   `updateOne` makes one direct `supabase.complete` call.
   The content-classifier primary -> uncensored-fallback
   retry logic ports verbatim because the rejection comes
   back as a `VeniceError` either way -- the function side
   wraps Venice's 400 response into the same error shape
   the client expected. `wiki-librarian` + the supervisor-
   hosted set (reflection, summary, topics, memory_topics,
   recipe_topics) shipped together in
   `claude/wiki-librarian-agent-complete` as the milestone-
   marker sweep: with wiki-librarian's tool dispatcher
   stopping its use of `ctx.venice` and the supervisor's
   five hosted agents dropping `venice` from their
   constructors, `ToolContext.venice` had no consumers
   left and was deleted outright. The non-null assertion
   in `tools/wiki_librarian.ts`, the `venice` slot on
   chat-loop's ToolContext literal, and the `app.venice`
   guards in `Wiki.svelte`'s `submitLibrarianRun` all came
   off in the same commit.

5. **Delete `VeniceClient.completeChat`.** Once step 4 is
   complete the method has no remaining callers; delete it
   along with the now-unused
   `COMPLETE_CHAT_RATE_LIMIT_*` re-exports (their
   consumers, `SupabaseService.complete`, can pull them
   from a smaller internal home or inline them). Drop the
   "MIGRATION STATE" docstring block. Update
   `migration-inventory.md` to mark `completeChat` DONE.

6. **Audit `veniceApiKey` removal from worker-start
   messages.** A worker that no longer needs the key
   shouldn't be sent one; the encrypted `app_config` field
   in localStorage will become smaller. svelte-check
   enumerates the stragglers if the field is dropped from
   the type, which is the planned static-completeness fence
   the embeddings milestone established.

Open question deferred to the worker-fleet milestone, not
this one: whether to also delete `veniceApiKey` from the
project-wide config blob after this lands, or keep it for
the streaming root. The streaming root is the only thing
that needs the local key after this; whether it gets
collapsed onto the shared key (and the local field
deleted) is a streaming-milestone decision.

## Open questions

- Channel mechanism for the streaming root: dual-sink (live SSE +
  DB persist) or single-sink (DB row + realtime)? See Target state.
  Decide when this milestone goes active, not before.
- How do `venice_parameters` (web search, citations) survive the
  proxy? *Front-half answer*: in the non-streaming leaf they do
  survive cleanly - the function is a thin proxy, so the wire
  body lands at Venice unchanged. The streaming root will have
  to revisit this once SSE frame relay enters the picture.
- Worker-start protocol shape: bare `sessionJwt` vs reconstructed
  `Session` vs Supabase's own worker-side client init story.
  Settle in the worker-fleet milestone, not before.

## Lessons from the embeddings milestone

Folded in after embeddings shipped (step 7). The biggest one is a
scope reducer:

- **The embeddings *schema* work transfers to the leaf, not the
  root.** That milestone's hardest part - converting ten claim/save
  RPCs to `security definer` global sweeps, the EXECUTE-grant
  lockdown, the `pg_cron` / `pg_net` / Vault stack - exists because
  backfill is a *background, user-less* job. The **non-streaming
  primitive** is the opposite: synchronous, user-triggered, the
  browser calls with its session JWT, `verify_jwt` stays on, no cron,
  no service-role sweep, no Vault secret. Copy `/embed`'s per-user-JWT
  auth there. **But the streaming root is not synchronous** - once it
  fires-and-forgets and the client backgrounds, the function persists
  on its own authority and must outlive the request, which
  reintroduces the background-job machinery (service-role write-back,
  `EdgeRuntime.waitUntil`, possibly a job row + cron for resume). So
  this lesson cuts both ways: off the table for the leaf, back on it
  for the root.
- **One route per concern.** `/complete` is its own route beside
  `/embed`; do not overload. The fat-function rule is about *one
  deployed function*, not one handler.
- **Shared key, read server-side.** Like every route, `/complete`
  reads the project Venice key from `app_config` via the service role
  (the `readVeniceKey` helper already exists). The browser keeps using
  its local key until this consumer is migrated to `serverConfig`;
  that migration is the static-completeness check - delete the local
  `veniceApiKey` field once the last consumer moves, and svelte-check
  enumerates the stragglers.
- **Factor the pure parts; `deno test` them offline.** Backfill's win
  was an I/O-free core (`runBackfill`) with injected deps. The analogue
  here is the SSE frame parsing, `[DONE]` handling, and event shaping -
  pull it out as pure transforms over a fake upstream stream so the
  streaming logic is tested without a live Venice.
- **The wire-shape duplication question gets sharper here.**
  Embeddings duplicated a tiny embed body into `_shared/venice.ts` and
  deferred real code-sharing. Chat would have to duplicate the much
  larger stream / abort / `venice_parameters` machinery, so this is the
  endpoint where "share `src/lib/venice.ts` between app and function"
  stops being premature and becomes the consolidation decision worth
  making. Flag it before copying hundreds of lines.

These do not resolve the streaming-through-a-function and
abort-propagation questions above - those are genuinely new and unique
to this endpoint. They just take the schema/cron complexity off the
table.
