# Chat completions milestone

*Skeleton - embeddings lessons folded in (step 8); target state
still to define.* Part of the [Venice edge functions](./README.md)
project.

Wraps `POST /chat/completions` - both `VeniceClient.streamChat`
(streaming SSE) and `VeniceClient.completeChat` (holistic) - as
`/complete` routes on the `venice` function.

This is the hardest endpoint and should not be attempted before
embeddings proves the function/test/deploy spine.

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

## Current state

To document: `streamChat` / `completeChat` in
`src/lib/venice.ts`, their call sites (chat loop, headless
agents, auto-title, summaries, the recall agents), and the
`ChatRequest` / `StreamEvent` / `ChatCompletion` contracts.

## Target state

To define.

## Open questions

- Does streaming through the function buy enough to justify the
  hop, or does only the holistic `completeChat` path move while
  streaming stays direct?
- How do `venice_parameters` (web search, citations) survive the
  proxy?

## Lessons from the embeddings milestone

Folded in after embeddings shipped (step 7). The biggest one is a
scope reducer:

- **Most of the embeddings *schema* work does not transfer.** That
  milestone's hardest part - converting ten claim/save RPCs to
  `security definer` global sweeps, the EXECUTE-grant lockdown, the
  `pg_cron` / `pg_net` / Vault stack - exists only because backfill is
  a *background, user-less* job. Chat is user-triggered: the browser
  calls with the user's session JWT, `verify_jwt` stays on, and there
  is no cron, no service-role sweep, no Vault secret. The auth model to
  copy is `/embed`'s (per-user JWT), not `/backfill`'s (service-role
  bearer).
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
