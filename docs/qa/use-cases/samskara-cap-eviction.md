# Samskara cap-pressure eviction

## Covers

The tier-1 release path that runs under formation pressure rather than
on a clock ([dev: samskara](../../dev/samskara.md), "Release of
never-tested claims: probation + cap-pressure eviction").
`samskara_evict_for_mint(user)` frees exactly one slot for a pending
mint when the tier-1 population sits at its cap (150, pinned to
`p_target_count` on `samskara_collapse_by_cofiring`). Three victim
tiers, tried in order:

1. **Untested junk** - `confirm_count = 0 and disconfirm_count = 0`,
   >= 14 days old, >= 10 judged fires, no unresolved fire. Ranked
   most-judged-first.
2. **Weakly established gone stale** - evidence tally in `(0, 1.0]`,
   last genuine verdict >= 90 days ago, no unresolved fire. Ranked
   stalest-first.
3. **Demonstrated underperformer** - `health <
   0.85 * samskara_population_p0(user)`. No pending-fire guard (a row
   that far under water cannot be exonerated by one in-flight
   verdict, and on an active day the guard empties the pool). Ranked
   lowest-health-first, larger tally as tiebreak.

Both tier-1 mint probes (recency and association) call the shared
`ensureTier1Headroom` gate, so the pool is drawn from in probe order
within one sweep tick; a declined hub does not refill the slot its
eviction freed. The `samskara_health_snapshot` columns `evictable`,
`evictable_stale`, and `evictable_unhealthy` mirror the three
predicates for the Health panel's "Evictable (untested / stale /
unhealthy)" readout - lockstep is load-bearing.

## Preconditions

- Local stack up (`mise run dev-start`), schema applied
  (`psql -v ON_ERROR_STOP=1 -f supabase/schema.sql`), OR hosted
  read-mostly via SQL editor / MCP (wrap mutations in a rolled-back
  transaction).
- Dev user id: `select id from auth.users where email = 'dev@nak.local';`
  (hosted: the account under test).
- Know the user's prior: `select public.samskara_population_p0('<user>');`

## Steps

