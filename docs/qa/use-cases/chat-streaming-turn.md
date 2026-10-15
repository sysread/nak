# Chat: one streaming turn, end to end

## Covers

The `/stream` route pair (fresh + reconnect,
[dev: chat](../../dev/chat.md)), the orchestrator's operational
drawer logging ([dev: logging](../../dev/logging.md), source
`stream`), the in-flight probe and dead-turn janitor, and the
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

5. Dead-turn janitor: forge an orphaned streaming row on a thread
   whose heartbeat is stale (the janitor keys on
   `threads.stream_heartbeat_at`, not on the row's age), then send a
   fresh message in the thread:

   ```sql
   insert into messages (thread_id, role, status, content)
   values ('<thread>', 'assistant', 'streaming', 'orphan');
   update threads set stream_heartbeat_at = now() - interval '2 minutes'
    where id = '<thread>';
   ```

6. Dispatch cap: ask the model for a bulk operation big enough to
   emit more than 10 tool calls in one round (for example, more
   than 10 memory or record writes in one batch).

7. Interrupted batch: while a large batch is dispatching, kill the
   turn without a graceful abort - the practical local recipe is to
   bounce the functions server (`mise run functions-serve` restart)
   mid-dispatch. Verify the per-call rows: completed calls must
   have result rows; only in-flight calls may be missing.

8. Ask_user recovery shapes: drive an ask_user round (for example,
   "ask me a clarifying question with options before doing X"),
   then exercise the three sentinel tails and check the wire and
   the DB after each: (a) answer the card in the same tab and
   confirm the resumed reply contains no interruption language;
   (b) reload the thread while the question is pending (the
   abandon-on-refresh rewrite fires), then type the answer as a
   plain message and confirm the DB tail carries the honest
   closing row ("left unanswered") between the sentinel and the
   user row, never the "interrupted" note; (c) reload mid-turn
   BEFORE the question lands, let the reconnect probe settle the
   suspended turn, then answer the card and confirm the resumed
   wire ends at the answered sentinel with no synthetic row.

## Expected

- (2-3) The reply streams into the bubble; the drawer's `stream`
  source shows, keyed by one runId: a `start` line (debug), an
  in-flight probe verdict line (debug), a
  `stream_heartbeat_at stamped` line (debug), a `round 0` line
  (debug), an event tally (debug), a `stream_heartbeat_at cleared`
  line (debug), and `end terminalKind=completed` (info) - seven
  lines for a no-tool turn. Turns that dispatch tools additionally
  show `dispatching N tool call(s)` and an `outcomes:` line at
  info.
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
- (6) The drawer's `outcomes:` line tags the first 10 calls `ok` and
  the rest `deferred`; each deferred call's card carries the
  re-issue text; the model re-issues and the drain rounds complete
  the batch with no round-limit banner.
- (7) After the kill: result rows exist for the calls that settled
  before the kill; the recovery pass on next load fills only the
  missing ids with the interrupted marker, and the model's next
  turn sees real results plus markers (never a silent gap).
- (8) (a) The resumed reply follows the answer with no "interrupted"
  note anywhere on the wire (Logs drawer shows the request the
  function received; in-session there is no synthesis at all).
  (b) The DB tail reads sentinel (abandoned envelope) then the
  honest closing assistant row, then the user row - no
  "previous response was interrupted" row, no interrupted-round
  status card. (c) The resumed turn's request ends at the answered
  sentinel (plus the metadata system row) with no recovery
  assistant after it; the reply continues normally.

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
| 2026-08-21 | local (mise run dev-start) | f5e6c90b | pass (1-5) | all steps pass on one thread; DB checks via PostgREST from page context (QA agent has no shell). Cold triggers confirmed both caches. Reconnect probe exact-match. Janitor flipped orphan to error, reply streamed same send; transient last_error caught at T+0.5s, null at end. Doc drift: stream source now emits 3 lines the Expected inventory omits (in-flight probe verdict, stream_started_at stamped, stream_started_at cleared). |
| 2026-08-21 | local (mise run dev-start) | 8abfe2bc | pass (1-5) | All five steps pass at the M1 head. The 7-line stream inventory is unchanged from the M0 baseline (in-flight probe, start, stream_started_at stamped, round 0 historyLen, round 0 events, stream_started_at cleared, end terminalKind). Cold triggers confirmed both caches. Reconnect probe returned the exact noStreamInFlight envelope. Janitor flipped the forged orphan (position 5, status=streaming, 15min old) to error; the new reply streamed in the same send at position 6-7; last_error null at end state. The round-boundary move-to-tail (replacing the created_at re-stamp) did not alter the log inventory. |
| 2026-08-24 | local (mise run dev-start) | 116abd66 | pass (1-5) | All five steps pass at the M2 head, identical to M1 results. 7-line inventory unchanged. Cold triggers confirmed both caches. Reconnect probe exact-match. Janitor flipped the forged orphan to error, reply streamed same send, last_error null at end. The thread_transcript resolver (new in M2) did not alter the streaming path's observable behavior - zero behavior change confirmed. |
| 2026-10-13 | local | 19db56a8 | P (1-5 baseline, prior rounds) / - (6-7) | Steps 6-7 added for the tool-batch resilience change (dispatch cap, per-call persistence). Baseline execution of the new steps not yet run - no stack/browser available in the worktree session; run 6-7 with the post-change pass and log both rows. |
| 2026-10-13 | local (dev-start from the worktree, change code live) | 69c237b2 | pass (6) / pass (2, 7 variant) | (6) 12-call memory_delete round: first 10 ok, 2 deferred with the re-issue text on the cards; model re-issued both next round, deleted: true; 12/12 ids answered in DB, 0 memories left. (2) 2-call memory_save round: per-call rows + complete terminal. (7 variant, display path) forged round row with 2 unanswered tool_calls + recovery banner renders; cards show the interrupted body. Found+fixed: statusFor painted a green check on recovery rows (non-JSON body fell through to treat-as-success); now detects RECOVERY_MARKER and reports error. |
| 2026-10-15 | unit gate (worktree) | this branch | - (8, live) / P (unit) | Step 8 added for the ask_user recovery false-positive fix. No stack/browser available in the worktree session; live pass pending. Unit coverage instead: synthesizeRecoveryMessages drives all three sentinel tails plus mixed/incomplete/mid-history shapes (tests/conversation-recovery.test.ts), askUserRowState classifier (tests/ask-user-tool.test.ts), classifyTail sentinel look-back (tests/completion-status.test.ts), function-side twin bodies (supabase/functions/tests/curation.test.ts). Full mise run check green. |
