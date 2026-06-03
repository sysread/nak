# Streaming-root edge function: design plan

## Synopsis

Move `venice.streamChat` behind a new `/stream` endpoint on the venice edge function. Internally, decompose into three composable modules - `getStreamingCompletion` (Venice SSE consumer + normalizer), `performToolCall` (single tool execution), `getStreamingResponse` (round-loop orchestrator + persistence + event publisher). The endpoint is a one-shot envelope: it returns `{channelName, assistantRowId, completedSoFar}` immediately and continues the streaming completion in the background via `EdgeRuntime.waitUntil()`. Live events publish to a Supabase Realtime Broadcast channel; resume state lives on the in-flight assistant row. The function ignores client disconnect by design - the mobile-PWA case (backgrounded tab loses connection) is exactly what the migration is escaping.

## 1. Transport: Broadcast + envelope + row-as-state

Three persistence sinks, each owning a different concern:

| Sink | Carries | Who reads |
|------|---------|-----------|
| HTTP envelope response | `{channelName, assistantRowId, completedSoFar}` | The client that POSTed `/stream` |
| Supabase Realtime Broadcast channel | Live events: text deltas, reasoning, tool calls, terminal events | Any subscribed client (current or reconnected, same device or other devices) |
| `messages` row with `status='streaming'` and incrementally-UPDATEd `content` | Resumable "completed-so-far" buffer | Any client that opens the thread |

Why this combination over the alternatives:

