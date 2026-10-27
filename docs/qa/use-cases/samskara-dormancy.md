# Samskara dormancy reaper

## Covers

The event-time release path for claims that fire constantly and never
once engage ([dev: samskara](../../dev/samskara.md), "Dormancy:
event-time release for never-engaging claims"; plan:
[docs/dev/in-progress/samskara-dormancy-plan.md](../../dev/in-progress/samskara-dormancy-plan.md)).
`samskara_reap_dormant()` deletes an activated claim whose 15 most
recent verdicted fires are ALL not-engaged AND span >= 5 distinct
threads, when the claim has no unresolved fire. Runs hourly on the
:13 reap cron after `samskara_expire_unjudgeable_fires` (expired
stamps count toward the streak). The UI surfaces it as a "dormant"
release status and a "Dormant" health-panel row.

## Preconditions

- Local stack up (`mise run dev-start`), schema applied.
- Dev user id: `select id from auth.users where email = 'dev@nak.local';`
- Five thread ids to fire across (create five QA threads with one
  user message each - fires reference threads by FK but the reaper
  only counts distinct thread ids, no message content needed).
- Two session classes: `samskara_reap_dormant` runs as postgres
  (security definer); `samskara_verdict_counts` AND
  `samskara_health_snapshot` are security INVOKER with `auth.uid()`
  filters - run them in the USER's session (psql as the dev user via
  the pooler, or `select set_config('request.jwt.claims', ...)` with
  the user's sub claim); under the postgres role every per-user
  count reads 0.

## Steps

1. **Forge the positive case.** An activated claim with 15 fires,
   all `not-engaged`, spread 3-per-thread across the 5 QA threads.
   `select samskara_reap_dormant();` -> 1; the claim is gone; its
   fires cascaded.
2. **Below threshold survives.** Same shape but 14 fires -> the
   reaper returns without deleting; the claim survives.
3. **Thread floor survives.** 15 fires but ALL in ONE thread -> the
   claim survives (the hot-afternoon guard).
4. **Genuine reset survives.** 15 fires across 5 threads with ONE
   `held` among them -> survives (the streak is a run, not a
   lifetime count; a genuine verdict anywhere in the window resets
   it).
5. **Pending guard.** 15 not-engaged fires plus ONE verdict-null
   fire -> the reaper returns without deleting (the verdict in
   flight may be the first genuine test).
6. **Streak field semantics.** As the user session, call
   `samskara_verdict_counts('<claim>')`:
   - 15 all-not-engaged -> `recent_not_engaged_streak` = 15;
   - 14 not-engaged then one `held` (newest) -> 0;
   - one `held` then 14 not-engaged (held is OLDEST) -> 14.
7. **Snapshot lockstep.** In the USER's session,
   `samskara_health_snapshot()`'s `dormant` column counts exactly the
   claims the reaper would delete (the forge from step 1 pre-reap
   shows 1; post-reap shows 0).
8. **Expired-stamp contribution + statement order.** A synthetic
   thread lacks the evaluation state `samskara_expire_unjudgeable_fires`
   requires, so forge the STAMP itself: a 14-fire claim gains a 15th
   fire with `verdict = 'not-engaged'` and an old `fired_at` (exactly
   what expire writes). Run the FULL cron statement
   `select public.samskara_expire_unjudgeable_fires(), public.samskara_reap_dormant(), public.samskara_reap_dead(), public.samskara_reap_untested();`:
   the stamp counts toward the streak (a 14-fire claim + 1 stamp
   reaps) and the statement order is exercised end to end.
9. **UI.** The detail pane of a dormant claim reads "dormant - never
   engaged in its last 15 judged fires; the hourly reaper collects
   it"; the Health panel shows a "Dormant" row only when nonzero.
10. **[hosted] Real-corpus check.** After a week: the four known prod
   junk claims (68/49/34/30 streaks, 2026-10-27) are collected on
   the first post-merge reaper pass, and no claim with a genuine
   verdict in its last 15 judged fires was deleted.

## Expected

- (1) deletes exactly the forged claim (returns 1). (2)-(5) return 0
  and the claim survives. (6) the streak is the TRUE run length - a
  genuine verdict anywhere resets it to the post-genuine count.
- (7) the snapshot number equals the reaper's delete count (lockstep).
- (8) copy renders with the pending gate (a pending fire suppresses
  the dormant line until the judge rules).

## Cleanup

Delete the forged threads (fires cascade) and any surviving probe
claims. Hosted: wrap ALL mutations in `begin; ... rollback;`.

## Results log

| Date | Environment | Commit | Result | Notes |
| --- | --- | --- | --- | --- |
| 2026-10-27 | local | 18d76700..a68aa0b5 | pass (steps 1-9) | First live pass; real SQL + real UI. (1) 15-fires/5-threads claim reaped, fires cascaded. (2) 14 fires -> survives. (3) 15 fires/1 thread -> survives (hot-afternoon guard). (4) held interrupt -> survives (run resets). (5) pending guard -> survives, fires intact. (6) streak field semantics verified in the user session: 15 all-NE -> 15; newest held -> 0; oldest held -> 14. (7) snapshot lockstep: dormant=1 pre-reap, 0 post-reap, in the user session (invoker - postgres reads 0). (8) expired-stamp contribution: stamping the 15th fire (as expire writes) collects via the full cron statement. Note: expire_unjudgeable_fires itself cannot be exercised on a synthetic thread (it needs the thread's real evaluation state), so the use case forges the stamp - step 8 was rewritten for this during the pass. (9) UI: dormant pane copy renders when the full predicate holds; suppressed while a fire is pending ("awaiting judgment"); Dormant panel row hidden at zero. HARNESS NOTES: forge fires with staggered fired_at (one statement's rows share now(), and the tie makes run-order nondeterministic - impossible in production, one fire per claim per turn); generate_series bounds must match the intended per-thread counts (a (1,15)x5 forge makes 75 fires). Environment incident mid-pass: the Docker VM disk hit 100% ("no space left on device"); builder+image prune freed ~3GB inside the VM and the pass resumed - the host disk had 100GB free; the VM disk image cap is the constraint. QA artifacts cleaned up. |
