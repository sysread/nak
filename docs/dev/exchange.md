# Exchange (per-thread streaming + cross-device claim)

The state machine for one logical chat turn, lifted out of
`Chat.svelte` into its own module so it can be keyed per-thread
and coordinated across devices. Three pieces: `ExchangeSlot` (the
state container for one turn), `ExchangeStore` (per-thread map of
slots), `ThreadClaimCoordinator` (cross-device "this device is
producing the response" claim).

## Role in the app

A chat turn used to be a single global flag (`sending = true`)
plus a handful of streaming buffers (`streamingText`,
`streamingReasoning`, `abortCtl`, `toolTimings`, ...) sitting at
the screen level. That worked under the implicit "one turn at a
time" assumption but broke any time the user navigated mid-stream:
the throbber, the streaming text, and the persisted assistant row
would all project onto whichever thread the user was viewing,
even when that thread had nothing to do with the in-flight
request.

The exchange module replaces that with one slot per thread.
`Chat.svelte` reads through `activeSlot` (the slot for the active
thread, or null) and writes through `runExchange` (which resolves
the slot from `ctx.threadId`). A thread the user navigates away
from keeps its slot running in the background; switching back to
it picks up the in-progress text where the buffer is at the moment
of the switch.

Layered on top of the per-thread slot is the cross-device claim.
Each thread row carries `response_holder_id` and
`response_claim_expires_at` columns. The device responding to a
turn acquires the claim at `runExchange` entry, heartbeats it
every 20s, and releases it in `finally`. Observer devices see the
claim through the existing threads realtime subscription and
disable their composer + render a "responding on another device"
indicator until the claim clears.

## Files

- `src/lib/exchange/exchange-slot.svelte.ts` — `ExchangeSlot`:
  the state container for one turn. Public `$state`-backed
  fields for everything the template binds to (`sending`,
  `streamingText`, `streamingReasoning`, `streamingError`,
  `rateLimitWaitUntil`, `abortCtl`, `toolTimings`), plus plain
  fields for internals the template never reads
  (`streamingContentStarted`, `persistedRows`, `abortReason`).
  Methods: `reset()` (idle defaults), `recordPersistedRow(msg)`
  (id-deduped append into the persisted buffer),
  `finalizePendingToolTimings()` (orphan-marker stamp on tool
  pills that never got an `endedAt`).
- `src/lib/exchange/exchange-store.svelte.ts` — `ExchangeStore`:
  the per-thread map. Internal storage is `SvelteMap`, not a
  plain `Map` under `$state` (see Gotchas). Surface:
  - `slotFor(threadId)` get-or-create.
  - `peek(threadId)` get-without-create. Used by the screen-level
    `activeSlot` derivation so opening a thread we've never sent
    on doesn't allocate a slot.
  - `slots()` iterator. Used by the wake-lock and orphan-cleanup
    sweeps.
  - `dispose(threadId)` / `disposeAll()` — abort any in-flight
    controller, remove the slot. `disposeAll` is called on
    sign-out.
- `src/lib/exchange/exchange-store.svelte.ts::mergeMessagesById`
  — pure helper used by `selectThread` and the safety-net
  reconcile effect. Folds a buffered-rows list into a
  listMessages snapshot, de-duping by id and ordering by
  `created_at` ascending. Handles the race where
  `onAssistantPersisted` fires during the await between
  `messages = []` and `messages = fetched`.
- `src/lib/exchange/thread-claim-coordinator.ts` —
  `ThreadClaimCoordinator`: wraps the three Supabase claim RPCs
  (`acquire_thread_response_claim`,
  `heartbeat_thread_response_claim`,
  `release_thread_response_claim`) plus the heartbeat interval.
  Heartbeat-coordinator shape: `onLost`-on-decisive-false
  semantics, swallow-thrown-errors posture. Claims are per-row,
  keyed by `threadId` (not a user-level singleton - the retired
  browser worker fleet's `LeaseCoordinator` was the singleton
  variant of this pattern).
- `supabase/schema.sql` (section "Thread response claim") —
  the two columns on `threads`, the partial index on the
  expiry column, and the three security-invoker RPCs.
- `src/screens/Chat.svelte` — consumer. Allocates one
  `ExchangeStore` and one per-tab `holderId` at screen mount;
  reads `activeSlot` and `respondingElsewhere`; routes the
  send / stop / claim wiring through them.

## Entry points

- **`send()` in `Chat.svelte`** — synchronous guard layer:
  - Per-thread: if the active thread already has a slot with
    `sending = true`, refuse the click.
  - Screen-level: `sendSetupInFlight` flag protects the
    pre-`runExchange` window where the threadId isn't known yet
    (no active thread, or an unmaterialized draft). A `claimedSlot`
    variable tracked through the body lets the `finally` clear
    `sending = true` if a pre-`runExchange` await throws - the
    slot doesn't get stuck and block every future send to this
    thread.

- **`runExchange(ctx)` in `Chat.svelte`** — the heavy lifecycle:
  - Resolve the slot: `slot = exchangeStore.slotFor(ctx.threadId)`.
  - `slot.reset()` then `slot.sending = true`, `slot.abortCtl =
    new AbortController()`.
  - Acquire the cross-device claim via a fresh
    `ThreadClaimCoordinator`. A false return (another device
    holds a live claim) bails out with an inline error and
    leaves `sending = false`. A thrown error (RPC network
    failure) surfaces a softer "couldn't check
    responding-device status" message.
  - On acquire, `claim.startHeartbeat(...)` arms the 20s
    interval inside the coordinator. The `onLost` callback
    stamps `slot.abortReason = 'claim'` and aborts the
    in-flight controller; the catch later renders a
    "preempted" banner instead of the silent-stop the
    user-initiated abort path uses.
  - Streaming handlers (in the `runChatLoop` call's `handlers`
    bundle) write to `slot.X` fields. Two persisted-row
    handlers do **double duty**: always
    `slot.recordPersistedRow(msg)` (so the buffer captures
    every row), but only `appendMessage(msg)` when
    `ctx.threadId === activeThreadId` (so the active view's
    `messages` updates immediately). Background threads' rows
    accumulate in the slot's buffer.
  - `finally`: `claim.release()` first, then
    `slot.finalizePendingToolTimings()`,
    `slot.sending = false`, `slot.abortCtl = null`. Wake lock
    is released only when no other slot is still streaming.

- **`selectThread(id)` in `Chat.svelte`** — does NOT touch
  streaming state (per-slot now). Loads via
  `messages = mergeMessagesById(fetched, slot.persistedRows)`
  so rows the slot persisted during the await window fold
  back in.

- **Stop button / submit-modifier Enter** —
  `activeSlot?.abortCtl?.abort()`. No `slot.abortReason` write,
  so the catch sees `abortReason === null` and silently clears
  the streaming error (the user knows what they did).

- **Heartbeat-lost (cross-device preemption)** — the
  `ThreadClaimCoordinator`'s `onLost` callback stamps
  `slot.abortReason = 'claim'` then `abort()`s. The catch
  reads the reason and renders "Another device took over this
  conversation. Refresh to see the latest." with no retry
  closure (the right move is to refresh, not re-fire).

## Data model

### ExchangeSlot fields

| Field | Reactive | Purpose |
| --- | --- | --- |
| `sending` | yes | Gates streaming bubble, composer's stop-mode, autoscroll, orphan-timing finalizer |
| `reconnecting` | yes | True while re-attaching to a turn that was in flight when the tab last had it (`reconnectInflightTurn` polls the row to a terminal state instead of resuming the live stream). `sending` is also true; this only re-labels the throbber "Reconnecting" vs "Thinking". See `chat.md` reconnect gotcha. |
| `streamingText` | yes | Throttled `delta.content` buffer (~500ms flush) |
| `streamingReasoning` | yes | Throttled `delta.reasoning_content` buffer |
| `streamingReasoningOpen` | yes | Reasoning panel slide-open state |
| `streamingContentStarted` | no | Sticky guard: first content delta of the round |
| `streamingError` | yes | Inline error bubble + retry closure (rate-limit only) |
| `rateLimitWaitUntil` | yes | 429 wait window's wake time |
| `rateLimitAttempt` | yes | 429 attempt counter for the bubble's "attempt N" label |
| `abortCtl` | yes | AbortController for stream + tool fetches |
| `toolTimings` | yes | Per-tool-call timing pills |
| `persistedRows` | no | Buffer of every persisted row this exchange produced, consumed by `mergeMessagesById` on thread switch |
| `abortReason` | no | `'user' \| 'claim' \| null`, read by the catch to distinguish stop-from-user from preempted-by-claim |

### Thread response claim columns

```sql
alter table public.threads
  add column response_holder_id        text;        -- null when idle
alter table public.threads
  add column response_claim_expires_at timestamptz; -- TTL stamp; > now() => live
```

The `(threadId, holderId)` pair on `acquire_thread_response_claim`
is atomic: the update only lands when the row is unclaimed, ours
already (refresh), or carrying an expired claim. Partial index
`threads_response_claim_idx` keeps lookups cheap under the steady
state of zero live claims.

### Per-device `holderId`

`Chat.svelte` resolves the `holderId` at screen mount via
`resolveHolderId()` in `src/lib/exchange/holder-id.ts`: a single UUID
stamped into `localStorage` (`nak:holder:id`) on first visit and reused
on every later mount. `localStorage` survives page refresh, app-update
reload, and browser restart on every platform we target.

The stable id exists because of a refresh-during-completion bug. The
original per-mount `crypto.randomUUID()` left the post-refresh page
minting a brand-new holderId, which then saw its OWN stale claim on the
`threads` row as "another device is responding" - the
`respondingElsewhere` derivation rendered a spurious "Responding on
another device" Scanner bubble, and the user's retry click hit the
acquire RPC's not-our-holder branch and failed with the same message
for the full 60s TTL. A stable id makes `acquire_thread_response_claim`
take its same-holder branch (the `response_holder_id = p_holder_id`
clause in `supabase/schema.sql`) and refresh the expiry, so the retry
resumes the turn and no spurious bubble appears.

**Why `localStorage`, not `sessionStorage`.** A first attempt scoped
the id per-tab as `${browserId}:${tabSeq}` with `tabSeq` in
`sessionStorage` to keep two tabs distinguishable. That broke in
installed PWAs: `sessionStorage` was observed to NOT survive a reload
(reproduced on an Android Chrome PWA install), so the `tabSeq`
regenerated on refresh and reintroduced the exact stale-claim bug.
`localStorage` is durable across reloads everywhere, so the
device-level id is the robust unit - and "device" is
also the right granularity for the cross-device guard the claim provides
(`respondingElsewhere` should fire for a different browser/device, which
a per-profile `localStorage` UUID identifies exactly).

Known edges:

- **Two tabs of the same browser** now share the id, so they no longer
  recognise each other as separate holders. Two tabs streaming the same
  thread at once both pass the same-holder acquire and race to commit;
  the atomic message-commit RPC dedupes assistant rows on
  user-message-id, so the worst case is one wasted completion. Accepted:
  this is the rare case, refresh-during-response is the common one, and
  the BroadcastChannel collision check that would close the corner isn't
  worth the complexity.
- **New browser profile / cache clear** starts with empty `localStorage`
  and mints a fresh id - correctly a distinct holder.
- **Storage unavailable** (sandboxed iframe, disabled cookies,
  private-mode quirk that throws on read) falls back to a per-mount
  random id, regressing to the refresh-loses-claim behaviour only in
  that environment.

A signed-out tab's holder identity is irrelevant - `disposeAll()`
aborts any in-flight exchange before the next sign-in.

### Retry affordances suppressed under `respondingElsewhere`

The `incompleteTurnTail` derivation and the orphaned-draft
(`interruptedDraft`) source both return / render nothing while
`respondingElsewhere` is true - and also while the thread's
server-side in-flight stamp (`threads.stream_started_at`, written by
the /stream orchestrator at turn entry and cleared at terminal) is
fresh per `streamLikelyInFlight` (`src/lib/ui/stream-inflight.ts`).
The stamp covers the same-device-reload case the claim cannot: after
a refresh the claim is held by OUR OWN holderId (so
`respondingElsewhere` is false), yet the turn is still running under
the edge function's waitUntil, and during its priming stage no
streaming assistant row exists for the reconnect to key on. Without
the stamp gate that window rendered retry banners for a live turn. A foreign device holding a live claim is
actively producing the reply, so a transcript that ends on a user row
only LOOKS incomplete from the observer side - the assistant row arrives
over realtime. Offering retry there invites a competing turn the claim
exists to prevent (and whose acquire would just fail with "another
device is responding"). The observer Scanner bubble covers the wait
instead.

### One recovery banner, not three (`selectRecoveryBanner`)

The transcript tail can satisfy several "this turn did not finish, want
to retry?" conditions at once. The most visible overlap: a session that
died with a persisted user row AND a leftover IndexedDB streaming draft
trips both `incompleteTurnTail` (generic cut-off tail) and
`interruptedDraft` (recoverable draft), so the tail rendered two
near-identical retry boxes stacked. A third, parallel surface -
`displayedError` (session `streamingError` or persisted
`thread.last_error`) - is the danger-tinted alert.

`src/lib/ui/recovery-banner.ts` (`selectRecoveryBanner`) collapses these
to a single banner by precedence: **error > interrupted-draft >
cut-off**. `Chat.svelte` binds each source's retry/dismiss closures
(gating the recovery sources on `respondingElsewhere` / `sending` as
above) and renders the one descriptor the selector returns. The `error`
variant keeps the `.msg-error` styling (icon, optional kind heading,
pre-wrap body); the `incomplete` variant is the muted `.msg-incomplete`
note. `dismiss` renders only when the source offers one - error cards and
the recoverable draft, never the generic cut-off tail. Precedence and the
banner copy live in the helper because they are framework-agnostic; the
component owns only the markup and the runes that feed it.

## Contracts

### Slot lifecycle

A slot persists in the store after its exchange finishes - the
fields return to idle values via the `runExchange` cleanup, and the
slot is ready for the next send on the same thread. `slot.reset()`
at the start of each `runExchange` clears `persistedRows` so a
re-run starts with a clean buffer.

### appendMessage vs recordPersistedRow

| Caller | Target | Active-thread guard |
| --- | --- | --- |
| `onAssistantPersisted` | `slot.recordPersistedRow(msg)` | always |
| `onAssistantPersisted` | `appendMessage(msg)` | only when `ctx.threadId === activeThreadId` |
| `onToolResultPersisted` | same as above | same as above |
| Realtime `subscribeToMessages` echo | `appendMessage(msg)` | only on the active thread (subscription is keyed on it) |

`appendMessage` de-dupes by `id`, so the realtime echo for our
own writes is a no-op.

### Claim acquire / heartbeat / release

- **`acquire()`** returns `false` when another holder has a live
  claim, `true` when we hold it. RPC errors are propagated to the
  caller (the chat-loop wraps them in an inline streaming error).
- **`startHeartbeat(onLost)`** arms a `setInterval` at
  `heartbeatMs`. The interval callback calls `beatOnce(onLost)`,
  which calls `heartbeatThreadResponseClaim`; a false return is a
  decisive loss (another device took over) and fires `onLost`.
  Thrown errors are swallowed - the server-side TTL is the real
  authority and one missed beat under the 60s/20s ratio is well
  within margin.
- **`release()`** swallows RPC errors. Runs in `runExchange`'s
  finally, where throwing would corrupt the cleanup sequence; the
  server-side TTL will sweep a non-released claim eventually
  anyway.

### `mergeMessagesById(fetched, buffered): Message[]`

Pure helper. Returns a fresh array de-duped by `id`, ordered by
`created_at` ascending. The `fetched` snapshot wins on duplicates
(canonical state from the DB). Fast path for `buffered.length === 0`.
Equal `created_at` ties break by `id` so the order is
deterministic.

## Interactions

- **Chat loop (`src/lib/chat/loop.ts`)** — owns the actual
  streaming + tool execution. The exchange module is the screen's
  state container; the chat loop is the producer. Every
  `handlers.X` callback in the `runChatLoop` call writes through
  the slot.
- **Supabase realtime** — `subscribeToMessages(activeThreadId)`
  feeds `appendMessage` for cross-device row arrivals.
  `subscribeToThreads(userId)` updates the threads row used by the
  `respondingElsewhere` derivation when another device acquires or
  heartbeats a claim.
- **`mergeMessagesById`** is also used by the
  post-claim-release safety-net effect in `Chat.svelte` -
  realtime can drop packets under load, so a foreign-claim
  transition to released triggers a `listMessages` reconcile.
- **Draft store (`src/lib/draft-store.ts`)** — `runExchange`
  writes through `updateDraftText` every flush so a crash
  mid-stream leaves a recoverable IDB record. `selectThread`
  reads `loadDraft` to detect orphans, but the read is now
  gated on `!exchangeStore.peek(id)?.sending` so a thread the
  user navigated away from mid-stream isn't flagged as orphaned
  on the return trip.
- **Notifications (`src/lib/notifications.svelte.ts`)** —
  `notifyTurnComplete` / `notifyAskUser` receive
  `isActive: activeThreadId === ctx.threadId` so a background
  exchange completing on a non-active thread fires an OS
  notification or unread dot, while completion on the active
  thread is silent (the user is already looking at it).
- **Wake lock** — held while any slot is sending. The
  `anySlotSending` derivation reads
  `exchangeStore.slots().some(s => s.sending)`; the `finally`
  releases the lock only when no other slot still holds it.

## Gotchas

### SvelteMap, not `$state(new Map())`

Svelte 5's `$state` deep-proxies plain objects and arrays. Built-in
collections (Map, Set, Date, URL) need their explicit reactive
wrappers from `svelte/reactivity`. `ExchangeStore`'s internal map
**must** be a `SvelteMap` or `$derived` consumers of `peek` /
`slotFor` will silently miss slot allocations - reads through a
plain Map under `$state` don't subscribe the tracking context.

The user-visible symptom of regressing this: the streaming bubble
never appears (gated on `activeSlot?.sending`, which reads as
undefined when the derived can't see the slot), and the
"incomplete turn" banner appears under the user message during
the exchange (suppressed by the same condition). The
`tests/exchange-store.test.ts` regression test asserts the
internal map is a `SvelteMap` instance specifically to catch any
future "simplification" back to a plain Map.

### `slot.reset()` flips sending false then true

`runExchange`'s entry does `slot.reset()` (which sets
`sending = false`) and then `slot.sending = true` on the next line.
Svelte batches reactive updates within a synchronous block, so
the template never observes the intermediate `false`. Don't break
this by adding an `await` between the two lines.

### Claim TTL vs heartbeat

60s TTL with a 20s heartbeat gives three attempts per expiry
window. Looser than `worker_leases` (45s / 20s) because chat
turns legitimately run longer than background agents on slow
models. A crashed device frees its claim within 60s; the
observer-side `claimNowTick` effect re-evaluates
`respondingElsewhere` every 5s so the TTL-expired transition
shows up locally even when no realtime event arrives.

### Acquire vs release vs sign-out ordering

`disposeAll()` (called on sign-out) aborts in-flight controllers
but does NOT call `claim.release()` directly. The chat-loop's
abort handler unwinds normally and the `runExchange` finally
runs `claim.release()` - which swallows the RPC error that might
happen against a now-invalidated session. Server-side TTL still
sweeps within 60s.

### `respondingElsewhere` and our own claim

The derivation explicitly excludes `t.response_holder_id === holderId`.
Without that guard, the brief window after our own `acquire()`
returns and the realtime echo lands would flag us as "responding
elsewhere", disabling our own composer mid-turn.

### Per-thread send guard semantics

The `if (existingSlot?.sending) return;` guard at the top of
`send()` blocks per-thread, not globally. A user on thread A
which is mid-stream can switch to thread B and send there - both
exchanges run in parallel against their own slots. Phase 2 of
the refactor (see `docs/dev/planned-changes.md` for the original
plan history if needed) intentionally removed the global
serialization.

### Orphan-draft banner

`selectThread`'s orphan check (`loadDraft` for a thread whose
last message is a user row) used to be unconditional. Phase 2
made it possible for our own `runExchange` to be actively writing
to that draft right now, so the check is gated on
`!exchangeStore.peek(id)?.sending`. Without that gate, the
"Previous response was interrupted" banner appears under the
user message during the response, then gets pushed to the bottom
as the assistant card materialises. Cross-device case is
naturally protected: drafts are local-only.
