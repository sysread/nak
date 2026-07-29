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

6. Reload recovery: start a manual run (step 3), then reload the page
   mid-run and reopen the Memories tab. After it finishes, reload
   again.
7. Wall-clock budget: force the agent loop to run out of time by
   dropping the budget, so a normal batch cannot settle inside it.
   Temporarily set `DEEP_SLEEP_BUDGET_MS` to something a single round
   exceeds (e.g. `1`) in
   `supabase/functions/venice/agents/deep_sleep.ts`, restart
   `functions serve`, arm a multi-row neighborhood, and run a manual
   deep-sleep. Note the batch's memory ids first:

   ```sql
   select id, label, last_librarian_visit_at from memories
    where user_id = '<user>' and last_librarian_visit_at is null
    order by id limit 5;
   ```

   Restore the constant afterwards.

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
- (3) On Run the progress strip appears immediately and stays put -
  the panel's changelog default surface must NOT flash through in the
  gap before the first streamed step (the strip is visible from the
  synchronous instant the run starts, not only once a step arrives).
  Live narrated steps in the strip (manual runs carry the activity
  param). The step in flight is marked by three rising Z's whose
  brightness wave travels UPWARD (bottom Z peaks, then middle, then
  top, on a ~1s cycle) - visibly moving, not a uniform pulse of the
  whole group - and settles to a check or cross as the next step opens.
  The Z's must not shift the layout: the step rows keep the same height
  as the settled rows, the labels keep one straight left edge, and the
  translated Z's do not collide with the rows above or below. (The wiki
  librarian's strip keeps the `- \ | /` bar; only the memory passes
  drowse.) Under an OS reduced-motion setting the Z's hold still,
  brightest at the bottom, and nothing animates. A spinning
  *Working* row holds the bottom of the list for the whole run,
  including the gap before the first step arrives and the gap after a
  tool row settles; exactly one spinner is ever visible in the list
  (the tail yields to a pending row rather than stacking). A failed
  tool call marks its row with a RED cross and the run continues -
  the agent commonly retries and later rows keep landing. Results
  fold into the strip's result line; the Memories list refreshes
  without a manual reload (the memories realtime relay).
- (4) The manual run returns busy (the strip shows the busy
  message); no cadence stamp is consumed.
- (5) After release, a manual run proceeds normally.
- (6) Reloading mid-run keeps the Run button disabled (the in-flight
  lease, recovered by its initial read) and shows the "running in the
  background" spinner; the run finishes server-side. After it
  finishes, a reload restores the last run's result summary from
  `memory_librarian_last_run_outcome` (read on mount). The live
  step-by-step list is NOT restored - only the final summary line.
- (7) The run ENDS CLEANLY rather than hanging: a result line
  appears, the lease is released (`memory_librarian_inflight_expires_at`
  back to null), and an outcome envelope is written. It must not sit
  on "Deep-sleep running" until the lease TTL expires - that is the
  failure this budget exists to prevent. Only the SEED carries a new
  `last_librarian_visit_at`; the neighbors noted in step 7 stay null,
  so a later pass with time for them picks them up rather than them
  retiring as reviewed. The `deep-sleep` drawer source logs
  `stopped on limit - neighbors left queued`.

## Cleanup

Release any QA-held guard (step 5). Restore `DEEP_SLEEP_BUDGET_MS`
if step 7 was run. Memory edits are real; review
via the memory changelog panel if surprising.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-09 | local | (rem+ds fleet) | pass (1,2,4) | rem reviewed a real 5-read batch; deep-sleep performed a real consolidation w/ changelog; guard collision -> busy |
| 2026-06-09 | local | (rem+ds fleet) | pass (3) | playwright drove the strip end to end - live broadcast steps with narrated activities, rem drew a real supports edge |
| 2026-06-10 | local | 8877595 | pass (3, by shared path) | the factory + narration wrapper are the same code the wiki librarian manual run proved live today; rem manual additionally round-tripped the factory via curl (empty-queue union). The Memories strip's own rendering passed 2026-06-09 and did not change |
