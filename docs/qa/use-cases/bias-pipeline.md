# Bias pipeline: analyze, aggregate, and the profile block

## Covers

The bias sweep's two phases - analyze (claim a settled thread
cross-user, run the observer/reactor agent, save
`bias_observations` + `bias_reactions`, stamp `bias_processed_at`)
and aggregate (recompute the per-bias `bias_summary` cache for the
users the tick touched) - plus the surfaces that read them: the
bias diagnostics modal and the chat turn's system-prompt block
([dev: bias-profile](../../dev/bias-profile.md),
[dev: logging](../../dev/logging.md) source `bias`). The sweep
runs in the venice edge function, driven hourly by the
`nak-bias-sweep` pg_cron job; POSTing the route is the
deterministic stand-in for waiting on the :03 tick.

## Preconditions

- Local stack up, signed in as the dev user, Logs drawer open at
  `Trace+`.
- At least one analyze-eligible thread: `updated_at` on a prior
  calendar day in the owner's timezone, two or more user messages,
  and `bias_processed_at` null or older than `updated_at`. Forge
  one if needed by backdating a real multi-message thread:

  ```sql
  update threads set updated_at = now() - interval '1 day',
         bias_processed_at = null
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

- Confirm the cron job is registered:

  ```sql
  select jobname, schedule from cron.job where jobname = 'nak-bias-sweep';
  ```

## Steps

1. Trigger one sweep tick directly - POST the route with the
   service-role key (`SR` from `supabase status -o json`):

   ```sh
   curl -s -X POST "http://127.0.0.1:54321/functions/v1/venice/bias-sweep" \
        -H "Authorization: Bearer $SR" -H "Content-Type: application/json" -d '{}'
   ```

2. Watch the drawer for the `[bias]` analyze chain per eligible
   thread: `analyze: claimed thread <id>`, the agent's emit line,
   `analyze: saved N observation(s) ...` - repeating until the
   queue drains (per-tick cap 10, cap hit logged to the function
   console).
3. After the drain, verify the writes:

   ```sql
   select count(*) from bias_observations where thread_id = '<claimed-id>';
   select bias_processed_at, bias_processed_msg_count
     from threads where id = '<claimed-id>';
   ```

4. Watch for the aggregate pass in the same tick:
   `aggregate: recomputed N summary row(s)` for every user the
   drain touched; `bias_summary.computed_at` bumps.
5. Open the bias diagnostics modal (the chart icon next to the
   composer) and confirm the analyzed thread's observations appear
   in the per-bias drill-down.

## Expected

- (1) Route returns `{"accepted":true}` (the sweep handler ACKs and
  runs under waitUntil).
- (2) Analyze claims the QUEUE HEAD when it has >= 2 user messages.
  Eligibility is queue-order-sensitive: the claim examines only the
  oldest eligible thread per probe, so the count predicate must
  exclude one-shot threads BEFORE the limit (the starvation fix).
- (3) `bias_observations` rows exist for the claimed thread (zero
  rows is valid only when the agent genuinely found no bias-relevant
  signal - the `bias_processed_at` stamp is the proof the analysis
  ran); `bias_processed_at` set, `bias_processed_msg_count` matches
  the thread's user-message count at claim time.
- (4) Aggregate runs in the same tick for every touched user (no
  dirty flag, no throttle - the hourly cadence is the throttle);
  a user whose oldest `bias_summary.computed_at` exceeds 24h gets
  recomputed even with no saves that tick.
- (5) The modal renders the per-bias tiers from `bias_summary` and
  the drill-down shows the new observations.
- **[hosted]** the cron tick itself fires at :03 (check
  `cron.job_run_details` after a deploy).

## Cleanup

Restore any backdated `updated_at` if the thread's drawer position
matters; analysis writes are real feature output and stay.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-11 | local | 317879c | FAIL (2,3) | pre-fix baseline: [bias-worker] logged `analyze: no eligible threads` every probe while 8 threads satisfied the full eligibility predicate; bias_observations had ZERO rows ever. Root cause: bias_claim_next_thread picks LIMIT 1 by oldest updated_at and only then applies the user-message-count check, returning empty without stamping the offender - a one-shot thread at the queue head (here "Microphone sibilance troubleshooting", 1 user msg, May 28) wedges the pipeline permanently. Same wedge confirmed in prod via read-only SQL: newest observation 2026-05-17, 2/231 threads processed, queue head a019ac85 (Apr 18, 1 user msg). Aggregate unaffected (recomputed 19 summary rows from priors) |
| 2026-06-11 | local | cd4410a | pass (2,3) | post-fix (count check moved into the claim's WHERE): worker claimed and drained all 8 eligible threads in ~4s (claim -> agent -> save -> immediate next), one-shot threads now correctly skipped over; `analyze: no eligible threads` only after the queue truly emptied; all 8 stamped bias_processed_at + msg counts. Observations 0 on every thread - the agent judged the local test corpus (mic checks, tool gauntlets) as signal-free, the valid zero case; agent hit-rate on real conversations is a [hosted] follow-up. (4,5) not run this pass: aggregate throttled inside its 300s window during the drain and no observations existed to drill into. NOTE: rows above cite pre-rebase commit hashes that no longer resolve after the branch rebased onto 13ef213; the recorded states are historical |
| 2026-06-11 | local | (this commit) | pass (1,3,4) | post-port (server-side sweep): POST returned `{"accepted":true}`; the re-armed thread a5cf4c4b (5 user msgs) analyzed within the tick - bias_processed_at stamped, msg_count 5, claim released; observations 0 = the same valid zero case as the baseline corpus. Aggregate ran in the SAME tick: all 19 bias_summary rows recomputed with fresh computed_at, confirming the no-throttle cadence. (2) drawer lines and (5) modal not watched - no Vite session was up; both read paths (edge-log broadcast relay, modal direct reads) are untouched by the port and the DB writes stand in as evidence. cron.job row `nak-bias-sweep` at `3 * * * *` confirmed registered |
