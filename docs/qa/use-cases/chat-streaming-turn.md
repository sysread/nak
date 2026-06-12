# Chat: one streaming turn, end to end

## Covers

The `/stream` route pair (fresh + reconnect,
[dev: chat](../../dev/chat.md)), the orchestrator's operational
drawer logging ([dev: logging](../../dev/logging.md), source
`stream`), the in-flight probe and stale-row janitor, and the
subconscious priming pipelines' fire policy
([dev: intuition](../../dev/intuition.md),
[dev: context-recall](../../dev/context-recall.md)).

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A thread with at least one prior completed turn (any).
- For the cold-trigger expectation: clear the thread's subconscious
  caches first:

  ```sql
  update threads set intuition_payload = null,
         context_recall_payload = null where id = '<thread>';
  ```

## Steps

1. Open the Logs drawer, set Minimum level to `Debug+`, leave
   Source tag on `All sources`.
2. Send a short message in the thread (composer sends on
   cmd-enter; the Send button also works).
3. Watch the reply stream; when it settles, filter the drawer's
   Source tag to `stream`.
4. Reconnect probe: with no stream in flight, POST a
   reconnect-only request with the signed-in user's JWT:

   ```sh
   curl -s -X POST \
     http://127.0.0.1:54321/functions/v1/venice/stream \
     -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
     -d '{"threadId":"<thread>","reconnectOnly":true}'
   ```

5. Stale-row janitor: forge an orphaned streaming row older than
   the janitor threshold, then send a fresh message in the thread:

   ```sql
   insert into messages (thread_id, role, status, content, created_at)
   values ('<thread>', 'assistant', 'streaming', 'orphan',
           now() - interval '15 minutes');
   ```

## Expected

- (2-3) The reply streams into the bubble; the drawer's `stream`
  source shows, keyed by one runId: a `start` line (debug), a
  `round 0` line (debug), an event tally (debug), and
  `end terminalKind=completed` (info). Turns that dispatch tools
  additionally show `dispatching N tool call(s)` and an
  `outcomes:` line at info.
- (2, cold caches) Both subconscious caches repopulate with
  `trigger='cold'`:

  ```sql
  select intuition_payload->>'trigger',
         context_recall_payload->>'trigger'
    from threads where id = '<thread>';
  ```

- (4) Response is `{"channelName":"thread:<id>:stream",
  "assistantRowId":null,"completedSoFar":"","noStreamInFlight":true}`.
- (5) The fresh send succeeds in one step: the forged row flips to
  `status='error'` and the NEW reply streams normally in the same
  request (the janitor no longer forces a second send - deliberate
  A5 behavior change). `threads.last_error` carries the
  lost-mid-stream message only TRANSIENTLY: the successful commit
  at the new turn's terminal clears it by design (a completed turn
  is the signal the thread is healthy), so the end state is
  last_error null. To observe the transient value, check between
  the send and the reply settling, or run the janitor via a
  reconnect-only request instead (no stream follows, so the value
  persists).

## Cleanup

Delete the forged orphan row if step 5's send did not already bury
it:

```sql
delete from messages where content = 'orphan' and thread_id = '<thread>';
```

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-10 | local | 5bfd057 | pass (2-3) | four `[stream]` lines rendered, runId-keyed; no-tool turn so no dispatch lines |
| 2026-06-10 | local | 64acd30 | pass (2 cold) | both caches repopulated `trigger='cold'` after manual clear |
| 2026-06-10 | local | a5e5f22 | pass (4) | reconnect probe returned the exact noStreamInFlight envelope |
| 2026-06-10 | local | a5e5f22 | pass (5) | forged orphan flipped to error and the reply streamed in one send; last_error null at end state (cleared by the successful commit - expectation refined to match) |
