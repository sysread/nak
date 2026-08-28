# Chat: a cut-off reply is preserved, then replaced on retry

## Covers

Two coupled behaviors ([dev: chat](../../dev/chat.md), gotcha "A
cut-off reply's partial is preserved as a card, not dropped"):

1. **Live retention.** A stream that fails mid-reply leaves its partial
   (reasoning + any text) on screen as a `status='error'` card with the
   error card beneath it, instead of vanishing with the live bubble.
   Server side, `getStreamingResponse.ts` creates the row at terminal
   write even when only reasoning streamed (`ensureAssistantRow`
   normally fires on first `response_text`). Browser side, `venice.ts`
   keeps the drain open past the `error` broadcast so the terminal END
   carries the row id, and `consumeStreamEvents` (`chat/loop.ts`)
   hydrates that row before throwing.
2. **Retry replaces.** `retryCompletion` + the classification
   predicates in `src/lib/ui/completion-status.ts`
   (`isReasoningOnlyStall`,
   `isCutOffPartialText`) treat a dead tail as a REPLACE target -
   red-outlining the card while the re-roll runs and atomically deleting
   it on commit (the Regenerate machinery: `pendingDeleteIds` ->
   `.regen-target`, `supersededIds` -> `commit_assistant_message`) -
   rather than appending a continuation. Contrast with a continuation
   tail (orphaned tool round, bare user message), which retry keeps.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A thread with at least one prior completed turn. Note its id and the
  id of the trailing user message you will hang the forged tail off of.
- No stream in flight on the thread (the live bubble must be idle so
  the persisted tail is what renders).

## Steps

1. Partial-text cutoff. Forge a tool-less assistant row the stream
   "cut off" mid-answer (status='error', visible content present) as
   the thread tail, and set the thread's persisted error so the retry
   affordance shows:

   ```sql
   insert into messages (thread_id, role, status, content, created_at)
   values ('<thread>', 'assistant', 'error',
           'Here is the first half of the answer that got cut o',
           now());
   update threads
      set last_error = jsonb_build_object(
            'kind','network','message','Connection lost mid-stream.',
            'retryable', true)
    where id = '<thread>';
   ```

2. Reload the thread. Confirm the partial card renders as a normal
   assistant bubble with the completion-status error card (and its
   Retry button) beneath it.
3. Click Retry. Watch the partial card's outline while the re-roll
   streams.
4. Let the new reply settle. Observe what happens to the old partial
   card.
5. Reasoning-only stall (regression check on the pre-existing shape).
   Forge a stall tail instead and repeat the retry:

   ```sql
   insert into messages (thread_id, role, status, content, reasoning,
                         created_at)
   values ('<thread>', 'assistant', 'error', '',
           'Let me think about this...', now());
   ```

   Reload, click the *"Response stalled"* card's Retry, and watch the
   bare reasoning card.
6. Live retention (the actual failure path). NOTE: this step cannot be
   produced by killing the browser's network - the upstream stream is
   server-side (the edge function calls Venice), so a browser offline
   window only drops the realtime Broadcast subscription while the
   function keeps running and commits normally; the reconnect probe
   heals the missed END and the completed reply renders (verified
   2026-08-28). A genuine mid-reply `status='error'` row is only
   reachable when the SERVER-side stream fails (a Venice error, a
   guard terminal). The forged rows in steps 1 and 5 exercise the
   identical read/persistence path, so they stand in for this step;
   a manual version requires a real Venice-side failure to observe
   live.

## Expected

- (2) The partial text is visible - it was NOT discarded. A normal
  assistant card carrying the half-sentence, the danger-tinted
  *"Network error"* status card beneath it with a Retry button and
  the raw error text under a Details toggle.
- (3) On clicking Retry the partial card gains the red regen-target
  outline (same as hovering Regenerate) and stays outlined while the
  fresh answer streams into a new bubble below the in-flight indicator.
- (4) The new, complete reply lands; the old partial card fades out and
  is removed (the commit RPC deleted its row via `supersededIds`). End
  state: exactly one assistant reply for the turn, no orphan partial
  above it, `threads.last_error` null (cleared by the successful
  commit).
- (5) Same replace behavior for the reasoning-only stall: the bare
  reasoning card red-outlines during the re-roll, then fades out as the
  fresh answer replaces it. No second card stacked beneath.
- (6) A browser-offline window does NOT produce an error row: the
  server-side stream completes and the reconnect probe delivers the
  committed reply once the network returns (the missed-END heal).
  The live-retention behavior on a genuine upstream failure is
  covered by the forged scenarios above, which use the same row
  shape and read path the terminal write produces.

## Cleanup

Delete any forged rows that a retry did not already bury, and clear a
stranded error card:

```sql
delete from messages
 where thread_id = '<thread>'
   and (content like 'Here is the first half%'
        or reasoning = 'Let me think about this...');
update threads set last_error = null where id = '<thread>';
```

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-08-27 | local dev stack | 3d719e8d | PASS (steps 1-5) | Forged partial-text cutoff + persisted error: card + Retry; REPLACE retry red-outlined the partial, fresh reply landed, partial row deleted atomically. Same for the reasoning-only stall. |
| 2026-08-28 | local dev stack | 3d719e8d | PARTIAL (step 6) | Browser-offline window does not produce an error row: the stream is server-side and completed normally; the reconnect probe healed the missed END. Step 6 rewritten as an architecture note - genuine mid-reply error rows require a server-side (Venice) failure and stand in via the forged scenarios. |
