# Realtime Delivery Fixes Plan

Status: DRAFT 2026-11-03. Bug-intake dispatched fix session
(realtime-delivery-fixes worktree, base 07eca2c4). Owner: the fix
session; reviewer/coordinator: guard-5-00021.

## SYNOPSIS

Five changes, one defect and three riders:

1. **SUBSCRIBED-confirmed catch-up read on the messages channel.**
   `subscribeToMessages` gains an optional subscribe-status callback
   (the pattern the Broadcast stream channel already uses,
   `src/lib/venice.ts` `setupStreamSubscription`, documented at
   `docs/dev/chat.md:910-914`). On `SUBSCRIBED` the caller runs one
   transcript reconcile. This closes the fetch-then-async-join race:
   any row inserted between the opening `listMessages` snapshot and
   the channel join is re-fetched after the join instead of landing
   in neither.
2. **Subscribe-failure visibility and one bounded resubscribe.** The
   same status callback logs `CHANNEL_ERROR` / `TIMED_OUT` at warn
   and schedules a single resubscribe (fresh topic, the existing
   `uniqueTopic` mechanism, `src/lib/supabase/realtime.ts:76-78`).
   Today a failed join is silent: `.subscribe()` is called with no
   callback (`src/lib/supabase/realtime.ts:162`).
3. **END-time transcript reconcile for own sends.** `runExchange`'s
   settled-turn tail re-fetches the transcript for the active thread
   on every clean turn finish (normal sends and regenerates). This
   is the writer-of-record backstop: the edge function is the only
   writer of tool rows and generated-image attachments
   (`docs/dev/architecture.md:423, 427`), so the sending tab stops
   depending on the realtime echo for rows the browser never writes.
4. **Remove the dead `onToolResultPersisted` wiring.** The handler
   member (`src/lib/chat/types.ts:52`) and its only consumer
   (`src/screens/Chat.svelte:4834-4839`) have zero producers (grep
   verified; `src/lib/chat/loop.ts` and `src/lib/chat/stream-events.ts`
   never call it). Fixes 1-3 subsume what it was meant to do.
5. **Riders.** (a) The regenerate commit's `.regen-target` stickiness
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
   never produced - residue from the browser-dispatch era.
4. **No END-time messages refetch on the normal send path.**
   `runExchange`'s success tail only refreshes threads
   (`src/screens/Chat.svelte:5181`). END hydration fetches only the
   single assistant row (`src/lib/chat/stream-events.ts:407-425`).

Constraint honored throughout: no fix depends on catching the
10-21ms Scanner image placeholder window (the server attaches
generated images before publishing the tool response).

## VERIFIED PREMISES

Every citation below was read and confirmed in this session at base
07eca2c4.

