# Chat: one recovery banner at the transcript tail, never stacked

## Covers

The single-surface recovery banner
([dev: exchange](../../dev/exchange.md), "One recovery banner, not
three"). The tail can satisfy several "this turn did not finish,
retry?" conditions at once; `selectRecoveryBanner`
(`src/lib/ui/recovery-banner.ts`) collapses them to exactly one
banner by precedence: **error (red) > interrupted-draft > cut-off
(muted)**.

The load-bearing overlap this proves: an orphaned IndexedDB draft
only exists when the thread tail is a `user` row (see
`selectThread`'s orphan check - it requires `lastMsg.role === 'user'`
and `draft.userMessageId === lastMsg.id`). That same user-row tail
also drives `incompleteTurnTail`, so an interrupted draft ALWAYS
co-occurs with the generic cut-off tail. Rendered independently the
two stacked as two near-identical retry boxes; the precedence here is
what guarantees one.

Sits alongside [chat-cutoff-retry](./chat-cutoff-retry.md) (the
preserve-partial-then-replace-on-retry behavior of the cut-off /
error path) and [exchange-per-thread-slots](./exchange-per-thread-slots.md)
(the `respondingElsewhere` lock). This case owns the
"which single banner wins, and never two" contract neither covers.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user
  (`dev@nak.local` / `devpass123`).
- A thread with at least one prior completed turn. Note its id
  (`<thread>`). The forges below append a fake tail to it; the prior
  turn just keeps the thread from rendering as empty.
- No stream in flight on the thread (the live bubble must be idle so
  the persisted tail is what renders).
- DevTools open (the interrupted-draft forge writes IndexedDB from the
  console; `nak-drafts` -> `completions` is created on first app run,
  so the object store already exists).

## Steps

1. **Cut-off alone (no draft, no error).** Forge a reasoning-only
   stall tail - `incompleteTurnTail` fires, `displayedError` is null,
   no draft:

   ```sql
   insert into messages (thread_id, role, status, content, reasoning, created_at)
   values ('<thread>', 'assistant', 'error', '',
           'Let me think about this...', now());
   ```

   Reload the thread. Confirm what renders at the tail.

2. **Interrupted draft over cut-off (the overlap that used to stack).**
   Remove the stall row from step 1, then forge a `user`-row tail and
   an IndexedDB draft keyed to it. First the row (note the returned
   id as `<user-msg>`):

   ```sql
   delete from messages
    where thread_id = '<thread>' and reasoning = 'Let me think about this...';
   insert into messages (thread_id, role, content, created_at)
   values ('<thread>', 'user', 'A question whose answer never arrived.', now())
   returning id;
   ```

   Then forge the draft from the DevTools console (substitute both ids):

   ```js
   const req = indexedDB.open('nak-drafts', 1);
   req.onsuccess = () => {
     const tx = req.result.transaction('completions', 'readwrite');
     tx.objectStore('completions').put({
       threadId: '<thread>',
       userMessageId: '<user-msg>',
       modelId: 'venice-uncensored',
       text: 'Here is the half of an answer that never finished',
       reasoning: '',
       startedAt: Date.now() - 60000,
       updatedAt: Date.now() - 60000,
     });
     tx.oncomplete = () => console.log('draft forged');
   };
   ```

   Reload the thread. Count the banners and read which one shows.

3. **Dismiss the draft, see the tail fall through to cut-off.** With
   the interrupted-draft banner from step 2 showing, click its `x`
   (Dismiss). Observe what replaces it.

4. **Error over everything.** Re-forge the draft (repeat step 2's
   console snippet - dismissing in step 3 deleted it), keeping the
   same `user`-row tail, then set a retryable persisted error:

   ```sql
   update threads
      set last_error = jsonb_build_object(
            'kind','network','message','Connection lost mid-stream.',
            'retryable', true)
    where id = '<thread>';
   ```

   Reload. Count the banners and read which one shows.

5. **Function still finishing - no recovery banner at all.** Clear the
   error (`update threads set last_error = null where id = '<thread>';`),
   keep the `user`-row tail and the draft, then forge a live foreign
   response claim (simulating the detached edge run still streaming
   server-side under a holder id that isn't this page's):

   ```sql
   update threads
      set response_holder_id = gen_random_uuid()::text,
          response_claim_expires_at = now() + interval '60 seconds'
    where id = '<thread>';
   ```

   Reload within the 60s window. Observe the tail.

## Expected

- **(1)** Exactly ONE muted, italic banner: *"The response appears to
  have been cut off. Click to retry."* with a single refresh-arrow
  Retry button and NO dismiss. (Retrying a reasoning-only stall
  REPLACES it - covered by [chat-cutoff-retry](./chat-cutoff-retry.md);
  here we only assert the banner identity.)
- **(2)** Exactly ONE muted banner: *"Previous response was
  interrupted. Retry to generate a new one."* with a refresh-arrow
  Retry AND an `x` Dismiss. The cut-off note does NOT also appear -
  even though the user-row tail satisfies `incompleteTurnTail` too,
  the interrupted-draft source wins precedence. (Before the
  single-surface change this state rendered both banners stacked.)
- **(3)** Dismissing deletes the IndexedDB draft and clears
  `interruptedDraft`. The user-row tail is unchanged, so
  `incompleteTurnTail` still holds and the banner does not vanish -
  it falls through to the lower-precedence cut-off banner (*"The
  response appears to have been cut off."*, Retry only, no dismiss).
  This is correct: discarding the in-memory partial does not repair
  the orphaned tail, which still warrants a retry affordance.
- **(4)** Exactly ONE banner: the red `.msg-error` alert with the
  *Connection lost mid-stream.* text (and a kind heading), a Retry
  button (the error is flagged `retryable`), and a Dismiss. Neither
  the interrupted-draft nor the cut-off note appears - the error
  outranks both.
- **(5)** NO recovery banner of any kind. A live foreign claim means
  the detached edge function is still producing the reply, so the
  tail only LOOKS incomplete from here; the observer "Scanner" wait
  bubble shows instead and the assistant row is expected to arrive
  over realtime. Past the 60s expiry (reload again after it lapses)
  the claim is dead and step 2's interrupted-draft banner returns.

## Cleanup

Delete any forged rows and clear the forged thread state:

```sql
delete from messages
 where thread_id = '<thread>'
   and (content = 'A question whose answer never arrived.'
        or reasoning = 'Let me think about this...');
update threads
   set last_error = null,
       response_holder_id = null,
       response_claim_expires_at = null
 where id = '<thread>';
```

Delete the forged IndexedDB draft from the console (if a dismiss or
retry did not already bury it):

```js
const req = indexedDB.open('nak-drafts', 1);
req.onsuccess = () => {
  const tx = req.result.transaction('completions', 'readwrite');
  tx.objectStore('completions').delete('<thread>');
};
```

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
