# Refactoring lessons

> Lessons learned during the architecture audit cleanup. When the cleanup is complete, graduate durable findings into
> permanent dev docs or thatch memory and delete this doc.

## Lesson 1: instanceof checks across serialization boundaries are dead code

**Found during Fix 5.** `Chat.svelte` checked `err instanceof GuardExhaustedError` to surface a user-friendly "the model
kept returning a malformed response" message with a retry button. But the server collapses `GuardExhaustedError` to a
plain `{ type: 'error', kind: 'internal' }` object before publishing it on the Broadcast channel. The browser
reconstructs all stream errors as `VeniceError` instances. The `instanceof` check could never be true.

The user-visible effect: guard exhaustion silently fell through to the generic error path, showing "stream ended in
error state" with no retry button. This had been broken since guard execution moved server-side, but nothing caught it
because the failure is stochastic (guard exhaustion is rare) and the generic error path still shows *something*.

**General rule.** When an error class is thrown on one side of a serialization boundary (server -> Broadcast channel ->
browser in this case), the other side cannot use `instanceof` to detect it. The class identity is lost in transit.
Either:

- Send a distinguishable kind/flag in the serialized payload, or
- Detect by message prefix (fragile but works for a single well-known format), or
- Send a structured error code the receiver can switch on.

The server already had a prefix check (`ev.message.startsWith('Stream guard "')`) for its own `threads.last_error`
routing. The browser just needed to do the same. The fix was one line, but finding it required tracing the full error
flow across three files and two runtime boundaries.

**Detection signal.** If you see `instanceof FooError` where `FooError` is defined in a module the current runtime never
imports directly (only through a shared types re-export), the check is probably dead. The type may be available for
type-checking, but the class identity at runtime belongs to the runtime that constructed it.

## Lesson 2: dead code fossils accumulate when execution moves across the runtime boundary

**Found during Fix 5.** When guard execution moved from browser-side to server-side, the browser's `stream-guards.ts`
was left in place. It defined its own copies of `AttemptProgress`, `GuardVerdict`, `StreamGuard`, `combineVerdicts`,
`GuardExhaustedError`, and `RETRY_TEMPERATURE_SCHEDULE` - all of which already existed in `_shared/venice-stream.ts`.
The browser's `RETRY_TEMPERATURE_SCHEDULE` had even diverged from the edge's copy (2 entries vs 4 entries) with no
parity test catching it.

The only live export was `GuardExhaustedError` (used by `Chat.svelte`), and even that was dead code (see Lesson 1).
`modelLeaksSpecialTokens` in `models/index.ts` was also dead - its only caller was the dead `streamGuardsFor`.

**General rule.** When execution of a concern moves from one runtime to another, audit the source runtime for fossils.
Every type, function, and constant that the destination runtime now owns is a candidate for deletion. The migration may
have been done correctly on the destination side but left the source side as a partial ghost. Knip catches unused
exports, but it cannot catch "this export is used only by dead code that calls other dead code" - the dependency chain
has to be traced manually.

**Detection signal.** A file whose docstring says it handles a concern, but whose only production import is a single
type or error class, is likely a fossil. Check whether the concern it describes is now handled elsewhere.

## Lesson 3: not every long block should be extracted

**Found during Fix 10.** The finally block of getStreamingResponse.ts (~294 lines) handles terminal-state writes: the
commit_assistant_message RPC, the transitionRowTo fallback, stream_started_at clearing, threads.last_error assembly, END
event publishing, channel cleanup, and tail-agent dispatch (second-thoughts, curation, samskara).

It looked like a clean extraction target: one concern (terminal write), a clear boundary (the finally block). But it
closes over ~15 function-scoped variables and 3 closures (flushRowUpdate, ensureAssistantRow, publisher). Extracting it
would require a 20-field parameter interface with no cohesion - the caller would have to construct and pass all that
state, and the reader would have to jump between two files to understand the state flow.

**General rule.** Extraction is worth it when the extracted code has a clean signature: few parameters, no closures over
caller state, self-contained logic. A long block that is deeply coupled to its enclosing function's state is not a
separation-of-concerns problem - it is one concern that happens to be long. Extracting it creates indirection without
clarity. The test: would the extracted function's parameter list read as a coherent object, or as a grab-bag of
"everything the finally block happened to need"?

What WAS extractable from the same file: `attachGeneratedImages` (67 lines) is a self-contained IO side-effect with a
clean 4-parameter signature and no closures. That extraction was clean and worth doing.
