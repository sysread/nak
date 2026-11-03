# Realtime Delivery Fixes Plan

Status: IMPLEMENTED 2026-11-03 (branch realtime-delivery-fixes,
rebased on ce0926d9; M1-M7 commits a1f63640, 5aee1802, 58d2afc8,
411ad6ff, ac18a2cb, 14bd76a4, af07f32a; QA M0 baseline + M8 post-
change rows in chat-streaming-turn.md, chat-generated-image-card.md,
chat-regenerate-from-here.md, settings-image-model-picker.md - the
M8 runs show the observer tab reaching full transcript parity via the
cross-tab backstop and image cards landing live on the sender, both
previously broken). The text below is the as-proposed record; the
implementation matched it with no design deltas. Session context:
bug-intake dispatched fix session (realtime-delivery-fixes worktree;
base moved to origin/main
ce0926d9 per the coordinator's base-drift instruction - the drift's
diff on this plan's surface is comment-only and line-count-neutral
in Chat.svelte, plus the image-tool consolidation in
generated-image.ts / message-blocks.ts / the function-side tools
directory, none of which touches a cited line range; the image tool
is now ONE `image` combination tool with an `op` parameter, not four
separate tools - rider (b)'s recipe is updated accordingly).
Owner: the fix session; reviewer/coordinator:
guard-5-00021.

## SYNOPSIS

Six changes, one defect and three riders:

1. **SUBSCRIBED-confirmed catch-up read on the messages channel.**
   `subscribeToMessages` gains an optional subscribe-status callback
   (the pattern the Broadcast stream channel already uses,
   `src/lib/chat/stream-transport.ts:338` and its status callback at
   `:596-623`, documented at `docs/dev/chat.md:910-914`). On
   `SUBSCRIBED` the caller runs one transcript reconcile. This closes
   the fetch-then-async-join race: any row inserted between the
   opening `listMessages` snapshot and the channel join is re-fetched
   after the join instead of landing in neither.
2. **Subscribe-failure visibility and a bounded resubscribe.** The
   same status callback logs `CHANNEL_ERROR` / `TIMED_OUT` at warn
   and schedules a resubscribe while the failure streak is fresh
   (one retry per CONSECUTIVE-failure streak, reset on a successful
   subscribe - see DECISIONS). Today a failed join is silent:
   `.subscribe()` is called with no callback
   (`src/lib/supabase/realtime.ts:162`).
3. **Cross-tab reconcile backstop on the threads UPDATE echo.** A
   foreign (or unclaimed) threads UPDATE for the ACTIVE thread
   schedules one trailing debounced reconcile (2s, hand-rolled - the
   house pattern; no shared debounce helper exists). This addresses
   the second-tab sighting (c) without trusting the unproven
   "threads channel works cross-tab" inference: whatever thread-level
   signal the second tab DID receive becomes a trigger to heal the
   message list.
4. **END-time transcript reconcile for own sends.** `runExchange`'s
   post-finally settled tail re-fetches the transcript for the active
   thread on every turn settle (normal sends and regenerates,
   fire-and-forget; errored settles included - the tail next to the
   queued-message drain is reached by every settle except the
   StreamDisconnectedError return, which `reconnectInflightTurn`'s
   own refetch covers). This is the writer-of-record backstop: the
   edge
   function is the only writer of tool rows and generated-image
   attachments (`docs/dev/architecture.md:423, 427`), so the sending
   tab stops depending on the realtime echo for rows the browser
   never writes.
5. **Remove the dead `onToolResultPersisted` wiring.** The handler
   member (`src/lib/chat/types.ts:52`) and its only consumer
   (`src/screens/Chat.svelte:4834-4839`) have zero producers (grep
   verified; `src/lib/chat/loop.ts` and `src/lib/chat/stream-events.ts`
   never call it). Fixes 1-4 subsume what it was meant to do. Git
   archaeology confirms drift, not a recorded decision: the producer
   was dropped in 305e5cab (2026-06-03, tool dispatch moved into the
   venice edge function) and the consumer was even re-wired against
   the dead contract a day later in 054012ed.
6. **Riders.** (a) The regenerate commit's `.regen-target` stickiness
   gets a diagnosis-then-fix. (b) The regenerate QA doc's tool-call
   precondition gets a reliable recipe. (c) The Settings AI pane's
   shared status line moves next to the image pickers and gains
   `aria-live`.

## PURPOSE

Live message-level delivery is deaf for rows the browser does not
write. A turn that calls tools or generates an image can finish with
the tool-result rows and image cards absent from the open transcript
until a reload. Three sightings (intake-verified against source at
07eca2c4, and re-verified in this session - see Premises):

- (a) Post-reload: turns in flight during the reload land deaf in the
  reloaded tab; a further reload recovers them.
- (b) Regenerate path, no reload: the regenerated turn's image card
  is absent live.
- (c) Sharpest: a second tab on the same thread received zero message
  rows for about four minutes while thread-level updates appeared. A
  hard reload recovered everything. The intake flags that this
  sighting's "threads channel works cross-tab" inference is unproven
  (the threads sidebar also refreshes on focus); our repro must
  distinguish realtime delivery from refetch-driven updates before
  leaning on it.

Four stacked gaps, all verified below:

1. **Fetch-then-async-join race with no post-subscribe re-sync.** The
   opening fetch (`src/screens/Chat.svelte:2781` in `selectThread`)
   and the channel join (the `$effect` at `src/screens/Chat.svelte:1993-2051`
   calling `subscribeToMessages`, whose `.subscribe()` at
   `src/lib/supabase/realtime.ts:162` completes asynchronously) run
   concurrently. A row inserted in the window is in neither result.
2. **The reconcile backstop excludes own turns.** `reconcileTranscript`
   (`src/screens/Chat.svelte:3078-3089`) has exactly two callers: the
   post-claim-release effect (`:3036-3051`), which fires only when a
   FOREIGN claim clears (guard at `:3047`; the comment at `:3032-3033`
   says "we have authoritative local state for our own turns" - false
   for tool rows, which the browser never writes), and the
   post-edit-commit site (`:5096`), which runs only on the
   destructive-edit branch.
3. **`onToolResultPersisted` is dead wiring.** Declared
   (`src/lib/chat/types.ts:52`), handled (`src/screens/Chat.svelte:4834-4839`),
   never produced - residue from the browser-dispatch era (git record:
   producer removed in 305e5cab, 2026-06-03; consumer re-wired against
   the dead contract in 054012ed, 2026-06-04).
4. **No END-time messages refetch on the normal send path.**
   `runExchange`'s success tail only refreshes threads
   (`src/screens/Chat.svelte:5181`). END hydration fetches only the
   single assistant row (`src/lib/chat/stream-events.ts:407-425`).

Constraint honored throughout: no fix depends on catching the
10-21ms Scanner image placeholder window (the server attaches
generated images before publishing the tool response).

## VERIFIED PREMISES

Every citation below was read and confirmed in this session at base
f0f19a58 (the evidence and round-2/3 review lenses independently
re-swept all of them; round-1 corrections are folded in), and
re-confirmed against origin/main ce0926d9 after the base drift: the
drift's diff on every cited file is either absent or comment-only
with 1:1 line replacement, so all line ranges hold at ce0926d9.

| # | Premise | Citation |
| --- | --- | --- |
| P1 | `subscribeToMessages` binds INSERT + UPDATE postgres_changes and calls `.subscribe()` with NO status callback | `src/lib/supabase/realtime.ts:93-171` (subscribe at :162) |
| P2 | The messages effect keys on `activeThreadId` + `activeThreadIsDraft` and dedups by id at the append site | `src/screens/Chat.svelte:1993-2051` |
| P3 | The opening transcript fetch is `listMessages` inside `selectThread`, concurrent with the subscription effect; `activeThreadId` is set before the fetch resolves | `src/screens/Chat.svelte:2695, 2781` |
| P4 | `reconcileTranscript` refetches and merges fetched rows with the slot's buffered rows by id; double thread-guard (entry :3080, post-await :3083) | `src/screens/Chat.svelte:3078-3089` |
| P5 | The post-claim-release reconcile fires only on foreign-claim clear; own-turn lifecycle is skipped by the guard | `src/screens/Chat.svelte:3036-3051` (guard :3047, comment :3032-3033) |
| P6 | The post-edit-commit reconcile runs only when `ctx.replaceUserMessageContent` is set (destructive-edit branch) | `src/screens/Chat.svelte:5095-5097` |
| P7 | `onToolResultPersisted` is declared and handled but has zero producers; exactly five references exist in `src/` | `src/lib/chat/types.ts:52`, `src/screens/Chat.svelte:4834-4839`, comment at `:2802`, `src/lib/exchange/exchange-store.svelte.ts:124`, `src/lib/exchange/exchange-slot.svelte.ts:84` |
| P8 | The tool_result broadcast event does NOT carry the row; its own comment names the messages realtime subscription as the row's only live feed | `src/lib/chat/stream-events.ts:188-198` |
| P9 | END hydration fetches only the assistant row (`getMessage`); no tool-row refetch exists on the send path | `src/lib/chat/stream-events.ts:407-425`; `src/lib/supabase/realtime.ts:183-194` |
| P10 | `runExchange`'s settled tail calls `await refreshThreads()` and no messages refetch; the cross-device claim releases in the finally (`:5341`) and the queued drain runs after it (`:5387`) | `src/screens/Chat.svelte:5181, 5341, 5387` |
| P11 | The edge function is the writer-of-record for `role='tool'` rows and generated-image attachments | `docs/dev/architecture.md:423, 427` |
| P12 | The Broadcast stream channel already uses a subscribe-status callback for disconnect handling, with first-SUBSCRIBED-only semantics and own-teardown CLOSED suppression (in-file precedent for fixes 1-2) | `src/lib/chat/stream-transport.ts:338, 595-623` (`setupStreamSubscription`; the plan's earlier `venice.ts` attribution was inherited from a stale pointer at `docs/dev/chat.md:910-911`, to be corrected in M6) |
| P13 | postgres_changes channels can take a unique topic per subscription; resubscribe is safe | `src/lib/supabase/realtime.ts:55-78` |
| P14 | A threads UPDATE echo reaches the browser per user-row insert (browser bumps `updated_at`) and per terminal commit (RPC bumps it); heartbeat refreshes do NOT bump it (direct column write); NO active trigger remains on `public.threads` (the last one, `clear_thread_embedding_on_change`, is retired by the drop statement) | `src/lib/supabase/messages.ts:552`; `supabase/schema.sql:13985-13993, 1646`; `supabase/functions/venice/getStreamingResponse.ts:404-408` |
| P15 | The paired-read pattern (point read covering a channel's join window) is the module's documented convention | `src/lib/supabase/realtime.ts:8-13`; `subscribeToInflightLease`/`getInflightLeaseExpiry` pair at `:306-361` |
| P16 | `.regen-target` is driven by `pendingDeleteSet` OR `hoverRegenerateSet` at three class sites | `src/screens/Chat.svelte:8246, 8333, 8383` |
| P17 | `.regen-target.fading-out` runs the fade animation | `src/styles.css:2676-2679` |
| P18 | Regenerate clears the hover set on click and the pending-delete set after prune (both tails) | `src/screens/Chat.svelte:5904-5908`, `:5085`, `:5109` |
| P19 | Settings AI pane: shared `modelInfo`/`modelError` render bare at the pane bottom, below the notifications toggle; the image pickers sit far above; the file's aria-live convention is `aria-live="polite"` on status lines | `src/screens/Settings.svelte:1997-1998` (status), `:1848-1872` (generation picker), `:1885-1909` (edit picker), `:1827`, `:2196`, `:2321` (convention) |
| P20 | `modelInfo`/`modelError` are a SHARED pane-wide pair: written by the image-gen pick, image-edit pick, name, location, emphasis toggle, notifications toggle + permission button, and timezone save; the intentions toggle has its OWN local pair and never writes the shared one | `src/screens/Settings.svelte:1348-1355, 1361-1368, 1380-1402, 1421-1430, 1444-1469, 1488-1497, 1561-1577` (shared writers); `:1406-1418, 1954-1955` (local intents pair) |
| P21 | The regenerate QA doc's precondition for a tool-calling turn ("ask something that triggers memory or web search") is the line judged unreliable on z-ai-glm-5-3-flash | `docs/qa/use-cases/chat-regenerate-from-here.md:33-34` |
| P22 | An existing unit test file covers `subscribeToMessages`; its fake channel DISCARDS the `.subscribe()` argument, so status-passthrough tests require extending the fake to record and invoke the callback | `tests/realtime-subscribe.test.ts:29, 57, 79` |
| P23 | `selectThread` strips the in-flight `status='streaming'` assistant row off the snapshot before merging so the streaming bubble does not double-paint; the echo handler filters the same shape | `src/screens/Chat.svelte:2792-2797, 2011` |
| P24 | The threads UPDATE echo lands only through `subscribeToThreads`' `onUpdate` callback (the effect at `:2069+`); implementing the backstop as a `$effect` reading `currentThread` would re-trigger on every thread-row replacement and tear the messages channel down (the churn trap documented at `:1974-1992`) | `src/screens/Chat.svelte:2069-2132, 1974-1992` |
| P25 | `reconcileTranscript`'s swap has a documented window (a row committing between snapshot and assignment drops until the next reconcile); the layered triggers make that acceptable | `src/screens/Chat.svelte:3068-3076` |
| P26 | `docs/dev/exchange.md` lists `onToolResultPersisted` in the handler table (doc sweep surface) | `docs/dev/exchange.md:349` |
| P27 | The Broadcast publish site strips image payloads from tool_response events because a single unstripped result is ~700KB of base64 - shipping full rows on the Broadcast channel is a non-starter | `supabase/functions/venice/getStreamingResponse.ts:1887-1915` |

## DECISIONS

Recorded so a future session does not re-litigate them.

- **Catch-up read at SUBSCRIBED, not per-tool fetch.** The intake's
  "fire a tool-result hook from `tool_call_response`" seam (fetch the
  row by `tool_call_id`) is REJECTED. The decisive reasons: it is
  sender-only by construction (the `thread:<id>:stream` Broadcast
  channel is joined only by the tab running the exchange, so a second
  observing tab never receives the event and sighting (c) is
  untouched); it is blind to the image card (the card resolves by
  filename from attachments, so a row fetch at response time drags in
  exactly the attach window the constraint forbids, P27); there is no
  SELECT-by-`tool_call_id` today (the only `tool_call_id` query is
  the ask_user UPDATE, `src/lib/supabase/messages.ts:574-590`); and
  the Broadcast channel has adaptive backpressure that drops events
  under budget pressure (`supabase/functions/venice/broadcast.ts:49`),
  so making row delivery depend on it is strictly worse than the
  replication stream plus reconciles. One reconcile after the join
  lands every row (tool rows, image cards, assistant rows) with the
  merge machinery P4 already trusts.
- **The dead handler is removed, not produced.** With fixes 1-4 in
  place, `onToolResultPersisted` stays dead. Deleting the member and
  the handler follows the dead-code hygiene rule (`CLAUDE.md` "Dead-code
  hygiene"); the stale comment reference at `src/screens/Chat.svelte:2802`
  is rewritten to name the real producer (`onAssistantPersisted`).
  Git history (archaeology lens) confirms the death was drift, not a
  recorded decision, so removal cannot contradict an intent record.
- **Own-turn reconcile is added at the settled tail; the foreign-claim
  guard stays as-is.** Relaxing the guard at `:3047` would fire a
  refetch on every own-claim release with no flush of what actually
  landed; the settled tail already knows the turn finished and can
  reconcile once, deliberately.
- **Resubscribe budget: one retry per consecutive-failure streak.**
  The retry decision is a pure function of `(status, attempts)`:
  `attempts` increments on every failure status and RESETS to 0 on
  `SUBSCRIBED`. A resubscribe fires only when `attempts` is 1 (i.e.
  the first failure of a streak); a second consecutive failure is
  logged at warn and left to the reconciles. This bounds the outage
  loop (a channel that repeatedly TIMED_OUTs never reaches SUBSCRIBED,
  so the churn stops after one retry) while a channel that
  successfully joined and later died gets one fresh retry. The
  counter is a component-scope (non-reactive) variable keyed to the
  thread it counts for: the effect resets it to 0 when it observes a
  different `threadId` (`if (threadId !== attemptsFor) { attempts = 0;
  attemptsFor = threadId; }`). It survives the tick re-run because it
  does not live in effect scope; a thread switch resets it through
  the keyed check, not through re-initialization.
- **Status-decision logic is extracted to a pure module.** The
  (status, attempts) -> action decision and the resubscribe counting
  live in a small pure module under `src/lib/chat/` (companion-test
  convention, `CLAUDE.md` frontend organization); the Chat.svelte
  effect wires it. This makes the M1 test promise real: no test can
  mount Chat.svelte (the repo's own test headers say why,
  `tests/reasoning-picker.test.ts:4`), but a pure module is pinned in
  a node-env test file.
- **The catch-up awaits any in-flight opening fetch.** `selectThread`
  sets `activeThreadId` before its `listMessages` resolves (P3), so a
  fast SUBSCRIBED could reconcile an older snapshot and lose to the
  opening fetch's later, staler assignment. The component keeps a
  per-thread map of in-flight `selectThread` fetch promises; the
  SUBSCRIBED catch-up awaits the map entry (when present) before
  reconciling. Each `selectThread` call registers its promise under
  the thread id and deletes the entry when it settles, so the map
  self-drains and holds at most one entry per concurrently-open
  fetch. Thread-open cost is two `listMessages` - accepted
  (single-user stack; the second fetch is the price of closing the
  race).
- **`reconcileTranscript` gains the streaming-row strip.** The catch-up
  fires on a thread possibly opened MID-TURN, where `listMessages`
  returns the in-flight `status='streaming'` assistant row; merging it
  bare would double-paint the answer (bubble + transcript row). The
  same strip `selectThread` applies (P23) moves into
  `reconcileTranscript` itself, so every caller is protected. The
  echo handler's filter (P23) is unchanged.
- **The END-time reconcile is fire-and-forget and unconditional on
  outcome.** Awaiting it would hold the cross-device claim and delay
  the queued-message drain by one round trip on every turn (P10);
  the merge is idempotent and the swap window self-heals (P25). It
  fires on `!conflictDetected`-independent grounds: any settle
  (completed, aborted, errored, suspended) refetches server truth
  for the active thread. The `StreamDisconnectedError` branch needs
  no coverage - `reconnectInflightTurn` refetches the full transcript
  itself.
- **The cross-tab backstop hooks the threads onUpdate callback, not
  an effect.** Per P24. Trigger rule: a threads UPDATE whose
  `id === activeThreadId` and whose `response_holder_id !== holderId`
  schedules the debounced reconcile. This covers foreign holders AND
  null holders (a bump that raced the claim); our own claimed-turn
  bumps (holder === mine) are skipped - they are covered by the
  END-time reconcile. Real trigger budget: heartbeat writes ARE row
  UPDATEs and DO echo (the filter is user_id-scoped, not column-scoped),
  so a foreign turn on the active thread triggers roughly once per
  15s heartbeat plus claim/stamp/clear/bump writes - a trailing
  debounce fires the reconcile about once per quiet 2s gap. That is
  bounded, idempotent, and beneficial: a foreign turn's rows are
  healed DURING the turn, not only at its end. Accepted redundancy:
  our own claim-RELEASE echo (holder -> null) fires the backstop once
  per own turn; the reconcile is idempotent and cheap.
- **Debounce is hand-rolled.** No shared debounce helper exists; six
  components hand-roll the setTimeout/clearTimeout pair (e.g.
  `src/components/MemoryList.svelte:42-62`). The backstop is a
  seventh; no new util for one consumer.
- **No schema change, no edge-function change.** All browser-side.
  The function already persists and publishes everything needed.

## STATE AND TRANSITION MATRIX

The messages channel's lifecycle (per thread-subscription site in
`src/screens/Chat.svelte:1993` - one effect; the attempts counter
outlives individual channel instances within it, keyed to the thread
id):

| State | Entered when | Exited when | Actions on entry |
| --- | --- | --- | --- |
| JOINING | effect run: `subscribeToMessages` called, no status ack yet | status callback fires with SUBSCRIBED, or a failure status | attempts unchanged (component-scope counter keyed to the thread id; the keyed check resets it to 0 on a thread switch, a tick re-run re-enters JOINING with the streak intact) |
| SUBSCRIBED | status `SUBSCRIBED` | teardown (thread switch / unmount) | attempts reset to 0; ONE catch-up reconcile (after awaiting any in-flight opening fetch); log at debug |
| RESUBSCRIBE_PENDING | failure status with attempts == 1 (first of a streak) | tick re-runs effect -> JOINING (new channel, fresh topic) | attempts incremented; log at warn |
| FAILED | failure status with attempts >= 2 (second consecutive) | teardown only | log at warn; transcript correctness rests on the reconciles (fixes 3-4) |
| removed | teardown: effect cleanup runs | - | `removeChannel` fire-and-forget (existing); pending debounce timers cleared |

Precedence rules:

- The catch-up reconcile fires at most once per SUBSCRIBED
  transition (a resubscribed channel is a genuine re-join after a
  dark period and gets its own catch-up - correct by design).
- Teardown cancels nothing in flight; the reconcile is
  thread-guarded (P4), so a thread switch mid-catch-up is a no-op by
  construction. A torn-down instance's late SUBSCRIBED may fire a
  stray catch-up that the guard discards - accepted (harmless extra
  fetch on fast thread switches).
- The cross-tab backstop (debounced foreign-threads-UPDATE reconcile)
  and the END-time own-send reconcile are independent triggers of the
  same `reconcileTranscript`; they never compose state, they only
  refetch-and-merge, which is idempotent by id (P4). Ordering against
  a regenerate's fade-out prune is safe because the backstop is a
  TRAILING debounce: it fires 2s after the last trigger, so a burst
  of echoes during the fade window settles before the reconcile runs;
  the prune branch itself completes (awaited) before the settled
  tail's own reconcile. (`holderId` is per-tab, so the user's own
  second tab counts as a foreign holder - claim exclusivity is NOT
  the safety argument here; the debounce is.)
- Echo delivery is never gated on subscribe state: the onMessage
  handler carries no state gating, so whatever events a channel in
  any state manages to deliver are processed (dedup handles the
  rest). Status handling changes visibility and recovery, not the
  event path.

## APPROACH

### Fixes 1 + 2: status callback, catch-up, failure handling

`src/lib/supabase/realtime.ts`:

- `subscribeToMessages` gains an optional third parameter
  `onStatus?: (status: 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED', err: unknown) => void`,
  passed straight through to `.subscribe()` (the exact shape the
  logs and samskara channels already use,
  `src/lib/supabase/realtime.ts:288-290, 723-725`).
- Docstring updated: the caller pairs the SUBSCRIBED ack with a
  catch-up read (P15 convention).

`src/lib/supabase.ts` (facade, `:1602-1607` region):

- The facade's `subscribeToMessages` delegation gains the same
  optional parameter (one-for-one typed signatures are the facade
  contract, `src/lib/supabase/realtime.ts:30-33`).

New pure module `src/lib/chat/realtime-recovery.ts`:

- `messagesSubscribeDecision(status, attempts): { action: 'catch-up' | 'resubscribe' | 'log-warn' | 'log-debug', nextAttempts: number }`
  - pure, node-testable; encodes the STATE MATRIX table exactly. The
    `catch-up` action bundles the SUBSCRIBED row's three effects
    (reset attempts to 0, run the catch-up reconcile, log at debug);
    the caller receives no separate signals.

`src/screens/Chat.svelte` (messages effect, `:1993-2051`):

- A `$state` resubscribe tick is read inside the effect (making it a
  dependency) and bumped by the decision module's `resubscribe`
  action. The attempts counter is a component-scope plain
  (non-reactive) variable keyed to the thread id; the effect applies
  the keyed reset (`if (threadId !== attemptsFor) { attempts = 0;
  attemptsFor = threadId; }`) - it must survive the tick re-run, so
  it cannot live in effect scope.
- `onStatus` handler: consult the decision module.
  `catch-up` -> await any in-flight `selectThread` fetch for this
  thread (component-scoped map, see DECISIONS), then
  `void reconcileTranscript(threadId, 'post-subscribe-catch-up')`;
  `resubscribe` -> warn log (carrying the thread id) + tick bump;
  `log-warn` -> warn log (thread id included) only; `log-debug` ->
  debug log only.
- The dedup/merge invariants are untouched: the catch-up flows through
  `reconcileTranscript`, which is thread-guarded and idempotent (P4).

`src/screens/Chat.svelte` (`reconcileTranscript`, `:3078-3089`):

- Add the streaming-row strip (P23 shape) to the fetched snapshot
  before the merge, so a mid-turn catch-up cannot double-paint the
  streaming bubble. Comment names the double-paint symptom.

Tests (node-env, no DOM):

- `tests/realtime-subscribe.test.ts`: extend the fake channel to
  record and invoke the `.subscribe()` callback (P22); assert
  passthrough of SUBSCRIBED / failure statuses; assert the fresh-topic
  contract still holds for the four-arg call.
- New `tests/realtime-recovery.test.ts`: the decision matrix
  (SUBSCRIBED resets; first failure resubscribes; second consecutive
  failure warns only; CLOSED is debug-only).

### Fix 3: cross-tab backstop on the threads UPDATE echo

`src/screens/Chat.svelte` (the `subscribeToThreads` wiring at
`:2069-2132`):

- Inside the existing `onUpdate` callback (P24): if the updated
  thread `id === activeThreadId` and `response_holder_id !== holderId`,
  schedule the trailing debounce for that thread id (2s).
- Hand-rolled debounce: one component-INSTANCE-scope timer variable +
  pending thread id (NOT `<script module>` scope - that state is
  shared across component instances); a newer trigger clears and
  re-arms. Teardown hook: the messages effect's cleanup function
  clears the pending timer (it runs on both thread switch and
  unmount; the threads subscription effect does not tear down on
  thread switches, so it cannot own the cleanup).
- On fire: `void reconcileTranscript(threadId, 'cross-tab-threads-echo')`.
- Comment: names the sighting (c) shape it heals (a foreign turn whose
  message echoes never arrived) and the real trigger budget (P14 +
  heartbeat echo: heartbeat row UPDATEs DO echo - the filter is
  user_id-scoped - so a foreign turn triggers about once per 15s
  heartbeat plus claim/stamp/clear/bump writes; the trailing debounce
  collapses each quiet 2s gap into at most one reconcile).

### Fix 4: END-time reconcile for own sends

In `runExchange`'s POST-FINALLY settled tail (next to the queued
drain at `:5387`, reached by every settle path except the
`StreamDisconnectedError` return at `:5228`, which
`reconnectInflightTurn`'s own refetch covers):

```ts
if (activeThreadId === ctx.threadId) {
  void reconcileTranscript(ctx.threadId, 'post-turn');
}
```

- Fire-and-forget, unconditional on outcome (see DECISIONS). The
  post-edit-commit site (`:5095-5097`) stays: it is AWAITED there on
  purpose (ordering the edited row above the reply before the view
  settles is load-bearing for that branch).
- A conflict settle reconciles too: the refetch may deliver the
  foreign user's rows while the conflict banner is up. That is the
  desired server-truth behavior, not a bug to flag during QA.

### Fix 5: dead wiring removal

- Delete the `onToolResultPersisted` member from `ChatLoopHandlers`
  (`src/lib/chat/types.ts:49-52` region).
- Delete the handler object entry (`src/screens/Chat.svelte:4834-4839`).
- Rewrite the stale comment at `:2800-2802` to name
  `onAssistantPersisted` as the sole producer of buffered rows.
- Sweep the comment references in `src/lib/exchange/exchange-store.svelte.ts:124`
  and `exchange-slot.svelte.ts:84`, and the handler-table row at
  `docs/dev/exchange.md:349` (P26).

### Rider (a): regen-target stickiness

Diagnosis first (M0 repro, characterization step), then fix. The
state lifecycle (P16-P18) leaves two plausible holders of a stale
outline:

1. `hoverRegenerateIds` never cleared because the hovered element left
   the DOM before `mouseleave` could fire (the preview range is
   computed at hover time; a commit that rebuilds rows while the
   pointer is parked on the button loses the leave event).
2. A `fadeOutDelays` entry surviving a failed prune path, keeping
   `.fading-out` opacity on a row that was never removed.

Fix shape (applied once the repro names the holder): clear
`hoverRegenerateIds` at the settled-turn tail alongside the existing
`pendingDeleteIds = []` clears, and gate the `hoverRegenerateSet`
half of the class binding off while a send is in flight on the
thread (the click path already hands the class to
`pendingDeleteSet` alone, `:5904-5908` - this extends the same
invariant to the whole send window). Visible behavior change to
record for M8's QA: hovering a regenerate button DURING an in-flight
send no longer previews the range - acceptable because the buttons
are disabled mid-send anyway, but it must not be logged as a
regression. The gating predicate is
extracted into `src/lib/ui/regenerate` and pinned in
`tests/regenerate.test.ts` (which already pins the range math there)
so the fix is not purely QA-verified.

### Rider (b): QA doc precondition tightening

`docs/qa/use-cases/chat-regenerate-from-here.md:33-40`: replace the
"ask something that triggers memory or web search" recipe with one
that reliably dispatches a tool on z-ai-glm-5-3-flash: enable the
Images toolbox and ask for a generated picture (the `image`
combination tool with `op=generate` is the reliable slow-tool
trigger the doc's own 2026-08-21 findings row recommends, `:113`;
that row predates the image-tool consolidation and its
`generate_image` name is history, not a target). For the general tool-turn precondition, ask the
model to save a specific fact to memory (the memory tools dispatch
deterministically on an explicit save request). Update the
precondition wording and note the model dependence.

### Rider (c): Settings status placement + aria-live

`src/screens/Settings.svelte`:

- Move the `{#if modelError}` / `{#if modelInfo}` pair from
  `:1997-1998` to directly after the image-EDIT picker block (after
  `:1909`), which puts it adjacent to both pickers (generation
  `:1848-1872`, edit `:1885-1909`) - the actions whose feedback most
  needs proximity.
- Add `aria-live="polite"` to both lines, matching the file's own
  convention (`:1827`, `:2196`, `:2321`).
- Accepted tradeoff (P20): the pair is pane-wide, so notices from the
  emphasis / notifications toggles below render about a section above
  their controls. The intentions toggle already renders its own local
  pair beside its control (`:1954-1955`), so it is unaffected. The
  shared pair's remaining audience is dominated by the pickers.
  Alternative rejected: splitting the pair per section multiplies
  state for one pane.

## MILESTONES

- **M0 - QA baseline + characterization (browser needed).** Execute
  `chat-streaming-turn.md`, `chat-generated-image-card.md`,
  `chat-regenerate-from-here.md`, `settings-image-model-picker.md`
  against the unchanged code; log rows (date, env, commit). Run the
  deafness repro attempts (post-reload, regenerate-no-reload,
  two-tab) with the diagnostic from sighting (c) first: distinguish
  realtime vs refetch for the second tab's title change. Characterize
  rider (a)'s stale-set holder. Message the coordinator BEFORE
  starting browser work to de-conflict with garrick-the-lint-warden-00023.
- **M1 - fixes 1-2.** realtime.ts status callback + facade parameter;
  the `realtime-recovery` pure module + its test; Chat.svelte effect
  wiring (tick, attempts, catch-up with in-flight-fetch await);
  reconcileTranscript streaming-row strip; the extended
  realtime-subscribe tests. Gate green.
- **M2 - fix 3 (cross-tab backstop).** threads-onUpdate hook +
  hand-rolled debounce + teardown. Gate green.
- **M3 - fix 4 (END-time reconcile).** Settled-tail call site. Gate
  green.
- **M4 - fix 5 (dead wiring removal).** Member, handler, comment
  sweeps, exchange.md row. Gate green.
- **M5 - rider (a) fix** per the M0 characterization, with the
  predicate extraction + test.
- **M6 - rider (c) Settings fix.**
- **M7 - docs.** `docs/dev/chat.md` (messages-subscription gotcha:
  the SUBSCRIBED catch-up contract, the reconcile call sites; ALSO
  correct the stale `venice.ts` -> `stream-transport.ts` pointer at
  `:910-911` while in there), `docs/dev/exchange.md` (handler table
  if not covered in M4), `docs/dev/settings.md` (status-line
  placement if the doc names it), `docs/user/` if the status line's
  behavior is described there (check; the placement change is
  cosmetic but visible). Rider (b) lands with M0's doc edit or here,
  whichever the QA flow prefers.
- **M8 - QA re-run + close-out.** Re-execute the M0 use cases, log
  before/after pairs, message the coordinator the diff summary +
  test results + QA rows. No done declaration before their review.

Gate: `mise run check` green before EVERY commit (no pipe-swallowed
exit codes; run it unpiped).

## QA PLAN

- Environment: shared local stack (127.0.0.1:54321/54322) +
  singleton Playwright browser shared with garrick-the-lint-warden-00023.
  Own Vite from this worktree (`mise run dev-frontend`, auto free
  port); own origin `http://[::1]:<port>`; seed per the worktree-QA
  memory (`nak-qa-config.json` trick, then delete the public copy);
  sign in dev@nak.local; threads prefixed `ZZQA-RT-`; delete only own
  rows; never `playwright_browser_close`; never the shared
  current-tab pointer tools when a foreign tab exists - use
  `playwright_browser_run_code_unsafe` with explicit page selection
  from `context().pages()`.
- Browser needed at: M0 (baseline + repros + rider (a)
  characterization) and M8 (post-change re-runs). The coordinator is
  messaged before each window.
- M0 GO CONDITION: the local stack is restored by garrick
  (the-lint-warden) and the coordinator relays the confirmation -
  M0 does not start before that.
- M0 NOISE DISCIPLINE (load-bearing for the diagnosis): run repro
  turns ONE AT A TIME and record whether a concurrent garrick QA turn
  was in flight during each. A concurrent streaming turn can
  CPU-starve the shared local edge runtime, and a CPU-killed isolate
  is indistinguishable from the real defect mid-run - a noisy
  baseline would poison the sighting-(c) realtime-vs-refetch
  distinction. Surprising or inconsistent verdicts get re-run clean,
  not explained away.
- Between browser windows, all work (M1-M7 code + docs + gate) is
  local and conflict-free.
- Two-tab repro hygiene: the second tab stays on my own origin
  (separate localStorage; `holderId` is per-tab, so a second tab is a
  genuine foreign observer for the messages channel).

## RISKS / OPEN QUESTIONS

- **Sighting (c) root cause may be infra-level** (realtime delivery
  genuinely failing server-side). The fixes make the state visible
  (status logging), heal the open-time snapshot (catch-up), heal
  per-turn for the sender (END reconcile), and heal per-turn for a
  foreign observer IFF the threads echo is alive (backstop). If BOTH
  echo streams are dead mid-session, only focus-refresh recovers -
  logged at M0 if observed.
- **The debounce backstop is new surface** (shape: hand-rolled, per
  DECISIONS). Its trigger set is foreign-or-null holder threads
  UPDATEs on the active thread. The real budget: heartbeat row
  UPDATEs echo too (the subscription filter is user_id-scoped), so a
  foreign turn triggers about once per 15s heartbeat plus
  stamp/clear/bump writes; the 2s trailing debounce collapses each
  quiet gap into at most one reconcile, and the effect is beneficial
  (a foreign turn's rows heal DURING the turn, not only at its end).
  The reconcile itself is a bounded single query. Accepted redundancy:
  one extra reconcile per own turn (claim-release echo).
- **`CLOSED` status semantics** differ across realtime-js versions;
  treated as debug-only, never a resubscribe trigger, to avoid
  resubscribing on our own teardown echoes. The stream-transport
  precedent discriminates self-teardown via a local closed flag
  (P12, `stream-transport.ts:614-617`) and COULD widen recovery to
  socket-death-shaped CLOSED events; that is a deliberate scope cut
  here - the reconciles carry transcript correctness without it, and
  the status log makes the failure visible either way.
- **A conflict settle's reconcile** may deliver the foreign user's
  rows while the conflict banner is up. Desired server-truth
  behavior; noted so it is not mistaken for a bug during QA.
- **A FAILED channel is silent to the user.** After two consecutive
  subscribe failures the channel stays dead until a thread switch or
  reload; the warn log (with thread id) is the only signal. A
  user-visible surface was considered and cut on purpose - the
  reconciles carry transcript correctness without it, and
  sight-of-failure in the Logs drawer is enough for this defect's
  scope.
- **The messages-echo ROOT CAUSE is a deliberate follow-up.** This
  branch HEALS the deafness deterministically (catch-up at SUBSCRIBED,
  threads-echo backstop, END-time reconcile); it does not CURE it.
  M0 established the failure is messages-channel-specific on a shared
  healthy socket (the threads postgres_changes echo delivers to the
  same tab the messages echo abandons). Coordinator's leading theory:
  the messages channel joins before the socket holds the auth token,
  so its postgres_changes RLS check runs as anon forever while the
  later-joining threads channel escapes it - unverified. Identifying
  the mechanism (and fixing it server-side or at join order) is
  follow-up work; a fix here would need realtime-js socket/auth
  lifecycle instrumentation that does not belong in this defect's
  scope. The status logging added in fixes 1-2 is the observability
  that follow-up starts from.
- **Thread-open cost is two `listMessages`** (opening fetch + catch-up)
  plus the streamState point read. Accepted for a single-user stack;
  the swap window (P25) means the layered triggers, not any single
  reconcile, are what make delivery eventually-correct.
