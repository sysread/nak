# Bias pipeline: analyze, aggregate, and the profile block

## Covers

The bias worker's two phases - analyze (claim a settled thread, run
the observer/reactor agent, save `bias_observations` +
`bias_reactions`, stamp `bias_processed_at`) and aggregate (recompute
the per-bias `bias_summary` cache) - plus the surfaces that read
them: the bias diagnostics modal and the chat turn's system-prompt
block ([dev: bias-profile](../../dev/bias-profile.md),
[dev: logging](../../dev/logging.md) sources `bias-worker`, `bias`).

## Preconditions

- Local stack up, signed in as the dev user, Logs drawer open at
  `Trace+` (the analyze probe's outcome lines are trace-tier).
- At least one analyze-eligible thread: `updated_at` before today's
  local midnight, two or more user messages, not currently open in
  the app, and `bias_processed_at` null or older than `updated_at`.
  Forge one if needed by backdating a real multi-message thread:

  ```sql
  update threads set updated_at = now() - interval '1 day'
   where id = '<thread-with-2plus-user-messages>';
  ```

- Know the head of the claim queue - the analyze claim walks
  eligible threads oldest-`updated_at` first:

  ```sql
  select t.id, (select count(*) from messages m
                 where m.thread_id = t.id and m.role = 'user') as user_msgs,
         t.updated_at
    from threads t
   where t.updated_at < date_trunc('day', now())
     and (t.bias_processed_at is null or t.bias_processed_at < t.updated_at)
     and (t.bias_claim_holder is null or t.bias_claim_expires < now())
   order by t.updated_at asc limit 5;
  ```

## Steps

1. Reload the app (restarts the bias worker; analyze probes once per
   rotation, idle interval 5 minutes).
2. Watch the drawer for the `[bias-worker]` analyze outcome within
   one rotation: either `analyze: claimed thread <id>` followed by
   agent/save lines, or `analyze: no eligible threads`.
3. After a successful analyze, verify the writes:

   ```sql
   select count(*) from bias_observations where thread_id = '<claimed-id>';
   select bias_processed_at, bias_processed_msg_count
     from threads where id = '<claimed-id>';
   ```

4. Watch for the aggregate pass (`aggregate: recomputed N summary
   row(s)`) - the analyze save marks the aggregate dirty, so it runs
   in the same or next rotation, subject to its 5-minute throttle.
5. Open the bias diagnostics modal (the chart icon next to the
   composer) and confirm the analyzed thread's observations appear
   in the per-bias drill-down.

## Expected

- (2) Analyze claims the QUEUE HEAD when it has >= 2 user messages.
  Eligibility is queue-order-sensitive: the claim examines only the
  oldest eligible thread per probe.
- (3) `bias_observations` rows exist for the claimed thread (zero
  rows is valid only when the agent genuinely found no bias-relevant
  signal - the `bias_processed_at` stamp is the proof the analysis
  ran); `bias_processed_at` set, `bias_processed_msg_count` matches
  the thread's user-message count at claim time.
- (4) Aggregate recomputes after a save (dirty flag) and otherwise
  skips inside its throttle window; `bias_summary` rows update.
- (5) The modal renders the per-bias tiers from `bias_summary` and
  the drill-down shows the new observations.

## Cleanup

Restore any backdated `updated_at` if the thread's drawer position
matters; analysis writes are real feature output and stay.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-11 | local | 317879c | FAIL (2,3) | pre-fix baseline: [bias-worker] logged `analyze: no eligible threads` every probe while 8 threads satisfied the full eligibility predicate; bias_observations had ZERO rows ever. Root cause: bias_claim_next_thread picks LIMIT 1 by oldest updated_at and only then applies the user-message-count check, returning empty without stamping the offender - a one-shot thread at the queue head (here "Microphone sibilance troubleshooting", 1 user msg, May 28) wedges the pipeline permanently. Same wedge confirmed in prod via read-only SQL: newest observation 2026-05-17, 2/231 threads processed, queue head a019ac85 (Apr 18, 1 user msg). Aggregate unaffected (recomputed 19 summary rows from priors) |
| 2026-06-11 | local | (fix) | pass (2,3) | post-fix (count check moved into the claim's WHERE): worker claimed and drained all 8 eligible threads in ~4s (claim -> agent -> save -> immediate next), one-shot threads now correctly skipped over; `analyze: no eligible threads` only after the queue truly emptied; all 8 stamped bias_processed_at + msg counts. Observations 0 on every thread - the agent judged the local test corpus (mic checks, tool gauntlets) as signal-free, the valid zero case; agent hit-rate on real conversations is a [hosted] follow-up. (4,5) not run this pass: aggregate throttled inside its 300s window during the drain and no observations existed to drill into |
