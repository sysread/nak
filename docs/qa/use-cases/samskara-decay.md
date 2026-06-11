# Samskara decay pass

## Covers

The decay maintenance pass over the samskara corpus - the three
health nudges (stale-fire -0.02, net-disconfirm -0.10, locked-in
-0.03) applied by `samskara_decay_sweep()`, driven by the
`nak-samskara-decay` pg_cron job every 30 minutes
([dev: samskara](../../dev/samskara.md), "Decay formula").

## Preconditions

- Local stack up (`mise run dev-start`), schema applied
  (`psql -v ON_ERROR_STOP=1 -f supabase/schema.sql`).
- Know the dev user's id:

  ```sql
  select id from auth.users where email = 'dev@nak.local';
  ```

- Forge one disjoint candidate per decay path so each nudge is
  individually observable (pick three existing rows; health 0.5
  makes the drop visible above the `greatest(0, ...)` clamp):

  ```sql
  -- stale-fire: never/last fired over 60 days ago, low fire count
  -- so the locked-in predicate stays out of the way
  update samskaras set health = 0.5,
         last_fired_at = now() - interval '61 days',
         created_at = now() - interval '61 days'
   where id = '<row-A>';  -- fire_count <= 10, no feedback

  -- net-disconfirm: accumulated disconfirm outweighs confirm with
  -- at least 1.0 total reaction weight; fresh fire, low fire count
  update samskaras set health = 0.5,
         disconfirm_count = 1.2, confirm_count = 0.1,
         last_fired_at = now()
   where id = '<row-B>';  -- fire_count <= 10

  -- locked-in: many fires, near-zero accumulated feedback, fresh
  update samskaras set health = 0.5, last_fired_at = now()
   where id = '<row-C>';  -- fire_count > 10, feedback < 0.5
  ```

- Other corpus rows may also match a predicate (typically health-0
  rows that re-match locked-in every pass); the return count is
  therefore `>= 3`, and the per-row assertions below are the real
  check.

## Steps

1. Confirm the cron job is registered (the schema apply registers
   it whenever the local image has pg_cron):

   ```sql
   select jobname, schedule, command from cron.job
    where jobname = 'nak-samskara-decay';
   ```

2. Run the pass directly - the sweep is what the cron job calls,
   so a manual invocation is the deterministic stand-in for
   waiting on the :13/:43 tick. It is cross-user `security
   definer`, so no JWT claim is needed:

   ```sql
   select public.samskara_decay_sweep();
   ```

3. Verify the per-row nudges landed:

   ```sql
   select id, health from samskaras
    where id in ('<row-A>', '<row-B>', '<row-C>');
   ```

## Expected

- (1) one row: schedule `13,43 * * * *`, command
  `select public.samskara_decay_sweep();`.
- (2) returns the count of rows changed across ALL users, `>= 3`.
- (3) row-A health `0.48` (stale-fire -0.02); row-B health `0.40`
  (net-disconfirm -0.10); row-C health `0.47` (locked-in -0.03).
  `updated_at` bumped to now() on all three.
- **[hosted]** the cron tick itself fires at :13/:43 (check
  `cron.job_run_details` after a deploy) - local proof stops at
  the registration row plus the manual invocation.

## Cleanup

Restore the forged rows if their health/feedback values matter
(they are test-corpus rows locally, so usually they do not):

```sql
update samskaras set health = 0, disconfirm_count = 0,
       confirm_count = 0 where id in ('<row-B>');
```

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-11 | local | 5981c58 | pass | pre-lift baseline against the per-user `samskara_decay()` invoker (browser worker's decay phase, psql stand-in w/ jwt claim): returned 6 (3 forged + 3 pre-existing health-0 locked-in re-matches), per-row health exactly 0.48 / 0.40 / 0.47, updated_at bumped on all. Forged rows 8a1e5b5b (stale), 422e6389 (disconfirm), cb1d4308 (locked-in) |
| 2026-06-11 | local | (this commit) | pass (1,2,3) | post-lift: cron.job row registered (`13,43 * * * *` -> `samskara_decay_sweep()`); manual sweep returned 6 and produced byte-identical per-row health to the baseline (0.48 / 0.40 / 0.47 on the same re-forged rows). ACL verified via pg_proc.proacl: postgres + service_role only, matching nak_sweep_stale_streams. Note: exercising the denial via `set local role anon` SEGFAULTS the local supabase image's backend (signal 11, reproducible against the long-standing janitor fn too) - local-image quirk, use the catalog ACL check instead. [hosted] tick firing deferred to the post-merge hosted pass |