| # | Premise | Citation |
| --- | --- | --- |
| P1 | `subscribeToMessages` binds INSERT + UPDATE postgres_changes and calls `.subscribe()` with NO status callback | `src/lib/supabase/realtime.ts:93-171` (subscribe at :162) |
| P2 | The messages effect keys on `activeThreadId` + `activeThreadIsDraft` and dedups by id at the append site | `src/screens/Chat.svelte:1993-2051` |
| P3 | The opening transcript fetch is `listMessages` inside `selectThread`, concurrent with the subscription effect | `src/screens/Chat.svelte:2781` |
| P4 | `reconcileTranscript` refetches and merges fetched rows with the slot's buffered rows by id | `src/screens/Chat.svelte:3078-3089` |
| P5 | The post-claim-release reconcile fires only on foreign-claim clear; own-turn lifecycle is skipped by the guard | `src/screens/Chat.svelte:3036-3051` (guard :3047, comment :3032-3033) |
| P6 | The post-edit-commit reconcile runs only when `ctx.replaceUserMessageContent` is set (destructive-edit branch) | `src/screens/Chat.svelte:5095-5097` |
| P7 | `onToolResultPersisted` is declared and handled but has zero producers | `src/lib/chat/types.ts:52`, `src/screens/Chat.svelte:4834-4839`; grep over `src/` finds no caller in `chat/loop.ts` or `chat/stream-events.ts` |
| P8 | The tool_result broadcast event does NOT carry the row; its own comment names the messages realtime subscription as the row's only live feed | `src/lib/chat/stream-events.ts:188-198` |
| P9 | END hydration fetches only the assistant row (`getMessage`); no tool-row refetch exists on the send path | `src/lib/chat/stream-events.ts:407-425`; `src/lib/supabase/realtime.ts:183-194` |
| P10 | `runExchange`'s settled tail calls `await refreshThreads()` and no messages refetch | `src/screens/Chat.svelte:5181` |
| P11 | The edge function is the writer-of-record for `role='tool'` rows and generated-image attachments | `docs/dev/architecture.md:423, 427` |
| P12 | The Broadcast stream channel already uses a subscribe-status callback for disconnect handling (in-file precedent for fix 1-2) | `docs/dev/chat.md:910-914`; `src/lib/venice.ts` `setupStreamSubscription` |
| P13 | postgres_changes channels can take a unique topic per subscription; resubscribe is safe | `src/lib/supabase/realtime.ts:55-78` |
| P14 | A threads UPDATE echo reaches the browser per user-row insert (browser bumps `updated_at`) and per terminal commit (RPC bumps it); heartbeat refreshes do NOT bump it (direct column write, no threads trigger) | `src/lib/supabase/messages.ts:552`; `supabase/schema.sql:13985-13993`; `supabase/functions/venice/getStreamingResponse.ts:404-408` |
| P15 | The paired-read pattern (point read covering a channel's join window) is the module's documented convention | `src/lib/supabase/realtime.ts:8-13`; `subscribeToInflightLease`/`getInflightLeaseExpiry` pair at `:306-361` |
| P16 | `.regen-target` is driven by `pendingDeleteSet` OR `hoverRegenerateSet` at three class sites | `src/screens/Chat.svelte:8246, 8333, 8383` |
| P17 | `.regen-target.fading-out` runs the fade animation | `src/styles.css:2676-2679` |
| P18 | Regenerate clears the hover set on click and the pending-delete set after prune (both tails) | `src/screens/Chat.svelte:5904-5908`, `:5085`, `:5109` |
| P19 | Settings AI pane: shared `modelInfo`/`modelError` render bare at the pane bottom, below the notifications toggle; the image pickers sit far above; the file's aria-live convention is `aria-live="polite"` on status lines | `src/screens/Settings.svelte:1997-1998` (status), `:1848-1872` (generation picker), `:1885-1892` (edit picker), `:1827`, `:2196`, `:2321` (convention) |
| P20 | `modelInfo`/`modelError` are a SHARED pane-wide pair: written by the image-gen pick, image-edit pick, name, location, emphasis toggle, notifications toggle, and timezone save | `src/screens/Settings.svelte:1348-1355, 1361-1368, 1380-1402, 1421-1430, 1444-1469, 1561-1577` |
| P21 | The regenerate QA doc's precondition for a tool-calling turn ("ask something that triggers memory or web search") is the line judged unreliable on z-ai-glm-5-3-flash | `docs/qa/use-cases/chat-regenerate-from-here.md:33-34` |
| P22 | An existing unit test file covers `subscribeToMessages` (stubbed-client harness to extend) | `tests/realtime-subscribe.test.ts:29, 79` |

## DECISIONS

Recorded so a future session does not re-litigate them.

- **Catch-up read at SUBSCRIBED, not per-tool fetch.** The intake's
  "fire a tool-result hook from `tool_call_response`" seam (fetch the
  row by `tool_call_id`) is REJECTED: it needs a new query-by-
  `tool_call_id` method, fires one fetch per tool, and still depends
  on the echo path being alive. One reconcile after the join lands
  every row (tool rows, image cards, assistant rows) with the merge
  machinery P4 already trusts.
- **The dead handler is removed, not produced.** With fixes 1-3 in
  place, `onToolResultPersisted` stays dead. Deleting the member and
  the handler follows the dead-code hygiene rule (`CLAUDE.md` "Dead-code
  hygiene"); the stale comment reference at `src/screens/Chat.svelte:2802`
  is rewritten to name the real producer (`onAssistantPersisted`).
- **Own-turn reconcile is added at the settled tail; the foreign-claim
  guard stays as-is.** Relaxing the guard at `:3047` would fire a
  refetch on every own-claim release with no flush of what actually
  landed; the settled tail already knows the turn finished and can
  reconcile once, deliberately.
- **Cross-tab backstop rides the threads UPDATE echo, debounced.** A
  foreign threads UPDATE for the ACTIVE thread schedules one trailing
  debounce (2s) reconcile. Per P14 the echo fires at most twice per
  foreign turn (user-row bump, terminal-commit bump), so the backstop
  is not chatty, and a trailing debounce after the terminal bump
  catches the tool rows that landed just before it. This is the piece
  that addresses sighting (c) without trusting the unproven
  "threads channel works" inference: whatever thread-level signal the
  second tab DID receive becomes a trigger to heal the message list.
- **Resubscribe budget: one retry per subscription instance.** The
  failure statuses schedule exactly one resubscribe (via a tick the
  effect depends on, so teardown/recreate flows through the existing
  cleanup). A second consecutive failure is logged at warn and left
  to the reconciles (fixes 1 and 3 keep the transcript correct even
  when the echo stream is dead); no retry loop, no backoff machine.
- **No schema change, no edge-function change.** All browser-side.
  The function already persists and publishes everything needed.

## STATE AND TRANSITION MATRIX

The messages channel's lifecycle (per subscription instance created
by the effect at `src/screens/Chat.svelte:1993`):

| State | Entered when | Exited when | Actions on entry |
| --- | --- | --- | --- |
| JOINING | effect run: `subscribeToMessages` called, no status ack yet | status callback fires with SUBSCRIBED, or a failure status | none (dispatch suppressed rows still flow to dedup) |
| SUBSCRIBED | status `SUBSCRIBED` | teardown (thread switch / unmount) | ONE catch-up reconcile; log at debug |
| RESUBSCRIBE_PENDING | status `CHANNEL_ERROR` or `TIMED_OUT` | tick re-runs effect -> JOINING | log at warn; bump retry tick (once per instance) |
| FAILED | second failure status on the same instance | teardown | log at warn; transcript correctness rests on reconciles |
| removed | teardown: effect cleanup runs | - | `removeChannel` fire-and-forget (existing) |

Precedence rules:

- The catch-up reconcile fires at most once per subscription
  instance, on the FIRST `SUBSCRIBED` only. A resubscribed instance
  is a new instance and gets its own catch-up (correct: the channel
  was dark, the transcript may have moved).
- Teardown cancels nothing in flight; the reconcile is
  thread-guarded (`activeThreadId !== threadId` discards, P4), so a
  thread switch mid-catch-up is a no-op by construction.
- The cross-tab backstop (debounced foreign-threads-UPDATE reconcile)
  and the END-time own-send reconcile are independent triggers of the
  same `reconcileTranscript`; they never compose state, they only
  refetch-and-merge, which is idempotent by id (P4).
- Echo delivery is never gated on subscribe state: JOINING and FAILED
  tabs still process any echo that arrives. Status handling changes
  visibility and recovery, not the event path.

## APPROACH

### Fix 1 + 2: status callback, catch-up, failure handling

`src/lib/supabase/realtime.ts`:

- `subscribeToMessages` gains an optional third parameter
  `onStatus?: (status: 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED', err: unknown) => void`,
  passed straight through to `.subscribe()` (the exact shape the
  logs and samskara channels already use,
  `src/lib/supabase/realtime.ts:288-290, 723-725`).
- Docstring updated: the caller pairs the SUBSCRIBED ack with a
  catch-up read (P15 convention).

`src/screens/Chat.svelte` (messages effect, `:1993-2051`):

- A `$state` resubscribe tick is read inside the effect (making it a
  dependency) and bumped at most once per instance on a failure
  status.
- `onStatus` handler: `SUBSCRIBED` -> `void reconcileTranscript(threadId,
  'post-subscribe-catch-up')`; `CHANNEL_ERROR`/`TIMED_OUT` -> warn log +
  tick bump (first failure only); `CLOSED` -> debug log only (normal
  teardown shape).
- The dedup/merge invariants are untouched: the catch-up flows through
  `reconcileTranscript`, which is thread-guarded and idempotent (P4).

### Fix 3: END-time reconcile for own sends

In `runExchange`'s settled-turn tail (the block containing
`src/screens/Chat.svelte:5181`), after the existing bookkeeping and
only when the turn finished cleanly (not `interrupted`, not
`conflictDetected`, and the ask-user suspend did not swallow the
turn), call:

