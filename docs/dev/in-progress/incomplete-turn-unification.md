# Incomplete-turn detection unification (spike)

> **Status: investigation. No code written.** This doc
> records the findings of a spike into the incomplete-turn /
> cut-off / interrupted-detection heuristics in the chat
> transcript path. The goal is to plan a unification of the
> multiple overlapping, inconsistent heuristics into a single
> coherent system. When the unification ships, graduate the
> design into a permanent `docs/dev/` doc and retire this file.

## SYNOPSIS

The chat transcript path has seven separate heuristics that
detect "the last turn didn't finish" - a failed completion, an
interrupted stream, an orphaned tool round. They overlap, use
different signals, and in some cases contradict each other. This
spike maps all of them, identifies the inconsistencies, and
frames the scope of a unification effort.

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

## The seven heuristics

### H1: `classifyIncompleteTurnTail` - transcript-shape classifier

**File:** `src/lib/ui/incomplete-turn.ts:126`

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

### H2: `isReasoningOnlyStall` - dead-turn predicate

**File:** `src/lib/ui/incomplete-turn.ts:52`

**Detects:** `role='assistant'` AND `status !== 'aborted'` AND no `tool_calls` AND content is empty AND reasoning is non-empty. The model emitted chain-of-thought but no visible answer.

**Used by:** `classifyIncompleteTurnTail` (H1) to qualify the tail, and `retryIncompleteTurn` (H7) to decide REPLACE vs CONTINUE.

### H3: `isCutOffPartialText` - dead-turn predicate (DISCONNECTED)

**File:** `src/lib/ui/incomplete-turn.ts:84`

**Detects:** `role='assistant'` AND no `tool_calls` AND
`status='error'` AND content is non-empty.

**Used by:** Only `retryIncompleteTurn` (H7). NOT called by
`classifyIncompleteTurnTail` (H1). The predicate that classifies a
partial-text cutoff exists, but the classifier that decides whether
to show the banner does not use it.

### H4: `incompleteTurnTail` derived - session-gated transcript verdict

**File:** `src/screens/Chat.svelte:6517` (the `incompleteTurnTail` derived)

**Detects:** Calls H1 (`classifyIncompleteTurnTail`) but first gates
on four session-state conditions:

1. `activeSlot?.sending` - turn in progress
2. `activeSlot?.streamingError` - live error already showing
3. `respondingElsewhere` - another device holds the response claim
4. `streamLikelyInFlight(stream_started_at)` - server-side turn
   still running

**Feeds:** The `cutOff` source into `selectRecoveryBanner` (H5).

### H5: `displayedError` + `selectRecoveryBanner` - error card and banner selector

**File:** `src/screens/Chat.svelte:6565` + `src/lib/ui/recovery-banner.ts:88`

**Detects:** `displayedError` combines two sources in precedence:

1. `activeSlot?.streamingError` - session-local, set by 8 different
   catch sites in `runExchange` (H8)
2. `parseLastError(currentThread?.last_error)` - persistent, written
   by the server orchestrator on `terminalKind='error'` (H9)

`selectRecoveryBanner` then picks one banner from three sources by
precedence: `error > interruptedDraft > cutOff`.

### H6: `interruptedDraft` - orphaned IndexedDB draft detection

**File:** `src/screens/Chat.svelte:2704`

**Detects:** At thread-load time, checks ALL of:

- Last message is a user row
- No server turn in flight (`streamingTail != null ||
  streamLikelyInFlight(...)`)
- This device isn't already producing the turn
- An IndexedDB draft exists for this thread whose `userMessageId`
  matches the last message

**Overlap with H1:** Both detect "user message at tail with no
assistant reply." H6 additionally requires an IDB draft. When both
fire, H6 wins precedence in `selectRecoveryBanner`. When only H1
fires (user at tail, no IDB draft), the `cutOff` banner shows with
generic text.

### H7: `retryIncompleteTurn` - retry handler with its own heuristic

**File:** `src/screens/Chat.svelte:5683`

**Detects:** Walks backward to find the user message, then checks
the tail:

- `isReasoningOnlyStall(tail) || isCutOffPartialText(tail)` -> dead
  turn, REPLACE (sets `pendingDeleteIds`, `supersededIds`)
- Otherwise -> CONTINUE (no deletion)

**Inconsistency:** Called from BOTH the `displayedError` retry
button (H5) and the `cutOff` retry button (H4). This is where H3
finally gets used - but only AFTER the banner has already been shown
via a different heuristic.

A separate `retryInterrupted` function (line 5277) handles H6's
retry path. It always CONTINUEs - no deletion - because the
interrupted draft path assumes nothing was produced to replace. Two
retry functions for the same action with different deletion logic.

### H8: `streamingError` - in-session live error (8 catch sites)

**File:** `src/screens/Chat.svelte` - multiple sites in `runExchange`

