# Reflection: tail drain, catch-up sweep, attempt cap

## Covers

The reflection agent's two drivers - the chat-turn waitUntil tail
and the hourly `/reflection-sweep` cron route - plus the per-thread
claim mutual exclusion and the attempt cap
([dev: memory](../../dev/memory.md), "Reflection" entries).

## Preconditions

- Local stack up, signed in as the dev user.
- At least one reflection-eligible thread: two or more user
  messages, a terminal assistant message, newest message on a
  calendar day BEFORE today in the user's timezone (the day gate),
  and a stale pointer. To make one eligible:

  ```sql
  update threads set last_reflected_msg_id = null,
         reflection_attempt_count = 0, reflection_attempt_msg_id = null,
         reflection_holder_id = null, reflection_claim_expires_at = null
   where id = '<thread>';
  ```

- `SR` = the service-role key from `supabase status -o json`.

## Steps

1. Tail drain: send a chat message in ANY thread and let the turn
   complete. Watch the Logs drawer's `reflection` source.
2. Sweep: tick the route directly and watch the same source:

   ```sh
   curl -s -X POST \
     http://127.0.0.1:54321/functions/v1/venice/reflection-sweep \
     -H "Authorization: Bearer $SR" -H "Content-Type: application/json" -d '{}'
   ```

3. Auth posture: repeat step 2 with the anon key (expect rejection)
   and with a signed-in user JWT (expect 403).
4. Attempt cap: burn three claims against one eligible thread
   (expire the claim between calls), then confirm a fourth claim
   skips it:

   ```sql
   -- repeat 3x:
   update threads set reflection_claim_expires_at = now() - interval '1 second'
    where id = '<thread>';
   select * from claim_next_thread_for_reflection_sweep('qa-cap', 1);
   -- then:
   select reflection_attempt_count from threads where id = '<thread>'; -- 3
   update threads set reflection_claim_expires_at = now() - interval '1 second'
    where id = '<thread>';
   select * from claim_next_thread_for_reflection_sweep('qa-cap-4', 1);
   ```

## Expected

- (1) On a turn whose user has an eligible OLDER thread queued, the
  drawer shows `[reflection] picked up thread ...` then
  `finished thread ... (N tool calls over M messages)`; new
  memories appear for content-bearing threads. With an empty queue
  the tail is silent at default levels (trace line only).
- (2) Immediate `{"accepted":true}` (the tick runs detached); the
  drawer shows the same picked-up/finished pair when a thread was
  eligible, `last_reflected_msg_id` advances, and
  `reflection_attempt_count` resets to 0 on the mark.
- (3) Gateway 401 without a JWT; route-level
  `{"error":"forbidden"}` 403 with a non-service JWT.
- (4) The count reaches 3 and the fourth claim returns no row for
  that thread (other eligible threads still claim normally).
- **[hosted]** A reflection on a large thread completes within the
  hosted invocation wall clock, OR caps out at 3 attempts and stops
  burning Venice calls. Local measurement: ~9 minutes end-to-end on
  a 14-message/69KB thread - likely over the hosted window; the cap
  is the backstop.

## Cleanup

Reset any cap-test residue:

```sql
update threads set reflection_attempt_count = 0,
       reflection_attempt_msg_id = null, reflection_holder_id = null,
       reflection_claim_expires_at = null
 where reflection_holder_id like 'qa-%';
```

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-09 | local | 4e33cc3 | pass (1) | four queued reflections drained in order across turns, drawer lines live |
| 2026-06-10 | local | d37dbcd | pass (2,3) | detached tick accepted in 215ms; sweep claimed cross-user; 401/403 posture held |
| 2026-06-10 | local | 2e37c8b | pass (4) | counter hit 3, fourth claim skipped the thread |
| 2026-06-10 | local | d37dbcd | note | full reflect+mark on the 69KB thread took ~9 min detached; completed only after the TTL fix (600s) |
