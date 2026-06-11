# Samskara decay pass

## Covers

The decay maintenance pass over the samskara corpus - the three
health nudges (stale-fire -0.02, net-disconfirm -0.10, locked-in
-0.03) applied by `samskara_decay()`, currently driven by the
browser samskara worker's `decay` phase on a 30-minute in-memory
throttle ([dev: samskara](../../dev/samskara.md), "Decay formula"
and the "Migration note - decay is a strong cron candidate" block).

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

1. Run the decay pass as the dev user. The function is security
   invoker scoped by `auth.uid()`, so set the JWT claim in-session
   (the browser worker normally supplies this via its authenticated
   client; psql stands in for it here):

   ```sql
   begin;
   select set_config('request.jwt.claims',
                     '{"sub":"<dev-user-id>"}', true);
   select public.samskara_decay();
   commit;
   ```

2. Verify the per-row nudges landed:

   ```sql
   select id, health from samskaras
    where id in ('<row-A>', '<row-B>', '<row-C>');
   ```

## Expected

- (1) `samskara_decay()` returns the count of rows changed, `>= 3`.
- (2) row-A health `0.48` (stale-fire -0.02); row-B health `0.40`
  (net-disconfirm -0.10); row-C health `0.47` (locked-in -0.03).
  `updated_at` bumped to now() on all three.
- The browser worker's `decay` phase applies the same pass on its
  30-minute in-memory throttle during an active session (trace-tier
  `decay: applied` line in the Logs drawer at `Trace+`); the SQL
  exercise above is the deterministic stand-in for waiting on the
  rotation.

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
