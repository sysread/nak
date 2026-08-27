# Incomplete-turn detection unification (spike)

> **Status: implemented (browser-side), 2026-08-27.** The
> unification described in "Scope of a unification" below has
> shipped as `src/lib/ui/completion-status.ts` +
> `src/components/CompletionStatusCard.svelte`. The heuristics
> inventory below is the historical map; the current contract
> lives in `docs/dev/exchange.md` ("One completion-status card")
> and in the module itself. When the follow-up work below is
> done, graduate the durable design into a permanent `docs/dev/`
> doc and retire this file.

## SYNOPSIS

The chat transcript path has ten separate mechanisms that
detect or report "the last turn didn't finish" - a failed
completion, an interrupted stream, an orphaned tool round.
They overlap, use different signals, run at different times
(read time vs render time vs session time), and in some cases
contradict each other. This spike maps all of them, identifies
the inconsistencies, and frames the scope of a unification
effort.

## Motivation

The user-message-editing feature introduced `status='draft'` user
messages at the tail of a fork. The existing
`classifyIncompleteTurnTail` heuristic treated any user message at
the tail as a cut-off, so every fork-and-edit fork showed a false
"response appears to have been cut off" banner. The fix (excluding
`status='draft'`) was small, but the investigation revealed that
the heuristic landscape is far more fragmented than it should be.
This doc captures the full picture so the unification can be
planned as a standalone effort.

## Surface area

Every touch point the unification will have to own. Anything
not listed here is a straggler the unification missed.

**The detection core** (`src/lib/ui/incomplete-turn.ts`):

- `classifyIncompleteTurnTail` (H1) - the transcript-shape
  verdict.
- `isReasoningOnlyStall` (H2) - dead-turn predicate.
- `isCutOffPartialText` (H3) - dead-turn predicate,
  disconnected from H1.

**The banner plumbing** (`src/lib/ui/recovery-banner.ts` +
`Chat.svelte`):

- `selectRecoveryBanner` - the one-banner selector
  (error > interrupted-draft > cut-off).
- `recoveryBannerSource` - Logs-drawer diagnostic label.
- The `incompleteTurnTail` derived (H4), the `displayedError`
  derived and its `parseLastError` half (H5), the
  `interruptedDraft` state (H6), and the `recoveryBanner`
  derived that binds retry/dismiss closures.

**The retry handlers** (both in `Chat.svelte`):

- `retryIncompleteTurn` (H7a) - REPLACE-or-CONTINUE decider.
- `retryInterrupted` (H7b) - always-CONTINUE draft path.

**The "is it still running?" gate** (`src/lib/ui/stream-inflight.ts`):

