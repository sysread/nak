# Chat: refresh during the pregame reconnects to the running turn

## Covers

The pre-response "pregame" (the priming stage - samskara, intuition,
context recall) runs server-side under `EdgeRuntime.waitUntil`, but the
streaming assistant row - previously the only in-flight signal - is not
created until the model's first content delta. A page refresh inside
that window therefore found nothing to reconnect to and surfaced the
"Previous response was interrupted" / "The response appears to have
been cut off" retry banners for a turn that was still running.

This case proves the fix: the orchestrator stamps
`threads.stream_started_at` at turn entry and clears it at terminal;
`selectThread` arms `reconnectInflightTurn` off the stamp (not just a
streaming row), the orphan-draft check and the cut-off banner are
suppressed while the stamp is fresh, and the reconnect poll renders the
committed reply once the turn settles
([dev: chat](../../dev/chat.md), [dev: exchange](../../dev/exchange.md)).

Sibling case: [priming-disconnect-survival](./priming-disconnect-survival.md)
covers closing the tab and coming back AFTER the turn finished; this
case covers refreshing and watching the SAME turn finish live.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user
  (`dev@nak.local` / `devpass123`).
- A **warm** thread (existing history, intuition model configured,
  context recall enabled) so the pregame runs long enough to refresh
  inside it. DevTools network throttling widens the window further if
  needed.

## Steps

1. Open the warm thread and send a message.
2. **While the subconscious checklist / spinner is still showing**
   (pregame in-flight, before the first reply token), refresh the page
   (F5 / pull-to-refresh).
3. Watch the reopened thread until the turn settles.
4. After the reply lands, refresh once more.

## Expected

- **(2)** On reload the thread shows the "Reconnecting" throbber (the
  reconnect poll), NOT a retry banner. Specifically absent: the
  "Previous response was interrupted. Retry to generate a new one."
  interrupted-draft banner and the "The response appears to have been
  cut off. Click to retry." cut-off banner - and never both stacked.
  The composer behaves as during a normal live turn.
- **(3)** When the server turn finishes, the committed assistant reply
  renders in place of the throbber. No retry banner appears under it
  (the reconnect settle clears the orphaned IndexedDB draft).
- **(4)** The post-completion refresh renders a settled transcript:
  no banner, no throbber, `threads.stream_started_at` is null (verify
  with `mise run dev-sql` if in doubt).
- Sending from a second tab while the first is mid-pregame does not
  start a duplicate completion (the `/stream` probe reports the turn
  in flight from the stamp).

## Cleanup

- None required beyond the test messages.

## Results log

Append-only. Every row carries date, environment, and commit. Do not
overwrite prior rows.

| Date | Environment | Commit | Result | Notes |
| --- | --- | --- | --- | --- |
| pending | local | branch claude/chat-pregame-refresh-errors-tuekc2 | not yet executed | Authored with the fix; needs a manual run against a running stack (cloud agent has no browser). |