```ts
if (activeThreadId === ctx.threadId) {
  await reconcileTranscript(ctx.threadId, 'post-turn');
}
```

Background exchanges (thread switched away mid-turn) are covered by
the existing `slot.persistedRows` merge on re-entry (P3/P4); the
guard skips them here on purpose. Ordering: AFTER the fade-out prune
branch (`:5070-5111`) so the refetch omits pruned rows and the swap
cannot resurrect them; the post-edit-commit site (`:5095-5097`) folds
into this call (same reconcile, one why-string) or stays separate -
the reviewer weighs which reads better.

### Fix 4: dead wiring removal

- Delete the `onToolResultPersisted` member from `ChatLoopHandlers`
  (`src/lib/chat/types.ts:49-52` region).
- Delete the handler object entry (`src/screens/Chat.svelte:4834-4839`).
- Rewrite the stale comment at `:2800-2802` to name
  `onAssistantPersisted` as the sole producer of buffered rows.
- Sweep comments in `src/lib/exchange/exchange-store.svelte.ts:124`
  and `exchange-slot.svelte.ts:84` that name the dead handler.

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
invariant to the whole send window). Cheap, no new state.

### Rider (b): QA doc precondition tightening

`docs/qa/use-cases/chat-regenerate-from-here.md:33-40`: replace the
"ask something that triggers memory or web search" recipe with one
that reliably dispatches a tool on z-ai-glm-5-3-flash: enable the
Images toolbox and ask for a generated picture (`generate_image` is
the reliable slow-tool trigger the doc's own 2026-08-21 findings row
recommends, `:113`). For the general tool-turn precondition, ask the
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
  emphasis / intentions / notifications toggles below render about a
  section above their controls. The intents toggle already renders
  its own pair locally (`:1954-1955`), so the shared pair's audience
  is dominated by the pickers. Alternative rejected: splitting the
  pair per section multiplies state for one pane.

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
- **M1 - realtime.ts status callback + Chat.svelte catch-up +
  failure handling** (fixes 1-2), with unit tests extended in
  `tests/realtime-subscribe.test.ts` (P22): status passthrough,
  catch-up-once semantics, one-resubscribe cap.