- `streamLikelyInFlight` - the 760s staleness ceiling
  (2x the orchestrator's 380s wall deadline) over
  `threads.stream_started_at`. Both H4 and H6 call it, but each
  adds different conditions around it.

**The error copy** (`src/lib/ui/last-error.ts`):

- `parseLastError` + `headingFor` - the persistent-error
  reader. Kind union must mirror the function-side
  `TranslatedErrorKind` in `error-translate.ts`.
- `formatRateLimitMessage` + `describeError` - the live-error
  projections.

**The synthesizer** (`src/lib/conversation-recovery.ts`):

- `synthesizeRecoveryMessages` (H10) - wire-shape repair on
  read. Also `isRecoveryMessage` (the marker check H1 fails
  to consult) and `persistSyntheticRecovery` in `Chat.svelte`
  (the heal-on-next-send write-back).

**Server-side signal producers** (not unification targets, but
load-bearing inputs):

- `supabase/functions/venice/getStreamingResponse.ts` -
  `terminalKind` at 12 exit sites + the `threads.last_error`
  write + the guard-exhaustion prefix re-detection.
- `supabase/functions/venice/getStreamingCompletion.ts`
  `errorEventFor` - the collapse layer (GuardExhaustedError
  and AbortError both fold to kind='internal').
- `supabase/functions/_shared/error-translate.ts` - the
  `{kind, message, retryable, occurred_at}` envelope writer.
- `supabase/functions/venice/stream-probe.ts` - the stale-row
  janitor: orphaned `status='streaming'` rows older than 760s
  convert to `status='error'` with a `last_error` payload.

**Tests** (the contract the unification must preserve or
deliberately change):

- `tests/incomplete-turn.test.ts` - H1/H2/H3.
- `tests/recovery-banner.test.ts` - H5's selector precedence.
- `tests/conversation-recovery.test.ts` - H10's false-positive
  guards (load-bearing).
- `tests/last-error.test.ts` - the persistent-error parser.

**Docs + QA:**

- `docs/dev/chat.md` - the aborted-tail contract.
- `docs/dev/exchange.md` - the one-banner story + suppression
  windows.
- `docs/dev/user-message-editing.md` - the draft exclusion.
- `docs/dev/architecture.md` - the recovery-synthesis section.
- `docs/qa/use-cases/chat-cutoff-banner.md` and
  `chat-cutoff-retry.md` - the manual verification record.

## The ten heuristics

### H1: `classifyIncompleteTurnTail` - transcript-shape classifier

**File:** `src/lib/ui/incomplete-turn.ts:125`

**Detects:** Reads the last message in the raw `messages` array and
classifies whether the tail shape means the model never produced a
final reply. Four qualifying tails:

- `role='tool'` at tail (unless pending `ask_user` sentinel)
- `role='assistant'` with `tool_calls` at tail (unless
  `status='aborted'`)
- `role='assistant'` reasoning-only stall (unless `status='aborted'`)
- `role='user'` at tail (unless `status='draft'`)

**Gap:** Does NOT detect `status='error'` assistant rows with
content (partial-text cutoff). That shape falls through to null
because it has content (so `isReasoningOnlyStall` is false) and no
tool_calls. The most common cutoff case - stream failed mid-reply -
is invisible to this classifier.

**Masking:** The two tool-shaped branches are shadowed at thread
load by H10 (see below). More on that in the behavior map.

### H2: `isReasoningOnlyStall` - dead-turn predicate

**File:** `src/lib/ui/incomplete-turn.ts:52`

**Detects:** `role='assistant'` AND `status !== 'aborted'` AND no
`tool_calls` AND content is empty AND reasoning is non-empty. The
model emitted chain-of-thought but no visible answer.

**Used by:** `classifyIncompleteTurnTail` (H1) to qualify the tail,
and `retryIncompleteTurn` (H7) to decide REPLACE vs CONTINUE.

### H3: `isCutOffPartialText` - dead-turn predicate (DISCONNECTED)

**File:** `src/lib/ui/incomplete-turn.ts:84`

**Detects:** `role='assistant'` AND no `tool_calls` AND
`status='error'` AND content is non-empty.

**Used by:** Only `retryIncompleteTurn` (H7). NOT called by
`classifyIncompleteTurnTail` (H1). The predicate that classifies a
partial-text cutoff exists, but the classifier that decides whether
to show the banner does not use it.

### H4: `incompleteTurnTail` derived - session-gated transcript verdict

**File:** `src/screens/Chat.svelte:6599` (the `incompleteTurnTail`
derived)

**Detects:** Calls H1 (`classifyIncompleteTurnTail`) but first gates
on four session-state conditions:

1. `activeSlot?.sending` - turn in progress
2. `activeSlot?.streamingError` - live error already showing
3. `respondingElsewhere` - another device holds the response claim
4. `streamLikelyInFlight(stream_started_at)` - server-side turn
   still running (re-read on the 5Hz `claimNowTick` so a dead
   function's uncleaned stamp eventually expires)

**Feeds:** The `cutOff` source into `selectRecoveryBanner` (H5).

### H5: `displayedError` + `selectRecoveryBanner` - error card and banner selector

**File:** `src/screens/Chat.svelte:6647` +
`src/lib/ui/recovery-banner.ts:88`

**Detects:** `displayedError` combines two sources in precedence:

1. `activeSlot?.streamingError` - session-local, set by 9
   different catch sites in `runExchange` (H8)
2. `parseLastError(currentThread?.last_error)` - persistent, written
   by the server orchestrator on `terminalKind='error'` (H9)

`selectRecoveryBanner` then picks one banner from three sources by
precedence: `error > interruptedDraft > cutOff`. A persisted error
also suppresses the cut-off banner entirely (the retry affordance
lives on the error card instead).

### H6: `interruptedDraft` - orphaned IndexedDB draft detection

**File:** `src/screens/Chat.svelte` - detection in `selectThread`
(~2755), state declared at line 1346.

**Detects:** At thread-load time, checks ALL of:

- Last message is a user row
- No server turn in flight (`streamingTail != null ||
  streamLikelyInFlight(...)`)
- This device isn't already producing the turn
  (`exchangeStore.peek(id)?.sending`)
- An IndexedDB draft exists for this thread whose `userMessageId`
  matches the last message

**Overlap with H1:** Both detect "user message at tail with no
assistant reply." H6 additionally requires an IDB draft. When both
fire, H6 wins precedence in `selectRecoveryBanner`. When only H1
fires (user at tail, no IDB draft), the `cutOff` banner shows with
generic text.

### H7: the two retry handlers

**Files:** `Chat.svelte:5763` (`retryIncompleteTurn`) and
`Chat.svelte:5347` (`retryInterrupted`)

**`retryIncompleteTurn`** walks backward to find the user message,
then checks the tail:

- `isReasoningOnlyStall(tail) || isCutOffPartialText(tail)` -> dead
  turn, REPLACE (sets `pendingDeleteIds`, `supersededIds` - the
  Regenerate machinery: red-outline, off-wire, atomic delete at
  commit)
- Otherwise -> CONTINUE (no deletion; the persisted rows are the
  continuation fuel)

**Inconsistency:** Called from BOTH the `displayedError` retry
button (H5) and the `cutOff` retry button (H4). This is where H3
finally gets used - but only AFTER the banner has already been
shown via a different heuristic.

**`retryInterrupted`** (H6's path) always CONTINUEs - no deletion -
because the interrupted draft path assumes nothing was produced to
replace. Two retry functions for the same action with different
deletion logic.

### H8: `streamingError` - in-session live error (9 catch sites)

**File:** `src/screens/Chat.svelte` - nine assignment sites
(`streamingError = {`): claim-status check failure, reconnect
pre-exchange failures (x2), in-turn equipment failure, terminal
error mapping, rate-limit, guard exhaustion, generic fallback.
Each sets `slot.streamingError` with text and optional retry.

**Feeds:** H5's `displayedError` as the highest-precedence source.
Also gates H4 (incompleteTurnTail suppresses when streamingError is
set).

### H9: Server-side `terminalKind` assignment

**File:** `supabase/functions/venice/getStreamingResponse.ts`

**Detects:** Sets `terminalKind` at every exit point (12 sites):
`'error'` (wall timeout, stream error, round limit, catch block,
commit conflict), `'aborted'` (user cancel), `'complete'` (happy
path), `'suspended_for_ask_user'`.

**Produces:** Row status transition + `threads.last_error` write
(for `'error'` only) + END event with `terminalKind` published to
the Broadcast channel.

**Relationship:** The single server-side source that feeds two
parallel browser paths: `last_error` -> `displayedError` (H5,
persistent) and END event -> `streamingError` (H8, ephemeral). They
can disagree when the END event fires into a dead socket or
`last_error` write fails.

### H10: `synthesizeRecoveryMessages` - wire-shape repair (MASKS H1)

**File:** `src/lib/conversation-recovery.ts:231`

**Detects:** Wire-format-invalid shapes (trailing tool row, trailing
assistant-with-tool_calls missing results, mid-conversation partial
fan-in).

**Effect:** Inserts synthetic recovery rows (tool results + recovery
assistant) to make the wire shape valid. These carry `synthetic:
true` and are filtered from the UI by `buildMessageBlocks`.

**The masking problem:** `listMessages` runs the synthesis on every
read (`src/lib/supabase/messages.ts:93`), so the `messages` state
the classifier reads already contains the healed tail. When the
original tail is a `tool` row or an `asst_with_tool_calls`, the
synthesizer appends a synthetic recovery assistant. H1 then sees
the synthetic assistant as the last message (`role='assistant'`,
content = recovery body, no tool_calls, status=null) and returns
null - no banner. But the user sees the tool result card as the
last visible element with no reply. The classifier sees a settled
tail; the user sees an incomplete one.

**Sharp edge:** H1's own docstring justifies its tool-shaped
branches with exactly the refresh-after-overload scenario the
synthesizer now covers. At thread load the synthesizer always wins
(it ran first, at read time); the tool branches of H1 only fire on
in-memory arrays that never passed through `listMessages`. The
user-at-tail and reasoning-only-stall shapes survive because the
synthesizer leaves wire-valid shapes alone.

## The other error surfaces on the chat screen

The transcript-tail heuristics are not the only things competing
for the user's attention when a turn goes wrong. The full
inventory of "something went wrong / something is happening"
surfaces on the Chat screen, each with its own state machine:

- **`error` state -> `.error-bar` above the composer**
  (`Chat.svelte` state at 1283, render at 8778). 30+ assignment
  sites: thread-load failures, attachment validation, delete/fork
  failures, round-limit stops, pre-send guards. Has an optional
  retry button but NO dismiss button. Cleared only incidentally -
  at 4 sites (attachment mutations, send start) - so a stale bar
  can linger indefinitely until some unrelated action happens to
  null it. Conceptually "action feedback", not turn state, but
  nothing stops it from coexisting with a tail banner about the
  same failure.
- **`recoveryBanner`** - the transcript-tail surface (the ten
  heuristics above). One element by construction.
- **Slop notices** - per-rejected-attempt cards between the tail
  banner and the throbber. Transient (CRT animation then
  unmount), but coexist with the recovery banner in the window
  before the terminal error lands.
- **Offline banner** - fixed-position, mounted whenever the
  device is offline. Orthogonal content, but it occupies screen
  space at the same moment the tail is trying to explain a
  network failure.
- **Scanner states** - reconnecting / responding-elsewhere /
  thinking. Informational, not errors, but they render in the
  same tail region and participate in the "what is going on"
  pile.

**The stacking report (2026-08-27, user-observed):** banners
stack and each hides the one below. The in-flow surfaces stack
vertically by DOM order (tail banner, then slop notices, then
throbber, then queued cards), and `.error-bar` renders out-of-
flow below the message list. A pinned-to-bottom scroll plus
several coexisting surfaces produces the pile-up; the exact
repro is unconfirmed. What is confirmed statically: nothing
arbitrates BETWEEN surfaces - each surface has its own state,
its own lifecycle, its own render slot, and no cross-surface
priority. `selectRecoveryBanner` arbitrates three sources into
one element, but the element it picks can still render
underneath the slop notices, the offline banner, and a stale
`.error-bar` simultaneously.

## The inconsistencies (verified 2026-08-27)

1. **`isCutOffPartialText` is disconnected from the classifier.** The
   predicate exists, the retry handler uses it, but the classifier
   that decides whether to show the banner never calls it. A
   `status='error'` assistant with content is invisible to H1.
   Practical blast radius is narrow: the same server path that
   persists the error row also writes `last_error`, so the error
   card usually covers it. It bites when `last_error` was never
   written, was dismissed (clearing the column), or predates the
   column.

2. **`synthesizeRecoveryMessages` masks the classifier.** Synthetic
   rows make H1 see a "settled" tail while the user sees an
   incomplete one. H1 does not check `isRecoveryMessage`. Worse,
   the two tool-shaped branches H1 documents as its reason for
   existing are precisely the shapes the synthesizer heals first -
   the two systems solve the same tail problem with different data
   views, and the synthesizer wins by running at read time while
   the classifier runs at render time.

3. **Three overlapping "user at tail" detectors.** H1 fires for any
   non-draft user. H6 fires only when an IDB draft also exists.
   Both feed the banner selector with different precedence and
   different text.

4. **Two parallel paths from the same server signal.**
   `terminalKind='error'` feeds both `last_error` (persistent) and
   END event -> `streamingError` (ephemeral). They disagree when
   the END event fires into a dead socket or `last_error` write
   fails.

5. **Different "is turn still running?" tests.** H6 checks
   `streamingTail != null || streamLikelyInFlight(...)` AND
   `exchangeStore.peek(id)?.sending`. H4 checks only
   `streamLikelyInFlight(...)` plus the active slot's `sending`.
   H6 additionally treats a live streaming row as in-flight; H4
   trusts only the stamp. Different gates for the same question.

6. **Guard exhaustion detected by string prefix in two places, two
   copies.** The spike's original claim ("server collapses to
   kind='internal'") is now half-stale: the persistent path was
   fixed to route to a dedicated `guard_exhausted` kind with humane
   copy. What remains: GuardExhaustedError still collapses to
   kind='internal' at the error-event boundary
   (`getStreamingCompletion.ts` `errorEventFor`), and BOTH the
   orchestrator (`getStreamingResponse.ts:602`, for `last_error`)
   and the browser live path (`Chat.svelte:5107`) re-detect it by
   `message.startsWith('Stream guard "')`. The live and reload
   surfaces also still carry different copy ("kept returning a
   malformed response" vs "kept emitting malformed output" + a
   "Malformed response" heading) for the same failure.

7. **Two retry functions with different REPLACE vs CONTINUE logic.**
   `retryInterrupted` (H6's path) always CONTINUEs.
   `retryIncompleteTurn` (H4/H5's path) checks H2+H3 to decide. Same
   action, different deletion heuristics. In practice the two
   handlers' decisions agree for the shapes each can reach (the
   draft path only arms when the tail is a user row, which is a
   continuation point anyway), but nothing enforces that
   agreement - it is coincidence, not contract.

8. **Four-plus independent error/notice state machines, no cross-
   surface priority.** `error` (30+ sites, no dismiss, incidental
   clearing), `recoveryBanner` (three arbitrared sources), slop
   notices (per-attempt array), offline banner (network flag) -
   all can be visible at once. Within the tail trio,
   `selectRecoveryBanner` enforces one-banner; across surfaces,
   nothing does. The same underlying failure can also produce
   different copy on different surfaces (live vs persisted guard
   exhaustion, inconsistency 6, is one instance of this).

## Behavior map

What the user actually experiences, per failure shape. This is the
ground truth the unification must preserve (or knowingly change).

| # | Scenario | Signals that fire | What the user sees |
| --- | --- | --- | --- |
| A | Stream fails mid-reply, tab open | H8 (live catch site) + H9 writes `last_error` + partial row `status='error'` | Error card (live copy) with retry; `retryIncompleteTurn` REPLACEs the partial row (H3) |
| B | Same, then reload | `last_error` + partial row | Error card (persistent copy, different prose), retry REPLACEs. Consistent behavior, different copy |
| C | Same, but `last_error` write failed or was dismissed | Partial row only, no `last_error` | **Nothing.** H1 gap 1. The user sees a sentence that stops mid-thought, no retry |
| D | Overload after a tool round, then reload | Synthesizer heals the tail with a synthetic recovery assistant | Tool card is the last visible element, no banner, no retry. H1 masked by H10. Next send persists the healing rows |
| E | Reasoning-only stall | H1 fires (wire-valid shape), H7 REPLACEs | Cut-off banner + re-roll. Coherent |
| F | User row persisted, nothing else, no IDB draft | H1 `user` branch | Cut-off banner, retry CONTINUEs from the user message. Correct |
| G | User row + leftover IDB draft | H1 and H6 both fire | Interrupted-draft banner wins (richer text + discard). `retryInterrupted` CONTINUEs. Effectively correct, but the text and the discard affordance differ from scenario F for the same transcript shape |
| H | `asst_with_tool_calls` at tail, results never landed | H1 branch fires in-session; on reload the synthesizer heals first and masks it | In-session: generic cut-off banner. On reload: silently healed tool block + invisible recovery assistant. No banner either way after the heal, which is arguably correct but is accidental |
| I | User pressed Stop | `status='aborted'` rows excluded by H1/H2/H3 | No banner. Correct by design |
| J | ask_user pending sentinel | H1 suppresses only the pending shape | AskUserCard owns the interaction. Correct |
| K | Stream guard exhausts its re-rolls | Live: prefix-detect in Chat.svelte, copy A. Reload: `guard_exhausted` kind, copy B | Two slightly different cards for the same failure |
| L | Tab died mid-stream, stamp stale | `streamLikelyInFlight` expires after 760s | Banner appears up to 12.5 minutes late, then offers retry. Shared threshold, so H4/H6 agree |

The two scenarios where real users are underserved: C (the
documented gap - partial-text cutoff with no `last_error`) and D/H
(the synthesis masking, which turns "retry?" into silence). The
rest is copy divergence and structural debt that works today.

## Server-side context (not part of the unification, but load-bearing)

The server orchestrator (`getStreamingResponse.ts`) sets
`terminalKind` at every exit point and writes `threads.last_error`
for `terminalKind='error'`. A stale-row janitor
(`stream-probe.ts`) converts orphaned `status='streaming'` rows
older than 760s to `status='error'` with a `last_error` payload.
These are the source signals the browser heuristics consume; the
unification is browser-side but must understand what the server
produces. One acknowledged wart crosses the boundary: guard
exhaustion is collapsed to kind='internal' at the error-event
boundary and re-detected by message prefix downstream, twice.

## Scope of a unification

The unification (IMPLEMENTED 2026-08-27, see status note) produced:

1. **One classifier** - `classifyTail` in
   `src/lib/ui/completion-status.ts`, returning a typed verdict
   (settled, suspended, deliberate-stop, draft-pending, unanswered,
   interrupted-round, stalled, cut-off). It calls
   `isCutOffPartialText` (gap 1 fixed) and checks
   `isRecoveryMessage` on the tail (gap 2 - a healed tail classifies
   as `interrupted-round`, with one look-back for the pending
   ask_user sentinel, which the synthesizer also heals on read).

2. **One "is the turn still running?" gate** - the `turnPending`
   input in Chat.svelte's `completionStatus` derived: local slot
   sending, foreign claim, streaming row at tail, or fresh stamp,
   shared by every source (inconsistency 5).

3. **One retry handler** - `retryCompletion` reads the typed
   verdict's RetryIntent; the REPLACE-vs-CONTINUE decision is part
   of the verdict, computed once (inconsistency 7).

4. **One status arbiter** - `selectCompletionStatus` maps verdict +
   live error + persisted envelope + IDB draft to one descriptor
   with the IDB draft as a secondary enricher of the user-at-tail
   verdict (inconsistency 3).

5. **One error-text path** - both live (`StreamingError`, now a
   structured `{kind, detail?, retry?}` envelope) and persisted
   (`last_error`) errors derive copy from one table
   (`copyForErrorKind`), so the same failure renders the same card
   in-session and after reload (inconsistency 6).

6. **Cross-surface priority** - the tail surfaces collapse to one
   card by construction; the round-limit stop and commit-conflict
   outcomes route through the slot's live error (they ARE the turn's
   outcome) instead of the composer `.error-bar`; the `.error-bar`
   gained a dismiss button. Known remaining surfaces that can
   coexist with the card: slop notices (transient, intentional
   storytelling), the offline banner (fixed position, different
   content). At most one "what went wrong" card renders at the
   transcript tail; a DOM census in the logs warns if more than one
   ever materializes.

### Resolved decision points

1. **Behavior-changing where the old behavior was a hole.** The
   two scenarios where users saw nothing now get a card: the
   partial-text cutoff with no `last_error` (scenario C - the
   classifier now calls `isCutOffPartialText`) and the healed tail
   (scenario D/H - the classifier checks `isRecoveryMessage` and
   serves an interrupted-round card). Everything else keeps its
   prior presentation shape (error = danger card, tail verdicts =
   muted note), with unified copy.

2. **The healed-tail verdict lives in the classifier** (the
   `interrupted-round` verdict after a `isRecoveryMessage` tail
   check), not as a separate concern - less code, one data view.

3. **The IDB draft folded into the arbiter** as a secondary
   enricher of the unanswered verdict, with the discard affordance
   on the card.

### Remaining follow-ups

- QA re-runs of the affected use cases against the new card
  (`chat-cutoff-banner`, `chat-cutoff-retry`, `chat-recovery-banner`,
  `chat-stop-deliberate-abort`, `chat-message-ordering`) - baseline
  rows logged in each file's results table.
- The cross-surface pile (slop notices + offline banner + `.error-bar`
  coexisting with the card) is mitigated (`.error-bar` dismiss,
  round-limit routing) but not fully collapsed; a toast treatment
  for action errors is the remaining piece if stacking resurfaces.

## Related

- The draft-status fix (excluding `status='draft'` in H1)
  shipped with the user-message-editing feature. See
  [`../user-message-editing.md`](../user-message-editing.md).
- QA use cases: `docs/qa/use-cases/chat-cutoff-banner.md` and
  `chat-cutoff-retry.md` cover when the banner should and should
  not fire, and the retry flows.
