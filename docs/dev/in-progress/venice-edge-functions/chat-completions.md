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

The non-streaming leaf is DONE end-to-end. The streaming root is
the only chat-completion path still browser-direct.

### Non-streaming leaf (DONE)

The `/complete` route on the venice function runs as a thin
proxy: the browser owns `buildChatBody` (a free export from
`src/lib/venice.ts`) and `parseChatCompletion`; the function
attaches the shared key, forwards Venice's wire-shape body, and
relays the response verbatim. On 429 the function reads
Venice's `Retry-After` / `x-ratelimit-reset-*` header into a
`retryAfterMs` field on the JSON error body so the browser's
retry loop can act on the hint - the headers themselves do not
survive the `functions.invoke` round trip.

`SupabaseService.complete` owns the 429 retry loop. The
`COMPLETE_RATE_LIMIT_*` constants and the `sleepCancellable`
helper live private to `src/lib/supabase.ts` next to the
consumer (they were exported from `venice.ts` during the
worker-fleet migration; the cleanup commit re-homed them once
the old `VeniceClient.completeChat` -- their only other reader
-- got deleted). This sidesteps the wire-shape duplication
question: the body builder stays browser-side rather than
being copied into the Deno helper, and the function ends up
~30 lines.

Every browser caller now goes through `SupabaseService.
complete`. `VeniceClient.completeChat` is deleted. Per-sweep
history in the [Migration history](#migration-history) section
below.

### Streaming root (untouched)

`VeniceClient.streamChat` and its single caller
`src/lib/chat-loop.ts:614` remain browser-direct. The
[Target state](#target-state) section below describes where
they go; the design fork on client-side stream collection is
still open.

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

## Migration history

The non-streaming sweep shipped across nine commits, each
one self-contained behind a green gate. Recorded here so a
future session can read the history without spelunking git
log.

1. **`claude/complete-edge-function` (milestone 6).** The
   thin-proxy `/complete` route landed. `SupabaseService.
   complete` got built; tools (analyze_image,
   research_docs, web_search), the intuition pipeline, and
   the auto-title pipeline migrated.
2. **`claude/headless-tool-loop-complete`.** `runHeadlessToolLoop`
   in `src/lib/tools/run.ts` dropped its `venice: VeniceClient`
   opt and drove `toolCtx.supabase.complete` instead. The eight
   agent classes that compose the loop (rem, recall,
   conversation_recall, wiki_recall, reflection, wiki,
   deep-sleep, wiki-librarian) stopped passing `venice: this.
   venice` at the call site.
3. **`claude/recall-family-complete`.** `RecallAgent`,
   `ConversationRecallAgent`, `WikiRecallAgent` dropped venice
   from their constructors; the three tool dispatchers
   (memory_recall, conversation_recall, wiki_recall) stopped
   passing `ctx.venice`. `ToolContext.venice` became optional;
   wiki_librarian's tool dispatcher used a non-null assertion
   as a transitional measure.
4. **`claude/deep-sleep-rem-complete`.** The memory-librarian
   pair shipped together: both agent classes, both workers, both
   managers, plus the shared `memory-librarian-run.svelte.ts`
   dispatcher and the `Memories.svelte` caller. Both runners
   dropped venice from `RunManuallyOpts`.
5. **`claude/bias-agent-complete`.** First no-tool-loop agent
   migration. The `callOnce` helper that drives Venice
   directly swapped to `SupabaseService.complete`; the rate-
   limit branch (`VeniceError.kind === 'rate_limit'`) ported
   verbatim because the function side preserves the error
   shape.
6. **`claude/samskara-agent-complete`.** Twin of bias: four
   `callOnce` sites across the phase methods plus the
   compound-summary regen path swapped to `supabase.complete`.
7. **`claude/wiki-agent-complete`.** Mixed-pattern agent. Most
   rounds drive the migrated `runHeadlessToolLoop`; the per-
   article manual `updateOne` makes one direct
   `supabase.complete` call. The content-classifier primary
   -> uncensored-fallback retry path ported verbatim --
   Venice's 400 response still arrives as a `VeniceError`
   regardless of which client wraps it. Main-thread WikiAgent
   constructors in `Wiki.svelte` and `WikiSkippedPanel.svelte`
   stopped guarding on `app.venice`.
8. **`claude/wiki-librarian-agent-complete`.** Milestone-
   marker sweep. Wiki-librarian's agent + worker + manager +
   runner.svelte.ts, plus the supervisor worker hosting the
   five remaining agents (reflection, summary, topics,
   memory_topics, recipe_topics), all migrated in one commit
   because the alternative would have left orphan
   `private venice` fields on the supervisor-hosted classes
   that TypeScript flagged. With wiki-librarian's tool
   dispatcher no longer reading `ctx.venice`,
   `ToolContext.venice` was deleted outright; the non-null
   assertion in `tools/wiki_librarian.ts`, the `venice`
   slot on chat-loop's ToolContext literal, and the
   `app.venice` guards in `Wiki.svelte`'s
   `submitLibrarianRun` came off in the same commit.
9. **`claude/venice-migration-cleanup`.** Orphan deletion.
   `VeniceClient.completeChat` deleted; the
   `COMPLETE_CHAT_RATE_LIMIT_*` exports and the
   `sleepCancellable` helper deleted from `venice.ts` and
   re-homed private into `src/lib/supabase.ts` next to the
   one remaining consumer. The
   `describe('VeniceClient.completeChat', ...)` block in
   `tests/venice.test.ts` (~300 lines) and the dead
   `web-search.integration.test.ts` historical-bug
   reproduction deleted.

The protocol shape that made the worker-side sweeps purely
mechanical was already in place when the migration started:
every worker already did `client.auth.setSession(...)` to
JWT-authenticate a `SupabaseService` at startup, so
`SupabaseService.complete` could simply call
`functions.invoke('venice/complete')` and inherit the session
JWT through `verify_jwt`. The per-worker migrations are
deletion-only -- drop `VeniceClient` construction, drop
`veniceApiKey` from the StartMessage + manager postMessage,
drop the venice arg on the agent constructor.

**Carryforward worth flagging:** `SupabaseService.complete`
honors `req.signal` only around the 429 retry sleep, not
during the in-flight `functions.invoke` POST. The Supabase JS
client's `functions.invoke` API exposes no abort hook; a
mid-fetch abort waits for the POST to settle, then fires at
the next round boundary. Same limitation already applies to
`embed`, `extractText`, `generateImage`. Documented in
`docs/dev/tools.md` "Abort semantics on the headless loop"
and inline at the top of `src/lib/tools/run.ts`. If a future
Supabase client release adds `signal:` to `functions.invoke`
opts (or we switch to raw fetch against the function URL),
this gap closes for free.

## `veniceApiKey` removal from worker-start messages

DONE as a side effect of the per-worker migrations above.
Each worker that used to receive a `veniceApiKey` on its
start payload now receives `{ supabaseUrl,
supabasePublishableKey, accessToken, refreshToken, ... }` and
authenticates its `SupabaseService` through
`client.auth.setSession`. No worker still reads
`veniceApiKey`. The encrypted `app_config` field in
localStorage is the same shape it was, but only the streaming
chat-loop (`streamChat`) reads `veniceApiKey` from it
now -- once the streaming root migrates, the local
`veniceApiKey` field on `Config` becomes deletable too.

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
