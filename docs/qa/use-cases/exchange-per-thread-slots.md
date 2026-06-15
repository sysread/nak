# Exchange: per-thread slots, navigate-away and concurrent streams

## Covers

The per-thread streaming state machine
([dev: exchange](../../dev/exchange.md)): `ExchangeSlot` /
`ExchangeStore` keyed by thread, and the slot-isolation behavior
that survives navigating away mid-stream. Sits alongside
[chat-streaming-turn](./chat-streaming-turn.md) (a single turn end
to end) and [threads-management](./threads-management.md) (the
cross-device reply lock); this case is the single-device, single-
user gap neither covers - navigate-away-mid-stream-and-back, and
two threads streaming at once without their throbbers or text
bleeding across.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user
  (`dev@nak.local` / `devpass123`).
- Two threads, A and B, each with at least one prior completed turn
  so neither shows a generation-placeholder title. Note their ids.
- A model slow enough that a reply takes several seconds to stream -
  long enough to switch threads while text is still arriving. If
  replies finish too fast to catch mid-stream, ask for a longer
  answer (`Write three paragraphs about ...`).
- Optional, for the background-completion dot: leave the browser
  tab in the foreground and confirm the notifications feature is
  enabled in settings. With the tab visible the in-app unread dot
  is the expected signal, not an OS banner.

## Steps

1. Open thread A. Send a prompt that will stream for several
   seconds (`Write three paragraphs about tide pools.`).
2. While A's reply is still streaming - text actively growing in
   the assistant bubble, the `Thinking` throbber present - click
   thread B in the drawer to navigate away.
3. In thread B, immediately send a second long prompt
   (`Write three paragraphs about lighthouses.`). Watch B begin to
   stream its own reply.
4. While B is still streaming, switch back to thread A.
5. Observe thread A: either its reply is still streaming (text
   resumes from wherever the background buffer reached) or it has
   already completed into a finished assistant message.
6. Switch back to thread B and confirm B's reply is intact and
   unrelated to A's content.
7. Repeat the A/B switch a couple more times while at least one
   side is still streaming, to confirm neither thread's throbber or
   partial text ever renders under the other thread's transcript.

## Expected

- (2) Navigating to B mid-stream does NOT abort A. A's turn keeps
  running in the background - its `ExchangeSlot` stays `sending`
  even though it is no longer the active thread. Nothing about A's
  in-flight reply (throbber, partial text) appears in B's view.
- (3) B starts its own independent stream. The composer in B was
  not blocked by A's in-flight turn - the send guard is per-thread,
  not global (`if (activeSlot?.sending) return;` keys on the active
  thread's slot only). Both A and B are now streaming concurrently.
- (4-5) Returning to A shows A's own content only - the lighthouses
  text from B never appears in A. If A was still streaming, the
  bubble picks up the in-progress text at the point the buffer had
  reached at the moment of the switch (the slot's `streamingText`
  buffer is what the bubble binds to). If A finished while
  backgrounded, A shows a complete assistant message and no
  throbber.
- (5, background completion) If A completed while you were viewing
  B, thread A in the drawer carries an unread dot (with the tab in
  the foreground the in-app dot is the signal; an OS notification
  only fires when the tab is hidden). Opening A clears its dot.
- (6) B's reply is the lighthouses answer, never mixed with A's
  tide-pools content.
- (7) Across repeated switches, the `Thinking` throbber and any
  partial streaming text always render under the correct thread's
  transcript and never under the other thread. No empty bordered
  streaming card flashes in a thread whose slot is idle.

## Cleanup

- Let both replies finish (or use the composer stop control to
  abort the active one); confirm both threads settle to a complete
  assistant message with no lingering throbber.
- Clear any unread dots by opening each thread.
- Delete threads A and B if they are not otherwise useful.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