**Why not streaming HTTP response.** Original choice; wrong for the design goal. Writing to a `ReadableStream` whose consumer has disconnected is silent no-op at best, error at worst. Mobile Chrome aggressively pauses/kills backgrounded tabs - exactly the case the migration was born to handle. The function would either tear down with the connection (defeating the migration's purpose) or have to internally distinguish "client disconnected" from "client cancelled" with no reliable signal. Pick a transport that doesn't care about consumers.

**Why Broadcast over Postgres Changes on a stream_chunks table.** RLS per-row check, write amplification on every delta, single-threaded change processor. Wrong primitive at this rate. Earlier veto stands.

**Why Broadcast over LISTEN/NOTIFY.** Same shape with worse ergonomics; supabase-js doesn't surface NOTIFY messages as cleanly.

**Why Broadcast over WebSockets from the function.** `Deno.upgradeWebSocket` works but `verify_jwt` doesn't apply to upgrade requests - we'd lose the gateway-trust invariant. Bidirectional gains nothing useful: client -> function signaling is a single low-frequency event (cancel), trivially handled via a control message on Broadcast.

**Why the envelope response (vs returning channel info as the first Broadcast message).** Atomicity. The client needs to know the channel name AND the assistant row id AND any completed-so-far state synchronously. Returning them in the HTTP response avoids the bootstrap race ("did I subscribe in time to catch the first event").

**Rate budget:** Realtime Pro tier 500 msg/sec project-wide; Team 2500; Enterprise higher. nak's typical 1-3 concurrent streams × ~20 msg/sec per stream (tier 0 buffering) sit comfortably below. Adaptive buffering (section 2.6) handles the edge case where chunk rate spikes.

## 2. End-to-end workflow

### 2.1 Module decomposition

Three internal modules inside `supabase/functions/venice/`. Composed by direct async function call within one Deno deployment, NOT as separately-deployed Edge Functions calling each other over HTTP. Per-function cold start and JWT re-verification would compound badly. Splitting into separately-deployed functions remains possible later via the shared `_shared/` library structure if observability or per-tool isolation ever justify it.

**`getStreamingCompletion`** - lowest-level. Takes a `VeniceMessage[]` and a model/tool-spec/venice_parameters bundle. Opens the Venice SSE stream. Emits a normalized typed event stream. Critical insight (from the bash-script prototype): text events stream as small fast chunks, but tool-call fragments are buffered FULLY before emission so the consumer receives complete `tool_call_request` objects. The `pending: Map<index, ...>` fragment-assembler is internal to this module.

**`performToolCall`** - takes a complete `tool_call_request` and a `ToolContext` (admin-client `SupabaseService` + userId + threadId + AbortSignal + opt-in flags) and runs the tool's `execute(args, ctx)`. Returns the tool result object. Plain async function call. New code: today tool execution is browser-side via `dispatchTools` in chat-loop; the existing server-side agent workers (deep-sleep, rem, etc.) run their dispatch in Node, not Deno. The prior audit confirmed every tool is Deno-portable.

**`getStreamingResponse`** - composition layer. The `/stream` endpoint handler is a thin wrapper. Owns: round loop, assistant row create/UPDATE/terminal commit, rate-limit retry and output-guards wrappers, Broadcast publishing with adaptive backpressure (section 2.6), control-channel subscription for client-initiated cancel (section 2.7), `EdgeRuntime.waitUntil()` background lifecycle (section 2.8).

### 2.2 Client trigger

Browser does the same prep as today up to the point of streaming:

1. INSERTs the user message via `addMessage` (unchanged - anchor row still needs to exist before the function starts).
2. Slot wires up `slot.streamingText`, `slot.streamingReasoning` etc. as today. `slot.abortCtl` becomes the local UI-level abort (for "stop generating" button) and is NOT the function's abort signal.
3. POST `/venice/stream` with body: `threadId`, `userMessageId` (the anchor), `history` (the `VeniceMessage[]` baton at composer-send time), `model`, `venice_parameters`, enabled toolboxes, etc. This is a normal request/response - the body is small JSON. `supabase-js` `functions.invoke()` works fine here.
4. Function returns 200 with `{channelName, assistantRowId, completedSoFar: string}`. `completedSoFar` is empty for a fresh stream; populated for a reconnect (see 2.9).
5. Client subscribes to `channelName` via `supabase.channel(channelName).on('broadcast', ...).subscribe()`. Begins consuming events.

**Request-shape decision (v1):** browser assembles the full `history: VeniceMessage[]` baton (system message, memory recall results, intuition cards, prior user/assistant rows, attachments block) and the function consumes it as opaque. Tetris-stacked intermediate; follow-on migration target is a "get-next-response" function that owns assembly server-side. Portability audit (background agent) confirmed zero hard blockers for that future migration.

### 2.3 Server lock acquisition

**Important: today there is no pre-stream claim and no TTL fallback for the chat-send path.** The `SELECT ... FOR UPDATE` inside `add_assistant_message` (schema.sql:7015-7084) is scoped to the RPC transaction. Auto-releases on commit/rollback. No TTL, no holder column, no expiry path on the chat-send hot path.

The cross-device claim that lives in `Exchange` / `ThreadClaimCoordinator` (Chat.svelte:2973) is browser-side state today. It gates "one device drives the turn at a time" and triggers the abort-on-foreign-claim path. With the streaming function ignoring client disconnect, the claim coordinator's role shrinks: it still serves the "you can't send while another device is responding" composer-UI gate, but the cross-device streaming consumption case (section 3 ape mode) deliberately bypasses it because all devices read the same channel.

For v1: keep the browser-side claim. Server-side claim consolidation is a separate driver-A milestone.

### 2.4 Auth and database access (b-strict for streaming)

Streaming function lifetime is decoupled from the user's connected session. By design, the function continues after the browser disconnects, which means the session JWT may expire before the function's last DB write. This rules out user-scoped-client-as-defense-in-depth: we'd see mid-stream 401s on common backgrounded-tab cases.

**Pick: b-strict.** All DB access through the admin client (service role). Every query/RPC that touches user-scoped data passes `userId` explicitly. RLS does not protect us here; application discipline does. The defense-in-depth tradeoff is explicit and accepted: we're trading the RLS safety net for a function that survives session expiry. The discipline below must hold for the trade to be a net win.

- **Gateway** validates the session JWT at request entry via `verify_jwt: true`. Function extracts `userId` from the validated JWT's `sub` claim. Authoritative user identifier for the entire request.
- **Admin client for all internal DB work.** RPCs that take `user_id` explicitly (or are `SECURITY DEFINER` and infer it) are the safe path; direct INSERT/UPDATE via `.from(...)` must explicitly `.eq('user_id', userId)`.
- **Tool execution.** `performToolCall` constructs a `ToolContext` carrying the admin-client `SupabaseService` plus the resolved `userId`, `threadId`, etc. Tools see the admin client; any tool that reads user-scoped data must filter by `ctx.userId` or use a SECURITY DEFINER RPC. Tool-by-tool audit required at implementation time.

**Documentation discipline (required at implementation, not optional):**

- Every DB-access site carries a one-line inline comment naming the client in use and the userId filter (or the RPC's internal user-check).
- Every `.from(...).select(...)` / `.from(...).insert(...)` / `.from(...).update(...)` that does NOT go through a `SECURITY DEFINER` RPC carries `// RLS OFF: filter by userId` at the call site. Grep audit: any `// RLS OFF` line lacking an adjacent `userId` filter is a bug.
- A dedicated dev-doc page (`docs/dev/edge-function-auth.md`) covers the strict model end-to-end and the discipline.

### 2.5 `getStreamingCompletion` event vocabulary

Internal contract between `getStreamingCompletion` and its consumer (`getStreamingResponse` in v1). Emitted as a typed event stream over an async iterator inside the Deno process - NOT over a wire. Same union type is reused for Broadcast publishing in 2.6.

Per-completion frame:

- `BEGIN` - emitted once at stream start.
- `reasoning_text { content: string }` - small reasoning deltas, streamed promptly.
- `response_text { content: string }` - small response deltas, streamed promptly.
- `tool_call_request { id, name, args: object }` - full, complete tool call. Buffered fully before emission. Consumer never sees fragments.
- `usage { prompt_tokens, completion_tokens, ... }` - emitted once near end.
- `citations { citations: VeniceCitation[] }` - when web-search citations land.
- `DONE` - emitted once at stream end.

Plus stream-level events:

- `error { kind, message, retryable: boolean }` - upstream Venice call failed.
- `rate_limit_wait { retryAfterMs, attempt, until }` - retry in progress.
- `rate_limit_resolved` - retry succeeded; resume.
- `guard_retry { reason }` - output-guards re-rolled.

Rate-limit retry and output-guards wrappers live INSIDE `getStreamingCompletion`. A 429 retry is invisible at the BEGIN/DONE level (one BEGIN, one DONE per completion regardless of inner retries); the `rate_limit_*` events bubble up as separate signals the consumer can pass through to the client channel.

### 2.6 Broadcast publishing + adaptive buffering

`getStreamingResponse` publishes events to `channelName = thread:{threadId}:stream` via Supabase Realtime Broadcast. Events on the channel:

- Pass-through from `getStreamingCompletion`: `BEGIN`, `reasoning_text`, `response_text`, `tool_call_request`, `usage`, `citations`, `DONE`, `error`, `rate_limit_wait`, `rate_limit_resolved`, `guard_retry`.
- Added by `getStreamingResponse`: `tool_call_response { id, name, result_summary }`, `END { persistedAssistantId, terminalKind: 'completed' | 'aborted' | 'suspended_for_ask_user' | 'error' }`.

Tool results are summarized in the Broadcast event (~200 char `result_summary`). The full payload lives in the tool-result row on the DB; clients read it via the existing message subscription if they need more than the summary.

**Adaptive buffering (backpressure-driven):**

Text deltas (`response_text`, `reasoning_text`) are buffered with a tier-windowed flush. Other events are emitted promptly (latency-sensitive or rare). The function starts at tier 0 per invocation. On a 429 from a `broadcast.send()` call: bump the tier up. After 5s at the current tier with no 429: drop one tier back. Floor at tier 3, ceiling at tier 0.

| Tier | Flush window | ~msg/sec per stream | UX |
|------|--------------|---------------------|----|
| 0 | 50ms | ~20 | smooth, native streaming |
| 1 | 100ms | ~10 | slight visible chunking |
| 2 | 250ms | ~4 | "phrases at a time" |
| 3 | 500ms | ~2 | "feels typed" floor |

Detection is reactive (catch 429 from `broadcast.send()`). There is no proactive API to query the project's current rate-limit headroom. Concurrent function invocations can't coordinate without an external coordinator; each backs off independently. At nak's scale this is sufficient.

Buffered:

- `response_text` deltas (concatenated per window, emitted as one event)
- `reasoning_text` deltas (same)

Prompt (never buffered):

- `tool_call_request`, `tool_call_response` (latency-sensitive UI affordances)
- `END {terminalKind}` (terminal)
- `rate_limit_wait`, `rate_limit_resolved` (UI feedback)
- `guard_retry` (UI feedback)
- `error` (terminal)
- `usage`, `citations` (rare, end-of-stream)

### 2.7 Cancel via control channel

The function subscribes to a separate control channel `thread:{threadId}:control` for client-initiated cancellation. Polling a table for cancel would add per-event read latency and DB load; a Broadcast event is free and low-latency.

Client cancel UX:

1. User clicks "stop generating" in the UI.
2. Client publishes `{type: 'cancel'}` to `thread:{threadId}:control`.
3. Function (subscribed to its own control channel) receives the event.
4. Function aborts the upstream Venice fetch, aborts any in-flight `performToolCall` invocations, persists the partial content + `status='aborted'` on the assistant row, emits `END {terminalKind: 'aborted'}` on the stream channel, unsubscribes from control, exits.

Auth: control channel allows publish-by-thread-owner only. RLS-style policy on the channel: subscriber can publish only if `userId` matches the thread's owner.

The function only listens for `cancel` events on the control channel; everything else is ignored. Future control events (e.g., "tool needs input response") can be added without breaking the existing shape.

### 2.8 `getStreamingResponse` round loop + persistence

Per round inside `getStreamingResponse`:

1. **Call `getStreamingCompletion(history, model, ...)`.** Receive its event stream.
2. **At first content event** (any `response_text`, `reasoning_text`, or `tool_call_request`): create the assistant row via admin client with `content=''`, `status='streaming'`, parent `userMessageId` as anchor. Capture the row id; this is the `assistantRowId` returned in the HTTP envelope. This row is what the reconnect path reads.
3. **As content events accumulate:** UPDATE the assistant row's `content` field every ~500ms (debounced) with the accumulated text. The row is the "what's already happened" record for reconnecting clients. UPDATE granularity is coarser than Broadcast publish granularity; it's a checkpointing rate.
4. **Publish each event** to the stream Broadcast channel per the buffering rules in 2.6.
5. **On `tool_call_request`:** fan out `performToolCall(...)` in parallel for that round's calls. Each emits a `tool_call_response` to the channel as it lands. Responses may interleave with subsequent text events; client joins by `tool_call_id`.
6. **On `DONE`** with tool calls: write tool-result rows, transition intermediate assistant row's status (still `streaming` until terminal), append tool rows to history baton, loop to next round.
7. **Terminal round (no tool calls):** call `commit_assistant_message` RPC (a `SECURITY DEFINER` variant) with the assistant row id and anchor `userMessageId`. RPC does `FOR UPDATE` + `created_at > anchor` conflict check and atomically transitions `status` to `'complete'`. Emit `END {terminalKind: 'completed', persistedAssistantId, conflict}` on stream channel. Unsubscribe from control. Done.

**Special case (`ask_user`):** tool returns the pending sentinel. `getStreamingResponse` writes the tool-result row carrying the pending payload, transitions assistant row `status='suspended_for_ask_user'`, emits `END {terminalKind: 'suspended_for_ask_user', persistedAssistantId}`, unsubscribes from control, exits. Browser renders AskUserCard from the pending sentinel; on answer, the existing UI path UPDATEs the tool-result row and triggers a fresh `/stream` invocation with the post-answer history.

**Background lifecycle:** `getStreamingResponse` runs via `EdgeRuntime.waitUntil(promise)` after the HTTP envelope response returns. Supabase's Deno runtime supports `waitUntil` for post-response work, with the 400s wall timeout still applying. If wall timeout is approached mid-completion: function persists partial content with `status='error'`, emits `END {terminalKind: 'error', message: 'wall timeout'}`, exits.

**Function crash mid-stream:** browser doesn't get any signal until it reconnects. On reconnect: client sees a `status='streaming'` assistant row whose `updated_at` is stale (>30s, say). Render a "this response failed mid-way" affordance with a retry button. v1 eats it. v2 might add a heartbeat column + janitor that transitions stale `streaming` rows to `error`.

### 2.9 Reconnect / resume

Client opens the thread (any path - app launch, navigate-to-thread, foreground-after-background):

1. Browser loads messages via existing flow.
2. For each `status='streaming'` row encountered: render `content` as the completed-so-far state immediately.
3. POST `/stream` with `userMessageId = the streaming row's anchor` and `reconnectOnly: true`. Function detects the existing in-flight stream (by `messages.status='streaming'` + matching anchor) and returns `{channelName, assistantRowId, completedSoFar: row.content}` from current state. NO new completion starts.
4. Browser subscribes to `channelName`. Subscribe-then-read pattern: after subscribing, browser re-reads `row.content` to catch any UPDATE that landed between steps 2 and 4. From that point, future events on the channel append to `completedSoFar`.
5. If subscription returns no events within 30s AND row's `updated_at` doesn't tick: assume stuck/crashed; show retry affordance.

Same flow for cross-device ape mode (section 3) - device B uses the same reconnect path.

### 2.10 Client terminal handling

Browser's Broadcast subscriber sees `END {terminalKind}`:

- `completed` -> flush throttled buffers, set `slot.sending = false`, drop streaming buffers, unsubscribe from channel. Messages-subscription postgres_changes feed already materialized the final assistant row.
- `aborted` -> same, plus show the interrupted-marker UI affordance.
- `suspended_for_ask_user` -> render AskUserCard from the now-persisted tool-result row's pending sentinel.
- `error` -> set `slot.streamingError`, show the existing error card.

Browser does NOT do an explicit "read the assistant row" fetch on END. The messages subscription handles it via postgres_changes. Broadcast channel is the source of truth for "streaming is happening"; the messages table is the source of truth for "message exists in this state."

## 3. Cross-device "ape mode" (now in v1, free)

The original v2 design (function tees chunks to a Broadcast channel; device B subscribes to ape device A's stream) is structurally identical to the reconnect case. v1 ships ape mode at no additional cost:

- Device A POSTs `/stream`, starts a turn, gets `{channelName, assistantRowId}`. Device A subscribes.
- Device B opens the same thread. Sees `status='streaming'` row. POSTs `/stream` with `reconnectOnly: true` -> reconnect path returns the same `{channelName, assistantRowId, completedSoFar}`. Device B subscribes.
- Function publishes to channel; both devices receive events.

Multi-subscriber on the Broadcast channel is the default. No new mechanism needed.

**The race-loser UI (user's "red-border-then-fade-out"):**

Different problem from streaming; both devices try to send a NEW user message concurrently. Function picks one winner by server-side `created_at`; the loser's `/stream` POST returns a conflict envelope and the loser device animates a red-border fade then subscribes to the winner's channel as an ape consumer. Correctness is automatic without UI work, but the loser UX is confusing until the polish lands.

Full design in [`cross-device-race-ui.md`](./cross-device-race-ui.md). Ships as a v1+ follow-up after streaming-root stabilizes.

## Open questions / tradeoffs

- **Browser-only tools in a server-side loop.** Resolved. Audit of `src/lib/tools/*.ts`: zero tools touch browser globals (window, document, localStorage, indexedDB, FileReader, HTMLElement). One special case: `ask_user` returns a pending sentinel handled via `END {terminalKind: 'suspended_for_ask_user'}`.
- **Future "get-next-response" portability.** Resolved. Background audit confirmed every contributor to the assembled `VeniceMessage[]` is server-portable. No hard blockers.
- **Wire-shape duplication.** Resolved: shared `supabase/functions/_shared/venice.ts` module imported from both Deno (the function) and the browser bundle (Vite). Lives the event-stream parser, the typed event union, `VeniceError`, the tool-call fragment assembler, and the SSE encoder.
- **Composition shape.** Resolved: three modules inside the same `supabase/functions/venice/` deployment, composed by direct async function call.
- **Transport.** Resolved: Realtime Broadcast for live events, HTTP envelope for handshake, in-flight assistant row UPDATEs for resume state. Streaming HTTP response model rejected as incompatible with the client-disconnect-survival design goal.
- **Auth (b-strict for streaming).** Resolved. The hybrid model from an earlier round doesn't work when the function outlives the JWT.
- **Cancel mechanism.** Resolved. Special event on a `thread:{threadId}:control` Broadcast channel, function subscribes alongside its outbound publish channel.
- **Adaptive buffering.** Resolved. 4-tier 50/100/250/500ms windows; reactive backoff on 429; text deltas buffered, everything else prompt.
- **150s edge function idle timeout.** Not applicable to the Broadcast model. The HTTP envelope response completes quickly; `EdgeRuntime.waitUntil()` runs to the 400s wall timeout.
- **Function crash mid-stream.** v1 eats it - stuck `status='streaming'` rows show a "response failed" affordance to the user on reconnect. v2 might add heartbeat + janitor.
- **Cost accounting.** Existing `/complete` route uses the shared Venice key from `app_config`; `/stream` does the same.
- **Race-loser red-border-fade UI for competing user messages.** Detection mechanics at implementation time; UI affordance is the v1+ extension.
- **Reconnect race in step 4 of 2.9.** Subscribe-then-re-read protects against the obvious race (UPDATE lands between initial read and subscription). Verify at implementation that supabase-js Broadcast subscriptions don't miss events fired between connection-open and `.subscribe()` callback.

## File-by-file change inventory

- **supabase/functions/venice/index.ts** - add `/stream` POST route. Thin handler: validates body, builds `ToolContext`, checks for existing in-flight stream (reconnect path: matching `assistantRowId` + `status='streaming'` + anchor), or kicks off a fresh `getStreamingResponse` via `EdgeRuntime.waitUntil()`. Returns `{channelName, assistantRowId, completedSoFar}` immediately.
- **supabase/functions/venice/getStreamingResponse.ts** - new. Round-loop orchestrator. Owns: assistant row create/UPDATE/terminal commit, Broadcast publishing with adaptive backpressure, control channel subscription for cancel, `EdgeRuntime.waitUntil()` lifecycle, tool fan-out via `performToolCall`.
- **supabase/functions/venice/getStreamingCompletion.ts** - new. Venice SSE consumer + normalizer. Hosts `pending: Map` fragment-assembler, rate-limit retry, output-guards wrapper.
- **supabase/functions/venice/performToolCall.ts** - new. Single tool dispatch. The Deno port of the browser-side `dispatchTools` shape from chat-loop.ts.
- **supabase/functions/venice/broadcast.ts** - new. Adaptive-buffering publish helper with reactive 429 backoff.
- **supabase/functions/_shared/venice.ts** - extend with typed event union, SSE line parser, `VeniceError`, fragment assembler. Imported by all three new modules and by the browser via Vite.
- **supabase/schema.sql** - add `messages.status` enum column: `'streaming' | 'complete' | 'aborted' | 'error' | 'suspended_for_ask_user'`. New `commit_assistant_message` RPC (SECURITY DEFINER variant of `add_assistant_message`) that does the conflict check + status transition atomically. Realtime Broadcast channel access policies for `thread:{threadId}:stream` (server publish, owner subscribe) and `thread:{threadId}:control` (owner publish, server subscribe).
- **src/lib/venice.ts** - `streamChat` rewritten as a thin wrapper that POSTs to `/stream`, subscribes to the returned channel, and exposes the union event stream as an async iterator (matching today's API). Internal handshake reads `completedSoFar` once before subscribing. The Venice-direct path is deleted; `VeniceClient` no longer needs the Venice API key. Typed event union and `VeniceError` move into `_shared/venice.ts`.
- **src/lib/chat-loop.ts** - `runChatLoop` collapses. Round loop, tool dispatch, retry wrapper, guards wrapper all move to the function. What remains: slot state updates, abort wiring (now: explicit cancel publish to control channel, not fetch cancellation), realtime row reconciliation, throttled UI flushes.
- **src/screens/Chat.svelte** - `runExchange` simpler. New event handlers for `tool_call_response`, `END {terminalKind}`, the adaptive-tier liveness events. Stop button publishes `{type: 'cancel'}` to control channel. Reconnect path on thread-open for `status='streaming'` rows.
- **src/lib/state.svelte.ts** - `VeniceClient` instantiation stays for any remaining direct Venice consumers. Venice API key no longer needs to be carried client-side. Mark `VITE_VENICE_API_KEY` env wiring for deletion.
- **tests/venice.test.ts** - rewrite the streaming describe block. Mock target shifts to `/stream` route + Broadcast channel. Test: envelope shape, channel subscription, event ordering, adaptive tier transitions, cancel flow, reconnect/resume, ask_user suspend.
- **tests/chat-loop.test.ts** - browser-side `runChatLoop` shrinks; tests shrink with it. Round-body + retry + guards tests move to function-side test files.
- **docs/dev/in-progress/venice-edge-functions/streaming-root.md** - this document.
- **docs/dev/in-progress/venice-edge-functions/chat-completions.md** - update "Target state" to reflect the dual-sink resolution + Broadcast transport choice.
- **docs/dev/in-progress/venice-edge-functions/migration-inventory.md** - update `streamChat` row.
- **docs/dev/exchange.md** - update Interactions: Exchange now drives a stream subscription and a control-channel publish rather than consuming a local `streamChat` directly.
- **docs/dev/chat-loop.md** (if it exists, or create) - document the new split: orchestration browser-side, round body + tool dispatch + persistence server-side across the three modules.
- **docs/dev/edge-function-auth.md** - new. Covers the strict client model end-to-end, the `// RLS OFF: filter by userId` discipline, the JWT-expiry path, and a checklist for adding new DB access from any edge function.

## v1 cut line

**v1 ships:** HTTP envelope + Broadcast + in-flight row architecture; three composable modules in one Deno deployment; server-side round loop with rate-limit retry, output guards, full toolbox dispatch (audit confirms zero browser-only tools); `ask_user` suspend-and-resume via `END {terminalKind: 'suspended_for_ask_user'}`; adaptive 4-tier buffering with reactive 429 backoff; cancel via control-channel event; reconnect/resume via row-state + channel resubscribe; shared `_shared/venice.ts` between function and browser; Venice API key removed from client bundle; **mobile-PWA backgrounding survival**; cross-device ape mode (free side effect).

**v1 excludes:** server-side `ThreadClaimCoordinator` (driver-A milestone, separate); function-crash heartbeat + janitor (v2; v1 shows "response failed" affordance on stale `streaming` rows); race-loser red-border-fade UI for competing user messages (correctness is automatic; UI affordance is v1+); splitting modules into separately-deployed Edge Functions (door open via `_shared/`).

The v1 cut delivers the load-bearing win: **mobile PWA users no longer lose responses to backgrounding**, the assistant row records the work even when no client is connected, and reconnect-and-resume is the same code path as same-device-reload.