1. **Pool visibility.** Run the four victim-class predicates as
   counts (copy them from `samskara_evict_for_mint`'s body) and
   compare with the `evictable`, `evictable_stale`,
   `evictable_unhealthy`, `evictable_graduated` columns of
   `select * from samskara_health_snapshot()` executed as the user
   (invoker security - service role sees zeros for `auth.uid()`).
2. **Tier order and the underperformer tier.** Inside
   `begin; ... rollback;`: forge a guaranteed tier-3 victim
   (`update samskaras set health = 0.3, confirm_count = 0.5,
   disconfirm_count = 3 where id = '<row>'`), confirm tiers 1 and 2
   are empty (or forge them empty by picking a corpus where they
   are), then `select samskara_evict_for_mint('<user>');`.
3. **No-victim behavior.** Still inside the transaction, delete or
   restore the forged row, verify all four predicates count zero,
   and call the function again.
3b. **Graduation tier.** Still inside the transaction, with tiers
   1-3 empty: pick a tier-2 row with `'samskara'` provenance, forge
   it established (`update samskaras set health = 0.95,
   confirm_count = 3, created_at = now() - interval '20 days' where
   id = '<t2>'`), make sure one of its children has no verdict-null
   fire, then call the function. Expect the child with the LOWEST
   own evidence tally back; the compound row and its provenance rows
   are untouched.
4. **[hosted] Live drain.** With tier-1 pinned at cap and unconsumed
   association edges present, watch a `nak-samskara-sweep` tick
   (`:23`) in the Logs drawer: `mint-tier1` / `mint-tier1-assoc`
   either log `evicted samskara to free a capped slot` followed by
   mint/decline/dedup activity, or `tier-1 at cap, nothing evictable;
   skipping`. Association-edge consumption
   (`samskara_associations.minted_at`) should advance on ticks where
   a victim existed and the user was active in the last 2 hours.

## Expected

- (1) The hand-run predicate counts equal the snapshot columns
  exactly. Drift means the mirror rotted - fix the snapshot in the
  same change that touched the eviction predicate.
- (2) The function returns the forged row's id and the row is gone
  (inside the transaction); tier 3 is only reached when tiers 1 and 2
  return nothing.
- (3) Returns null; no row deleted. The caller (mint probe) skips at
  cap - formation stalls but nothing breaks.
- (3b) Returns the least-evidenced child of the forged compound and
  only that row is gone; the compound and its provenance remain. A
  child carrying a verdict-null fire is never the victim.
- (4) On a tick with a victim: eviction log line, then the probe's
  verdict activity; backlog (`minted_at is null` count) steps down as
  hubs consume. On a tick without: the skip line and an unchanged
  backlog - which, sustained while readouts sit at zero and the cap
  is pinned, is the formation-starvation signal the dev doc's
  eviction section names.

## Cleanup

All mutations run inside `begin; ... rollback;`. Nothing to restore
otherwise.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-08-08 | hosted | 9adee0d (pre-fix) | fail | [hosted] Baseline against the two-tier function, live corpus: tier-1 pinned at 150 since the 08-07 02:23 mint; class-1 and class-2 victim counts both ZERO (judge rework engages most fires, so `confirm_count = 0` rows barely exist; corpus too young for 90-day staleness), so every mint probe skipped at cap for ~42h and association consumption froze (backlog 1,082 -> 1,092, `max(minted_at)` stuck at 08-07 02:23) while pair-relate kept adding edges. Manual sweep fire (`select nak_trigger_samskara_sweep()`) confirmed: runs clean, consumes nothing. Health-tier pool measured before design: 11 rows below `0.85 * p0` (p0 0.824, min health 0.585), but only 1 of them pending-free - 115/150 tier-1 rows carried an unjudged fire, which is why tier 3 drops that guard. |
| 2026-08-10 | hosted | 5287884 (post health-tier) | partial | [hosted] Full-system audit (samskara-audit skill). Health tier WORKED as designed: 56 edges consumed in eviction-funded bursts of ~12/hr (08-08 21:00 through 08-09 19:00) until the 11-row pool was spent; p0 rose 0.824 -> 0.869 (evicting the worst raised the aggregate), min health 0.772, pool back to 0/0/0 and drain re-paused - now legitimately (nothing performing 15% below baseline). ROOT CAUSE of the guarded tiers' permanent emptiness found: 1,840 of 2,084 verdict-null fires were junk-thread sediment (one-round threads the judge skips forever; oldest fire 04-24), and the pending-fire guard read them as tests in flight - 132/150 tier-1 rows permanently shielded from probation and eviction tiers 1-2. Fix: `samskara_expire_junk_thread_fires` (activity-relative terminal not-engaged, :13 cron). Post-deploy expectation: awaiting-judgment drops to ~250, probation/evictable pools become nonzero within days, tiers 1-2 evictable again. |
| 2026-09-01 | hosted | 2c635b7+3wk | partial | [hosted] Scheduled full audit. THE RELEASE MACHINERY WORKS: tier-1 UNPINNED for the first time (131 of 150; ~23 net released post-unshielding), association drain sustained (backlog 1,094 -> 637; 1,144 consumed / 634 created over 21d; consumption liveness same-day), and minting turned selective (only 4 inserts across ~95 hub adjudications - dedup-reinforce and declines dominate). One-round expiry confirmed clean (zero sub-2-round threads hold stale fires). k=11 holds (max cohort 11). Near-dup question CLOSED mechanistically: 0.80-0.85 band pairs (17) have avg cofire ratio 0.32 and 14/17 NEVER co-fired - embedding-near but behaviorally distinct, so the collapse correctly refuses and MINT_DEDUP_COSINE stays 0.85. REMAINING SEDIMENT FOUND: 1,319 verdict-null fires on 34 fully-judgeable threads, all fired pre-08-24 (peak wk 07-27), mechanism = judge per-prediction dropout with cursor advance (a failed batch among successful ones, or an id omitted from the verdict map, is never retried once markEvaluated moves the cursor); leak currently quiescent but shields 65/131 tier-1 rows from probation/evict-1. Fixed same day: `samskara_expire_junk_thread_fires` broadened and renamed to `samskara_expire_unjudgeable_fires` (adds cursor-passed and parked-at-attempt-gate clauses). WATCH: tier-2 30d held rate 0.687 vs tier-1 0.764 - the August edge (0.819 vs 0.785) flipped negative; mint rate stayed low (65 total, +5/3wk, declines still 1) so the pre-registered re-open condition is NOT met, and the fleet model swap (~08-20, GLM 5.3 Flash) confounds verdict-standard drift. |
| 2026-09-07 | hosted | 46d3392 (t0+41h) | pass | [hosted] Scheduled day-one check after the 2026-09-06 03:26Z corpus reset under PR #534 (per-register centered cosine). DEPLOYED AND LIVE: centering row present (substrate mean from 3,553 rows, claim mean from 47), refreshed hourly on schedule; the new-code RPCs (refresh_centering, reinforce_existing, collapse_by_cofiring, tier2_candidate) all succeed in the edge request log; every cron job clean (0 failures across ~2,400 runs). INTAKE OPEN: 53 tier-1 claims in 41h (31 on day one), all stamped gte-small, 0 stale-space, 0 null vectors, 0 pre-t0 rows. Dedup absorbed ~46 mint attempts (reinforce calls) against ~53 survivors, i.e. ~45% absorption - above the ~20% expected, but the corpus formed from 7 conversations with the recency probe re-clustering the same material hourly; survivors' claim-centered NN median 0.321 (p25 0.227 / p75 0.402 / max 0.497), 0 rows at or above the 0.50 bar, so the intake is not closing. COLLAPSE TAME: no cliff (22 -> 20 -> 53); 4 rows with 10+ provenance sources (merge survivors), max 21; 6 judged fires dropped as merge duplicates. FIRE PATH: k median 7, max 11, 0 cohorts over 11; 40 of 47 rows fired by 16:00Z; top-5 share 33% on a 47-row corpus (~3x uniform; the pre-outage 18% on 146 rows was ~5x uniform); within-cohort score spread median 7x. FIRST VERDICTS (Oct 1 baseline; all tier-1, 7 threads): held 121 / not-borne-out 32 / not-engaged 305 / contradicted 0 / pending 103 (fired today) -> genuine-test held rate 79% (n=153). Score-outcome by score quartile among genuine tests: 69% / 82% / 71% / 95% (n~38 each); over all judged incl. not-engaged: 18% / 26% / 21% / 40% - positive at the top, noisy below. p0 0.955 (past the 20-tally cold fallback of 0.66 within the first day). HEALTH NOTE: day-one verdicts were posted under the 0.66 cold prior (tested rows sat at 0.63-0.76 while fresh mints sit at the 1.0 column default), which ranked unproven claims above proven ones until the deploy-time reconcile re-asserted p0 - now 0.95-0.98 across the corpus with only same-hour mints at 1.0. Pre-existing (the mint path writes no health); low priority. Tier-2: 0 rows, 0 declines, 13 candidate probes (too early). Still open: nak-embed-backfill still fires every minute against an empty queue (2,195 idle runs since t0) - relax it to every five minutes. |
| 2026-10-01 | hosted | a156285 (t0+25d) | partial | [hosted] Scheduled first clean-window audit of the recalibrated corpus (t0 2026-09-06 03:26Z reset). CORPUS: 150 tier-1 + 26 tier-2; reachability 100% (0 stale-space, 0 null vectors, all stamped gte-small); weekly surviving tier-1 mints 78 / 26 / 35 / 11, corpus 79 -> 115 -> 164 -> 176 with no cliffs (max provenance sources 35, 6 rows at 20+; 0 collapse-eligible pairs now - of 858 pairs co-firing 3+ times only 7 clear the 0.30 centered floor and none reach the 0.5 ratio). Claim-centered NN: median 0.344 (p25 0.283 / p75 0.401 / max 0.490), 0 rows at or above the 0.50 dedup bar - intake stayed open until the cap. CAP PINNED since 09-30 (150/150 on the 24th day) with all three eviction tiers EMPTY: untested-over-14d-with-10-judged-fires 0 (11 such rows carry 1-9 judged fires and will cross), stale 0 (90d gate), health 0 (bar 0.85*p0 = 0.750 vs min health 0.762; 9 rows under 0.80); probation (45d) first eligible 2026-10-21. Both mint probes log 'at cap, nothing evictable; skipping' (10 of the last 24h ticks); association consumption stopped 09-29 18:23 while edges keep arriving (848 unconsumed, +46/week) and a hub is available (cluster RPC returns 3 rows). Same shape as the 2026-08 starvation but with a known cause: every release path is age-gated and the corpus is 25 days old. Expected to self-release within 1-3 weeks; hard backstop is the 10-21 probation date. Re-check mid-October; if still pinned past 10-21 with probation flowing, the tier-1 evict gate (14d + 10 judged fires) is the lever. FIRING: k median 8 / max 11 / 0 over 11; concentration top-5 share 31% -> 19.5% -> 16.9% -> 16.4% by week (pre-outage reference 18% on 146 rows) - healthy and improving; within-cohort score spread median 2.2x. SCORE-OUTCOME (first measurement of the planned-changes metric; 1,139 genuine tests): held rate by score quartile 72% / 71% / 67% / 73% - FLAT; engagement rate (situation arose) by within-cohort rank on multi-round threads 40% / 37% / 39% / 40% for ranks 1-2 / 3-5 / 6-8 / 9-11 - FLAT. Within the fired set, position carries no measurable signal; whether SELECTION (top-11 of 150) carries signal is untestable without a control arm (see planned-changes). JUDGE: pending 11 (all under 3d, one thread), parked 0, orphans 0; 4-week verdict mix held 808 / not-borne-out 330 / contradicted 12 (first non-zero in months) / not-engaged 1,898 (63% of judged); genuine held rate 71.0% tier-1 vs 70.7% tier-2 (EQUAL); weekly tier-1 82.7 / 51.4 / 69.3 / 77.9 - the week-2 dip spread over 5+ threads and recovered. HEALTH: p0 0.883; tier-1 health 0.762-1.000, median 0.869; 99/150 tested; mean evidence 1.71 (max 9.31). The judge log line shows evidence count = genuine count ('51/51 predictions; held=13 ... not-engaged=33; evidence applied to 18'). CRON: 0 failures across ~39k runs since 09-07; centering refreshed 09-30 22:23 (last activity 20:36), claim_count 176 = corpus, both means present; compound summary regen 09-30 16:23 (within the 24h ceiling); Health snapshot eviction predicates verified identical to the evict RPC by reading both. CANDOR CHANGE (09-07; 123 tier-1 mints since): confidence now spans 0.70-0.94, median 0.87 (was pinned 0.94-0.97) - half-landed; 2 of 123 negative valence; 0 claims in the assistant-failure shape (the substrate carries almost no assistant-failure rounds, 0.8% negative valence, so the input rather than the prompt is the limit); the regenerated summary DOES carry friction now (honest-hedging and retention-limit cautions, 'concede gracefully when their readings beat the model'). Still open: nak-embed-backfill every minute against an empty queue (34,323 idle runs since 09-07). |
| 2026-10-02 | hosted read-only (predicate dry-run; no live eviction) | audit branch | partial | Graduation tier added as the fourth, last-resort cap-pressure eviction (step 3b above; snapshot column `evictable_graduated`). Baseline before deploy, prod corpus 150 tier-1 / 26 tier-2 / 35 distinct children: graduation pool 0 - 4 compounds carry >= 3.0 evidence and 5 are >= 14 days old, but no compound yet clears all three gates with health >= p0 (0.883), so the first graduation waits on a compound maturing. The three older tiers were also empty at measurement (cap pinned since 09-30); probation opens 10-21. Expectation for the 10-22 check: `evictable_graduated` equals the hand-run predicate as the user; once a compound establishes, its least-evidenced part is the victim and the compound plus its provenance survive. |
