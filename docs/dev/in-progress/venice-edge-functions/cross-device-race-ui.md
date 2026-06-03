# Cross-device race-loser UI: design plan

## Synopsis

Add the "red-border-then-fade-out" treatment to the losing device when two devices simultaneously send new user messages on the same thread. v1+ polish for the streaming-root migration (see [`streaming-root.md`](./streaming-root.md)); not on the critical path. The function-side detection is straightforward; the work is the UI affordance and the cross-device state reconciliation.

## Purpose

The streaming-root migration's "ape mode" (cross-device viewing of an in-flight assistant response) ships in v1 as a free side effect of the disconnect-survival architecture. The harder half of cross-device coordination - what happens when two devices try to send a NEW user message at nearly the same moment - is deliberately deferred.

Why deferred:

- Correctness is automatic without UI work. The function picks one user message to act on by server-side `created_at`; the other becomes a no-op completion that returns immediately with a conflict signal. The thread does not double-respond.
- The race window is narrow. The browser-side claim coordinator (`ThreadClaimCoordinator`) gates composer enable/disable on the per-thread claim, so the window only opens at the exact moment a claim transitions (typically end of a turn).
- The polish item is UX-only: the loser device sees its message vanish or get demoted, which feels like a bug. The fix is a deliberate visual hand-off so the user understands what happened.

Why it matters:

- Future milestones (driver-A: server-side claim consolidation, or any path that moves the claim to a more permissive shape) could widen the race window.
- Two-laptop users hit this organically. The author's expected use case includes a phone PWA + desktop PWA pair, where this race is plausible weekly.

## Scope

In:

- Function-side detection of competing user messages at `/stream` entry.
- Conflict response shape and persistence of the loser's row in a queryable "superseded" state.
- Loser-device UI: red-border flash, fade-out animation, swap in the winner's user message + throbber.

Out:

- Splitting or merging the two user-message texts. Loser's text is discarded; if the user wants it, they retype.
- Detecting "clearly staggered" sends as competing. Only true overlaps (both POSTs in flight when the function decides) get the treatment.
- Composer mirroring across devices. The composer is a per-device local concern.
- The race-on-turn-continuation case (both devices try to send the SECOND message in a thread while the first response is still streaming). The streaming-root claim mechanism still gates composer for that case; this doc covers only the post-turn-terminal race.

## The race scenario

- T+0: A's previous assistant turn terminates. Claim releases.
- T+50ms: A's user types and sends "what about X?" A's browser INSERTs the user-message row.
- T+60ms: B's user types and sends "let's try Y." B's browser INSERTs its row.
- T+70ms: A's `/stream` POST arrives at the function. Body carries `userMessageId = A's row`.
- T+80ms: B's `/stream` POST arrives. Body carries `userMessageId = B's row`.
- Function reads the most-recent user message for the thread. Decides A wins (its row was first by `created_at`).
- Function returns `{conflict: true, winnerUserMessageId, winnerStreamChannel, winnerAssistantRowId}` to B's POST. Does NOT start a new completion for B.
- Function proceeds with A's turn as normal.

The winner-selection rule is **first by `created_at` wins**. Server clock authoritative (column default `now()`). Client-supplied timestamps not trusted. Tiebreaker on row uuid when timestamps collide.

## UX

**Winner (device A):** no visible change. Send proceeds, throbber appears, response streams via Broadcast. Same as a solo send.

**Loser (device B):**

1. Local INSERT of B's user message has already echoed through realtime, so the message is visible in B's UI.
2. ~100ms later, the `/stream` POST returns the conflict response.
3. B's UI marks the loser's row with a `racing-loser` CSS class. Animation: 1-frame red border flash, 600ms opacity fade to 0.
4. As fade completes: B's UI deletes the loser's row from the local store (the DB row was soft-marked `status='superseded'` on the server side; see "Persistence shape").
5. The winner's user message materializes via the existing messages-subscription postgres_changes feed (if not already showing).
6. B's UI auto-subscribes to `winnerStreamChannel`. The throbber appears and the streaming response begins arriving. B is now in ape mode for A's turn, which is the existing v1 path.

End state: B's screen looks identical to A's, just with a brief animation explaining the swap. B's user got a visual receipt for what happened without any modal or confirmation.

**Composer:** B's composer clears on send-success regardless of conflict outcome. The user's typed intent is in the DB row; the row's superseded state is the record. If the user wants to re-send, they retype. Preserving loser-text in the composer "for re-send" was considered and rejected as confusing.

## Detection mechanics

Function-side, at `/stream` entry, before kicking off any `getStreamingResponse` work:

1. Read the most-recent user message on the thread (admin client, `// RLS OFF: filter by userId`).
2. Three branches:
   - `lastUserMessageId === body.userMessageId` AND no `status='streaming'` row anchored to it: this device is the (sole or first-arriving) sender. Proceed to fresh `getStreamingResponse`.
   - `lastUserMessageId === body.userMessageId` AND a `status='streaming'` row exists anchored to it: this is a reconnect. Return the existing `{channelName, assistantRowId, completedSoFar}` envelope.
   - `lastUserMessageId !== body.userMessageId` AND the most-recent row is newer than `body.userMessageId`: this device is the loser. Mark `body.userMessageId`'s row `status='superseded'`. Return `{conflict: true, winnerUserMessageId, winnerStreamChannel, winnerAssistantRowId}`.

