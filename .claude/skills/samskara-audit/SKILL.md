---
name: samskara-audit
description: Full stem-to-stern health audit of the samskara system - walk every pipeline stage, state the contract each stage assumes of the one before it, verify each contract against live data, and only then synthesize a whole-system verdict. Use for "how is the samskara system doing", periodic check-ins, or any diagnosis that risks tunnel-visioning on one symptom. Runs against the cloud project (Supabase MCP); read-only.
---

# Samskara system audit

The samskara pipeline is a chain of queues and transforms. Every past
production failure has been a CONTRACT failure between two stages that
were each individually "working": the judge truncated silently while
firing worked; eviction had no victims while the association graph
grew; probe order starved one mint path while the other minted. A
symptom surfaces at one stage; the cause lives at another.

Therefore this audit is a fixed sweep, not a symptom chase. **Run the
whole battery before diagnosing anything.** An anomaly found at stage
N does not license skipping stages N+1..end - the later stages are
where its cause or its blast radius usually is. Produce the synthesis
only after the last check.

## Ground rules

1. Read [`docs/dev/samskara.md`](../../../docs/dev/samskara.md) first -
   it is the map, including the Gotchas that explain readings which
   look broken but aren't (e.g. "awaiting mint never reaches zero").
2. Read the CURRENT tunables from code before checking data - do not
   trust remembered values. Constants live in
   `supabase/functions/venice/agents/samskara.ts` (caps, cosine bars,
   probe budgets), `supabase/functions/venice/priming/samskara-format.ts`
   (K_BASE, score floor), `supabase/functions/venice/agents/samskara_evaluation.ts`
   (batch size, attempt gate), and the SQL functions in
   `supabase/schema.sql` (eviction tiers, reap floors, collapse bars,
   p0). If local code may be stale, fetch main first.
3. Every mutation is off-limits: the audit is read-only. Manual sweep
   triggers or resets are separate, explicitly-approved actions.
4. The user id: `select id, email from auth.users` - do NOT assume the
   first row is the active account; pick by edge volume or ask.
5. Report in plain language. The reader knows the product, not the
   internals: name stages by what they do, not by function names, and
   lead with what is going well/poorly overall.

## The stage chain and its contracts

Walk these in order. For each: state the assumption, run the check,
record verdict = HOLDS / VIOLATED / INSUFFICIENT DATA. The queries are
sketches - adapt to current schema, keep them read-only.

### 1. Capture -> assimilation

Contract: chat activity produces substrate stubs, and the assimilator
drains them (junk gate: 1-round threads wait forever BY DESIGN).

```sql
select count(*) filter (where situation is null) as raw,
       count(*) filter (where situation is not null) as assimilated,
       max(created_at) as newest, max(updated_at) as last_advance
from samskara_substrate where user_id = :u;
```

Healthy: raw stays near zero across sweeps (minus the junk-gated
tail); last_advance is recent when the user has been active.

### 2. Assimilation -> embedding

Contract: assimilated rows get embeddings promptly (backfill cron
every 5 min).

Check pending-embed depth (the Health snapshot's `pending_embed` or
the substrate embedding-null count). Healthy: ~0.

### 3. Substrate -> association graph (pair-relate)

Contract: the relator keeps finding cross-row relations; edges accrue
reinforcement rather than duplicating per phrasing.

```sql
select count(*) as edges, count(*) filter (where minted_at is null) as unconsumed,
       max(created_at) as newest_edge, max(minted_at) as last_consumed
from samskara_associations where user_id = :u;
```

Healthy: newest_edge recent; unconsumed level explained by the
singleton share (hub picker needs >= 2 distinct partners) plus
inflow/outflow balance - compute both rates over the last N days, not
just the level.

### 4. Association graph + recency window -> tier-1 minting

Contract: BOTH mint probes get headroom when they have evidence.
Headroom = population below cap OR an eviction victim exists.

- Tier-1 count vs cap; `max(created_at)` of tier-1 rows (mint
  liveness).
- Eviction pool: run all victim-tier predicates from
  `samskara_evict_for_mint` (or read the snapshot's evictable
  columns) - all zero while the cap is pinned and evidence waits =
  formation starvation, the known dry-up failure mode.
- Hub availability: `samskara_association_cluster(:u)` returns rows?
- Consumption liveness: edges consumed in the last 48h of ACTIVE use.

### 5. Minting -> corpus quality (dedup and consolidation)

Contract: near-identical claims reinforce instead of accumulating;
behaviorally-redundant pairs get merged by the co-fire collapse.

