# Audit Fix 5+1: Delete dead browser stream-guards.ts

> **Status: complete.**

## What

Deleted `src/lib/stream-guards.ts` (218 lines of dead guard code). Guard execution moved server-side. The browser file
defined its own copies of types and primitives that already exist in `_shared/venice-stream.ts`. Only
`GuardExhaustedError` was used in production (by `Chat.svelte`), and it was already in the shared module. This subsumes
Fix 1 (the diverged `RETRY_TEMPERATURE_SCHEDULE` went away with the file).

## Stack

1. Updated `Chat.svelte` to import `GuardExhaustedError` from
`$shared/venice-stream` instead of `$lib/stream-guards`.
2. Deleted `modelLeaksSpecialTokens` from
`src/lib/models/index.ts` (only caller was the dead `streamGuardsFor`). Kept the `leaksSpecialTokens` property on
`ModelSpec` (source of truth the edge greps from). Updated doc comments that referenced the deleted function and file.
3. Updated comment in `src/lib/exchange/exchange-slot.svelte.ts`.
4. Updated comment in `src/lib/models/catalog.ts`.
5. Updated comment in `_shared/venice-stream.ts:716`.
6. Deleted `tests/stream-guards.test.ts` (tested dead code).
7. Deleted `src/lib/stream-guards.ts`.
8. `mise run check` - green.
9. Playwright smoke test - streaming + tool dispatch healthy.

## Discovery: dead `instanceof GuardExhaustedError` check

While tracing the `GuardExhaustedError` import, found that `Chat.svelte:4726` had a dead `instanceof
GuardExhaustedError` check. The server collapses `GuardExhaustedError` to `{ type: 'error', kind: 'internal' }` in
`errorEventFor` (`getStreamingCompletion.ts:727`). The browser's `stream-events.ts:323` reconstructs that as a
`VeniceError`, not a `GuardExhaustedError`. So the `instanceof` check could never be true.

The user-visible effect: when guard exhaustion fired, the user got a generic "stream ended in error state" message
instead of the helpful "The model kept returning a malformed response" message with a retry button.

Fixed by replacing the `instanceof` check with a message-prefix check (`err.message.startsWith('Stream guard "')`),
matching what the server does in `getStreamingResponse.ts:555` for `threads.last_error`. Removed the
`GuardExhaustedError` import from `Chat.svelte` entirely.
