# Chat completions milestone

*Skeleton.* To be fleshed out after the
[embeddings milestone](./embeddings.md) and informed by its
lessons. Part of the [Venice edge functions](./README.md)
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

To be filled in when embeddings completes.