- Nearest-neighbor cosine distribution across tier-1
  (`prediction_embedding <=> ...`): pairs at/above the mint dedup bar
  should be ~0 (they should have become reinforcements or merges).
- New-mint crowding: for mints in the last ~2 weeks, max cosine to the
  corpus that predated each. Median near the dedup bar = minting
  variants of known instincts; check whether the co-fire collapse is
  catching up (are older near-band twins still separate rows?).

### 6. Co-fire graph -> tier-2 aggregation

Contract: recurring co-fire constellations become compounds, and the
tier-2 minter actually filters (declines exist).

- Tier-2 count and growth rate; decline count
  (`samskara_tier2_declines`); tier-2 share of corpus. All-confirm
  with steady growth = rubber-stamp suspicion (open calibration item
  in `docs/dev/planned-changes.md`).

### 7. Corpus -> firing (priming)

Contract: fires per cohort match the configured k; recorded cohort =
rendered set (post-2026-08 contract).

```sql
select count(*)::float / count(distinct cohort_id) as fires_per_cohort,
       count(distinct cohort_id) as cohorts
from samskara_fires where user_id = :u and fired_at > now() - interval '7 days';
```

Healthy: at or below the current kMax (score floor trims); way above
it means the recording contract regressed.

### 8. Firing -> judging

Contract: fires get verdicts the NEXT day; the backlog is bounded by
"today's fires plus still-active threads", not growing without bound.

- `verdict is null` count vs fires in the last 24h (same order =
  healthy; multiples = judge falling behind).
- Threads parked at the attempt gate (evaluation_attempt_count >= 3)
  - should be ~0; parked threads mean the judge is failing on their
  transcripts.
- Verdict mix over 7/30 days (held / contradicted / not-borne-out /
  not-engaged). Not-borne-out ~0 or contradicted ~0 for weeks = the
  judge prompt may have regressed toward a degenerate verdict.

### 9. Judging -> health

Contract: health = confidence = the posterior; low health is earned
by misses; p0 tracks the aggregate hit rate.

- p0 now vs prior audits; health min/median/spread; count near/below
  each release bar (reap floor, eviction bar). A spread collapsing
  toward p0 = evidence not discriminating; everything hugging 1.0 =
  the pre-judge bug shape.

### 10. Population control (the release paths together)

Contract: probation reap, dead reap, eviction, and collapse together
keep the corpus turning over - some release path fires within any
multi-week window of active use.

- Deletions/merges are not directly logged: infer from tier-1 count
  history, `max(created_at)` vs cap pressure, and the evictable/
  probation pools. Zero turnover for weeks at a pinned cap = all
  release paths dry (the 2026-08 failure).

### 11. Corpus -> compound summary and surfaces

Contract: the compound summary regenerates within its staleness
ceiling; the Health panel's snapshot mirrors the SQL predicates
(lockstep - drift here shows the user a pool the workers won't
drain).

- `samskara_compound_summary.last_regen_at` age vs ceiling.
- Spot-check one snapshot column against its hand-run predicate.

### 12. Cron liveness (the whole engine's clock)

```sql
select j.jobname, max(d.start_time) as last_run, bool_and(d.status = 'succeeded') as ok
from cron.job j left join cron.job_run_details d on d.jobid = j.jobid
where j.jobname like 'nak-samskara%' or j.jobname in ('nak-embed-backfill')
group by 1;
```

Note: schema re-applies (every deploy) re-register jobs under NEW
jobids, so join history by command text when the jobid join comes up
empty - an empty history via the current jobid does NOT mean the cron
never ran.

## Synthesis (only after the full battery)

1. **Flow table.** For each queue (substrate raw, pending embed,
   unconsumed edges, unjudged fires): inflow rate, outflow rate, level
   trend. Conservation reasoning catches stalls that levels hide.
2. **Verdict list.** Every contract above with HOLDS / VIOLATED /
   INSUFFICIENT DATA and the one-line evidence.
3. **Cross-stage findings.** For each VIOLATED contract, trace both
   directions: what upstream change caused it, what downstream stage
   is silently degraded by it. (The recurring pattern: a fix at one
   stage shifts a distribution that another stage's threshold was
   calibrated against - e.g. the judge rework emptied the
   never-engaged eviction tier.)
4. **Report.** Lead with the overall verdict, then per-stage results
   in plain language, then proposals ranked by evidence. Compare
   against the previous audit's numbers where recorded (QA results
   logs, `docs/dev/planned-changes.md` baselines). Propose; do not
   implement without approval.
5. **Record.** Durable numbers worth comparing next time go into the
   relevant QA use-case results log or `planned-changes.md` baselines
   in the same session, so the next audit has a yardstick.
