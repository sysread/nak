# Chat: queueing a message while a reply is streaming

## Covers

The send-while-streaming queue ([dev: chat](../../dev/chat.md), entry
point "Queued messages" and gotcha "The queue drains from two turn-settled
tails"; [dev: exchange](../../dev/exchange.md), `ExchangeSlot.queued`):

1. **The submit-modifier Enter queues, it does not cancel.** With a reply
   in flight, Cmd/Ctrl/Shift+Enter banks the composer's contents on the
   thread's `ExchangeSlot.queued` and clears the composer. The stream
   keeps running.
2. **The button still cancels.** The send button stays in stop mode
   throughout. With messages queued it gains a count badge and its
   tooltip becomes "Stop and send N queued message(s) now" - the click
   still aborts, but the queue fires immediately afterward instead of
   waiting for a reply the user has stopped caring about.
3. **A stop keeps completed work.** Cancelling with a queue pending
   persists the same `status='aborted'` row and the same already-finished
   tool rows a bare stop does (see
   [chat-stop-deliberate-abort](./chat-stop-deliberate-abort.md)); the
   queued user rows land after them, not instead of them.
4. **A natural finish drains too.** Letting the reply complete on its own
   fires the queue at the tail of the same turn, with no click.
5. **Order and anchoring.** Multiple queued messages persist as separate
   `role='user'` rows in queue order, and the new turn anchors on the
   LAST of them, so `commit_assistant_message` does not read the batch's
   own siblings as a competing device's send.
6. **An errored turn holds the queue.** A turn that ends on an error
   (rate-limit exhaustion, a foreign response claim) leaves the queue
   intact and visible rather than burying the banner under a fresh turn.
7. **A background drain stays in its own thread.** The queue is
   per-thread (`ExchangeSlot.queued`), and its drain can fire while the
   user is looking at a different conversation. The rows it persists must
   land in their own thread's transcript, never in whichever one happens
   to be open - `persistUserTurn` gates its `appendMessage` on the active
   thread for exactly this.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A model slow enough to type during (a reasoning-heavy tier helps).
  Note the thread id.
- For step 7, a second browser (or a private window with a distinct
  `localStorage` holder id) signed in as the same user.

## Steps

1. Queue during a stream. Send a prompt. While the answer is streaming,
   type a second message and press Cmd+Enter (macOS) / Ctrl+Enter.
   Observe the composer, the transcript tail, and the send button.
2. Let it finish. Do not touch the button. Wait for the reply to
   complete.
3. Check what landed:

   ```sql
   select role, status, left(content, 40) as content_head, created_at
     from messages
    where thread_id = '<thread>'
    order by created_at desc
    limit 4;
   ```

4. Queue two, then stop. Send a fresh prompt; while it streams, queue two
   different messages (Cmd+Enter twice). Confirm the badge reads `2`,
   then click the stop button.
5. Re-run the query from step 3 with `limit 6`.
6. Un-queue. Send a prompt, queue one message, then click the `x` on its
   card - first with the composer empty, then (after re-queueing) with
   something else typed in the composer.
7. Errored turn. On the second browser, start a reply on the same thread.
   Back on the first browser, while that foreign claim is live, send a
   message so it fails with "Another device is responding", then queue a
   message against it.
8. Background drain. On thread A, send a prompt and queue a distinctive
   message against it ("QUEUED-ON-A"). Before the reply finishes, switch
   to a different conversation (thread B) and watch B's transcript while
   A's turn settles. Then switch back to A.

## Expected

- (1) The composer empties. A card appears below the "Thinking" throbber
  under the heading "Queued - sends when this reply finishes", styled as
  a dimmed, dashed user bubble. The reply keeps streaming - the stream
  does **not** abort. The button keeps its filled square and gains a `1`
  badge; its tooltip reads "Stop and send 1 queued message now". The
  composer placeholder reads "⌘-enter queues" / "ctrl-enter queues".
- (2) When the reply finishes, the queued card disappears, the queued
  text appears as a real user message, and a new reply starts streaming -
  with no click.
- (3) Rows in order: the first assistant reply (`status='complete'`), then
  the queued `role='user'` row, then the second assistant reply.
- (4) Clicking stop aborts the in-flight reply promptly. Both queued
  messages then send.
- (5) Rows in order: the aborted assistant row (`status='aborted'`,
  content ending `--- user interrupted response`) plus any tool rows the
  turn had already completed, then BOTH queued `role='user'` rows in the
  order they were queued, then the new assistant reply. No
  "This conversation was updated on another device" conflict banner.
- (6) With the composer empty, the `x` returns the text (and any
  attachment chips) to the composer for editing. With something already
  typed, the `x` discards the queued entry and leaves the typed draft
  untouched.
- (7) The failed send paints the "Another device is responding" banner.
  The queued card stays on screen after the foreign turn ends - the queue
  does **not** auto-fire into the error - and drains only when a later
  turn on this device succeeds.
- (8) Thread B's transcript never shows "QUEUED-ON-A", and no queued card
  appears under B while A drains. Returning to A shows the queued message
  as a real user row with its reply beneath it. Confirm the row's home in
  the DB:

  ```sql
  select thread_id, left(content, 20) as content_head
    from messages
   where content like 'QUEUED-ON-A%';
  ```

  It must name thread A. A row on B, or the text appearing in B's
  transcript, is the ungated-`appendMessage` regression.

## Cleanup

Delete the turns these steps produced, or delete the whole test thread
from the drawer.

```sql
delete from messages where thread_id = '<thread>';
```

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