The function does NOT start a `getStreamingResponse` invocation for the loser path. The conflict path is synchronous and cheap.

Edge case: the winner's POST hasn't arrived yet when the loser's POST does. (Both INSERTs landed, but only the loser's `/stream` is at the function.) The function would see `lastUserMessageId !== body.userMessageId` but no `winnerStreamChannel` yet (the winner's `getStreamingResponse` hasn't created its assistant row). Resolution: include the winner's user-message-id in the conflict response and let the loser device subscribe to a deterministic channel name derived from the winner's user-message-id; the winner's `getStreamingResponse` will publish there. Synchronization happens via Broadcast subscriber arrival before publisher arrival, which is fine - Broadcast holds subscribers waiting for publishes.

## Persistence shape

No fundamentally new schema; one new enum value added alongside the streaming-root v1 extension:

- `messages.status` enum gains `'superseded'`. Existing values: `'streaming' | 'complete' | 'aborted' | 'error' | 'suspended_for_ask_user'`.
- All message-render queries (`getThreadMessages`, the messages subscription's filter, the search index) treat `superseded` rows as deleted by default. A `?includeSuperseded=true` option exists for debug views.
- Soft-delete is the choice over hard-delete: history preserved, replay possible, "where did my message go?" debuggable. Cost is one column-filter on every render query.

## Open questions

- **Render-time filtering vs. RLS policy.** Should `status='superseded'` be filtered at the application layer or at the RLS-policy layer? Application is simpler (one `.neq('status', 'superseded')` in the query); RLS-policy is uniform across every consumer. Lean application for v1 plus this doc; revisit if a future caller forgets the filter.
- **Tie-breaking when `created_at` collides.** Microsecond collisions are rare but possible (especially when two devices use shared NTP-disciplined clocks and submit within the same ms). Tiebreaker on row uuid lexical sort. Document the rule in the function source so reviewers can find it.
- **Loser device offline at the moment of supersede.** Loser device comes back online to find its own outgoing message has `status='superseded'`. UI behavior: render the fade-out animation as if just received. Detection: messages-subscription change handler watches for transitions to `superseded` on rows the local user authored.
- **Animation duration and feel.** 600ms is a guess; prototype against the real flow. Avoid anything jarring on mobile where the animation runs alongside content reflow as the winner's message slots in.
- **Cancel-then-race.** B starts a send, hits cancel before the `/stream` POST goes out. The local INSERT might have already fired. Cancel marker (currently a local-only signal) needs to either prevent the row from being committed, or override the supersede-fade with a deliberate-delete UI. Lean the latter - the user took explicit action.
- **Conflict response format vs. streaming envelope.** Should conflict be a distinct HTTP status (409) or a 200 with a discriminator field? Lean 200 + discriminator for uniformity with the streaming envelope's existing `{channelName, assistantRowId, completedSoFar}` shape. Conflict is just a different terminal kind of envelope.
- **Telemetry / observability.** Worth logging supersede events for debugging UX issues. Cheap to add; one row in a logs table per supersede. Not blocking but flag at implementation.

## File inventory

- **supabase/functions/venice/index.ts** - `/stream` handler adds the lookup-most-recent-user-message + branch logic. Conflict response shape mirrors the streaming envelope.
- **supabase/functions/venice/getStreamingResponse.ts** - no change directly, but the entry condition (`lastUserMessageId === body.userMessageId`) is checked before invocation.
- **supabase/schema.sql** - extend `messages.status` enum with `'superseded'`. Update message-render queries / RPCs that filter by status to exclude superseded by default.
- **src/lib/venice.ts** - `streamChat` envelope-handling adds the `conflict` branch. Returns a typed conflict signal to the caller instead of beginning the subscribe-and-consume loop.
- **src/lib/chat-loop.ts** - new error/conflict path: a conflict response triggers the loser-UI flow (mark local row, animate, subscribe to winner's channel for ape-mode view of the winner's turn).
- **src/screens/Chat.svelte** - new CSS class for `racing-loser` (red-border + 600ms opacity fade). Handler for `status='superseded'` rows arriving via the messages subscription (covers the offline-then-online case). Auto-resubscribe to `winnerStreamChannel` on conflict response.
- **docs/dev/cross-device-race-loser.md** - new (or `docs/dev/exchange.md` extension). End-state contract document for future readers, with the detection rule, the UI affordance, and the offline-reconciliation behavior.
- **docs/dev/in-progress/venice-edge-functions/streaming-root.md** - Section 3 ("Cross-device 'ape mode'") gets a link to this doc.
- **docs/dev/in-progress/venice-edge-functions/README.md** - add a row pointing at this plan.

## Sequencing

Lands AFTER streaming-root v1 is shipped and stable. Not gated on driver-A. Could be the same PR cycle as streaming-root if implementation goes fast; more likely a follow-up because the UI animation work has its own iteration loop independent of the function logic. Once landed, the streaming-root v1 cut line shifts: the "race-loser UI for competing user messages" item moves from "v1+ excluded" to "shipped."

## v1+ cut line

**Ships:** function-side conflict detection at `/stream` entry, `superseded` enum value on messages, conflict-response envelope shape, loser-UI animation, winner-channel auto-subscribe on conflict, offline-then-online supersede animation, defaulted `superseded` filtering on render queries.

**Excludes:** loser-text preservation in composer for re-send (deliberate), composer state mirroring across devices (orthogonal), the wider "claim consolidation" driver-A migration (separate plan).
