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

1. **Pool visibility.** Run the three victim-class predicates as
   counts (copy them from `samskara_evict_for_mint`'s body) and
   compare with the `evictable`, `evictable_stale`,
   `evictable_unhealthy` columns of
   `select * from samskara_health_snapshot()` executed as the user
   (invoker security - service role sees zeros for `auth.uid()`).
2. **Tier order and the underperformer tier.** Inside
   `begin; ... rollback;`: forge a guaranteed tier-3 victim
   (`update samskaras set health = 0.3, confirm_count = 0.5,
   disconfirm_count = 3 where id = '<row>'`), confirm tiers 1 and 2
   are empty (or forge them empty by picking a corpus where they
   are), then `select samskara_evict_for_mint('<user>');`.
3. **No-victim behavior.** Still inside the transaction, delete or
   restore the forged row, verify all three predicates count zero,
   and call the function again.
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
