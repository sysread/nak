# Chat: retrying a cut-off response replaces it

## Covers

The dead-turn retry path ([dev: chat](../../dev/chat.md)):
`retryIncompleteTurn` in `src/screens/Chat.svelte` and the
classification predicates in `src/lib/ui/incomplete-turn.ts`
(`isReasoningOnlyStall`, `isCutOffPartialText`). Specifically, that a
retry of a DEAD tail REPLACES it - red-outlining the card while the
re-roll runs and atomically deleting it on commit (the Regenerate
button's machinery: `pendingDeleteIds` -> `.regen-target`,
`supersededIds` -> `commit_assistant_message`) - rather than appending
a continuation beneath it. Contrast with a continuation tail (orphaned
tool round, bare user message), which the retry keeps and builds on.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A thread with at least one prior completed turn. Note its id and the
  id of the trailing user message you will hang the forged tail off of.
- No stream in flight on the thread (the live bubble must be idle so
  the persisted tail is what renders).

## Steps

1. Partial-text cutoff. Forge a tool-less assistant row the stream
   "cut off" mid-answer (status='error', visible content present) as
   the thread tail, and set the thread's error banner so the retry
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
   assistant bubble with the error banner (and its refresh-arrow Retry
   button) beneath it.
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

   Reload, click the "The response appears to have been cut off"
   banner's Retry, and watch the bare reasoning card.

## Expected

- (2) The partial text is visible - it was NOT discarded. A normal
  assistant card carrying the half-sentence, error banner beneath it
  with a Retry (refresh-arrow) button.
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

## Cleanup

Delete any forged rows that a retry did not already bury, and clear a
stranded banner:

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
