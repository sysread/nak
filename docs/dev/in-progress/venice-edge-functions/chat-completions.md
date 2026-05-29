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

To document: `streamChat` / `completeChat` in
`src/lib/venice.ts`, their call sites (chat loop, headless
agents, auto-title, summaries, the recall agents), and the
`ChatRequest` / `StreamEvent` / `ChatCompletion` contracts.

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

## Open questions

- Channel mechanism for the streaming root: dual-sink (live SSE +
  DB persist) or single-sink (DB row + realtime)? See Target state.
  Decide when this milestone goes active, not before.
- How do `venice_parameters` (web search, citations) survive the
  proxy?

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