**Detects:** Eight distinct catch points in the exchange flow: claim acquire failure, another device holds claim, pre-exchange failure, commit conflict, claim preemption, rate-limit, guard exhaustion, generic fallback. Each sets `slot.streamingError` with text and optional retry.

**Feeds:** H5's `displayedError` as the highest-precedence source. Also gates H4 (incompleteTurnTail suppresses when streamingError is set).

### H9: Server-side `terminalKind` assignment

**File:** `supabase/functions/venice/getStreamingResponse.ts`

**Detects:** Sets `terminalKind` at every exit point: `'error'` (wall timeout, stream error, round limit, catch block, commit conflict), `'aborted'` (user cancel), `'complete'` (happy path), `'suspended_for_ask_user'`.

**Produces:** Row status transition + `threads.last_error` write (for `'error'` only) + END event with `terminalKind` published to the Broadcast channel.

**Relationship:** The single server-side source that feeds two parallel browser paths: `last_error` -> `displayedError` (H5, persistent) and END event -> `streamingError` (H8, ephemeral). They can disagree when the END event fires into a dead socket or `last_error` write fails.

### H12: `synthesizeRecoveryMessages` - wire-shape repair (MASKS H1)

**File:** `src/lib/conversation-recovery.ts`

**Detects:** Wire-format-invalid shapes (trailing tool row, trailing
assistant-with-tool_calls missing results, mid-conversation partial
fan-in).

**Effect:** Inserts synthetic recovery rows (tool results + recovery
assistant) to make the wire shape valid. These carry `synthetic:
true` and are filtered from the UI by `buildMessageBlocks`.

**The masking problem:** When the original tail is a `tool` row, the
synthesizer inserts a synthetic recovery assistant after it. H1
then sees the synthetic assistant as the last message (`role=
'assistant'`, content = recovery body, no tool_calls, status=null)
and returns null - no banner. But the user sees the tool result card
as the last visible element with no reply. The classifier sees a
settled tail; the user sees an incomplete one.

## The inconsistencies (summary)

1. **`isCutOffPartialText` is disconnected from the classifier.** The
   predicate exists, the retry handler uses it, but the classifier
   that decides whether to show the banner never calls it. A
   `status='error'` assistant with content is invisible to H1.

2. **`synthesizeRecoveryMessages` masks the classifier.** Synthetic
   rows make H1 see a "settled" tail while the user sees an
   incomplete one. H1 does not check `isRecoveryMessage`.

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
   `streamingTail != null || streamLikelyInFlight(...)`. H4 checks
   only `streamLikelyInFlight(...)`. Different gates for the same
   question.

6. **Guard exhaustion detected by string prefix in two places.**
   Server collapses it to `kind='internal'`; browser re-detects by
   `err.message.startsWith('Stream guard "')`. Different banner text
   for the same failure depending on in-session vs reload.

7. **Two retry functions with different REPLACE vs CONTINUE logic.**
   `retryInterrupted` (H6's path) always CONTINUEs.
   `retryIncompleteTurn` (H4/H5's path) checks H2+H3 to decide. Same
   action, different deletion heuristics.

## Server-side context (not part of the unification, but load-bearing)

The server orchestrator (`getStreamingResponse.ts`) sets
`terminalKind` at every exit point and writes `threads.last_error`
for `terminalKind='error'`. A stale-row janitor
(`stream-probe.ts`) converts orphaned `status='streaming'` rows
older than 760s to `status='error'` with a `last_error` payload.
These are the source signals the browser heuristics consume; the
unification is browser-side but must understand what the server
produces.

## Scope of a unification

The unification should produce:

1. **One classifier** that reads the transcript tail and returns a
   typed verdict (settled, cut-off-with-replace, cut-off-with-
   continue, deliberate-stop, suspended, draft-pending). The
   classifier should call `isCutOffPartialText` (fixing gap 1) and
   check `isRecoveryMessage` on the tail (fixing gap 2).

2. **One "is the turn still running?" gate** shared by all banner
   sources, instead of H4 and H6 computing it differently (fixing
   inconsistency 5).

3. **One retry handler** that reads the typed verdict to decide
   REPLACE vs CONTINUE, instead of two functions with separate
   logic (fixing inconsistency 7).

4. **One banner selector** that maps the typed verdict + session
   state to a single banner (or none), with the IDB draft check as
   a secondary signal rather than a separate heuristic (fixing
   inconsistency 3).

5. **One error-text path** so the same failure produces the same
   banner text whether the user is in-session or returning after a
   reload (fixing inconsistency 6).

The server-side signals (`terminalKind`, `last_error`,
`stream_started_at`) are the inputs; the unification is
browser-side. No server changes needed.

## Related

- The draft-status fix (excluding `status='draft'` in H1) is
  already on the `user-message-editing` branch.
- QA use case: `docs/qa/use-cases/chat-cutoff-banner.md` covers
  when the banner should and should not fire.
