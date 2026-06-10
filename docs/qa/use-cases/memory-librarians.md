# Memory librarians: rem + deep-sleep sweeps and manual runs

## Covers

The two memory-librarian passes - rem (recall co-occurrence
batches) and deep-sleep (similarity neighborhoods) - their cron
sweeps, the Memories panel's manual runs with live progress, and
the ONE shared in-flight guard across all four paths
([dev: memory](../../dev/memory.md)).

## Preconditions

- Local stack up, signed in as the dev user; `SR` + `JWT` as in the
  wiki case.
- Rem eligibility: unprocessed `memory_conversation` rows (the
  recall agent seeds them during normal chat) and a stale cadence:

  ```sql
  update profiles set rem_last_run_at = null,
         deep_sleep_last_run_at = null where user_id = '<user>';
  update memory_conversation set processed_at = null
   where user_id = '<user>'; -- re-arm a consumed queue
  ```

- Deep-sleep eligibility: 2+ memories with embeddings whose
  neighborhoods clear cosine >= 0.80; re-arm by nulling
  `last_librarian_visit_at` on a few rows.

## Steps

1. Rem sweep: POST `/rem-sweep` (service bearer); watch the
   drawer's `rem` source.
2. Deep-sleep sweep: POST `/deep-sleep-sweep`; watch `deep-sleep`.
3. Manual runs: in the Memories drawer tab, run the shuffle (rem)
   and moon (deep-sleep) buttons; watch the progress strip.
4. Guard collision: hold the guard, then attempt a manual run:

   ```sql
   select claim_memory_librarian_inflight('qa-holder', 600, '<user>');
   ```

5. Release and confirm recovery:

   ```sql
   select release_memory_librarian_inflight('qa-holder', '<user>');
   ```

## Expected

- (1) `{"accepted":true}`; drawer shows
  `rem reviewing batch of N memories from conversation ...` then a
  finished line with the model's reasoning; processed conversations
  get stamped; an agent failure leaves rows UNPROCESSED for retry.
  Batches under 2 memories are marked processed without a Venice
  call.
- (2) Same shape; a lonely seed (no neighbors >= 0.80) stamps
  visited and skips Venice; a real neighborhood produces memory
  graph edits (consolidations halve the loser's confidence and
  append a "Merged ... into this memory." changelog row).
- (3) Live narrated steps in the strip (manual runs carry the
  activity param); results fold into the strip's result line; the
  Memories list refreshes without a manual reload (the memories
  realtime relay).
- (4) The manual run returns busy (the strip shows the busy
  message); no cadence stamp is consumed.
- (5) After release, a manual run proceeds normally.

## Cleanup

Release any QA-held guard (step 5). Memory edits are real; review
via the memory changelog panel if surprising.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-09 | local | (rem+ds fleet) | pass (1,2,4) | rem reviewed a real 5-read batch; deep-sleep performed a real consolidation w/ changelog; guard collision -> busy |
| 2026-06-09 | local | (rem+ds fleet) | pass (3) | playwright drove the strip end to end - live broadcast steps with narrated activities, rem drew a real supports edge |
| 2026-06-10 | local | 8877595 | pass (3, by shared path) | the factory + narration wrapper are the same code the wiki librarian manual run proved live today; rem manual additionally round-tripped the factory via curl (empty-queue union). The Memories strip's own rendering passed 2026-06-09 and did not change |