- **M2 - END-time reconcile** (fix 3) + unit coverage for the merge
  behavior if a seam exists (the function is inside the component;
  cover via the `reconcileTranscript` merge helper tests if
  `mergeMessagesById` tests do not already pin it - check
  `tests/`).
- **M3 - dead wiring removal** (fix 4) + comment sweeps. Gate green.
- **M4 - rider (a) fix** per the M0 characterization.
- **M5 - rider (c) Settings fix.**
- **M6 - docs.** `docs/dev/chat.md` (messages-subscription gotcha:
  the SUBSCRIBED catch-up contract, the reconcile call sites),
  `docs/dev/settings.md` (status-line placement if the doc names
  it), `docs/user/` if the status line's behavior is described there
  (check; the placement change is cosmetic but visible). Rider (b)
  lands with M0's doc edit or here, whichever the QA flow prefers.
- **M7 - QA re-run + close-out.** Re-execute the M0 use cases, log
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
  characterization) and M7 (post-change re-runs). The coordinator is
  messaged before each window.
- Between browser windows, all work (M1-M6 code + docs + gate) is
  local and conflict-free.
- Two-tab repro hygiene: the second tab stays on my own origin
  (separate localStorage, same holder identity is per-tab by
  `holderId`, so a second tab is a genuine foreign observer for the
  messages channel).

## RISKS / OPEN QUESTIONS

- **Sighting (c) root cause may be infra-level** (realtime delivery
  genuinely failing server-side). The fixes make the state visible
  (status logging), heal the open-time snapshot (catch-up), and heal
  per-turn (backstop + END reconcile) - but if the echo stream itself
  is dead mid-session, a FOREIGN tab still depends on the backstop
  catching the threads echo. If the threads echo is also dead, only
  focus-refresh recovers - logged at M0 if observed.
- **The debounce backstop is new surface.** Its trigger set is
  exactly foreign threads UPDATEs on the active thread (P14: at most
  twice per foreign turn plus side-effect writes that bump
  `updated_at` - the schema notes title writes do NOT bump,
  `supabase/schema.sql:6051-6052`). The 2s trailing debounce bounds
  any burst; the reconcile itself is a bounded single query.
- **`CLOSED` status semantics** differ across realtime-js versions;
  treated as informational only, never a resubscribe trigger, to
  avoid resubscribing on our own teardown echoes.
