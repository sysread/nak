# Samskara tier-2 mint: lift-gated co-fire constellation detection

## Covers

The sweep-only `mint-tier2` phase (`mintTier2Probe`) and its
detection RPC `samskara_tier2_candidate`: the **lift gate** that
replaced raw-co-fire ranking (so base-rate-bound busy pairs no
longer dominate), the **seed iteration** that advances past a
covered constellation instead of returning empty, the coverage
skip against existing tier-2 child-sets **and recent minter
declines** (`samskara_tier2_declines`, TTL'd), and the `'samskara'`
provenance the minted compound carries back to its tier-1
children. Detection upstream of the minter is the focus; the
producer side (tier-1 formation, co-fire recording) is covered by
[samskara-formation](./samskara-formation.md).
([dev: samskara](../../dev/samskara.md) - Tier-2 detection formula;
plan:
[tier2-detection-quality](../../dev/plans/samskara-tier2-detection-quality-plan.md))

Sweep-only by design: the turn tail does not run this phase, so it
is exercised via the `nak-samskara-sweep` cron route (or the dev
shim's tick), never a chat turn.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev
  user, Logs drawer open at `Trace+`. (Or run the SQL checks
  read-only against the hosted project - the **[hosted]** rows in
  the results log are that path.)
- Schema applied at the commit under test (`mise run sync` or the
  deploy): `samskara_tier2_candidate` carries the lift signature.

  ```sql
  select p.proname,
         pg_get_function_arguments(p.oid) as args
    from pg_proc p
   where p.proname = 'samskara_tier2_candidate';
  -- expect args to include p_min_lift real and p_min_cofires int
  -- (NOT p_min_cofire_ratio - that is the dedup function)
  ```

- A fired tier-1 corpus with co-fire structure: at least 8 tier-1
  samskaras with `fire_count > 0`, and at least one pair clearing
  the lift gate. The dev corpus may already have this; confirm the
  eligible pool is non-empty:

  ```sql
  with pc as (
    select least(f1.samskara_id,f2.samskara_id) a, greatest(f1.samskara_id,f2.samskara_id) b,
           count(*)::int cof
      from samskara_fires f1 join samskara_fires f2
        on f1.cohort_id=f2.cohort_id and f1.samskara_id<f2.samskara_id
     where f1.user_id='<user>' and f2.user_id='<user>'
     group by 1,2 having count(*)>=10
  ),
  n as (select count(distinct cohort_id)::real c from samskara_fires where user_id='<user>')
  select count(*) eligible
    from pc cross join n
    join samskaras sa on sa.id=pc.a and sa.tier=1
    join samskaras sb on sb.id=pc.b and sb.tier=1
   where pc.cof*n.c/greatest(sa.fire_count::real*sb.fire_count,1) >= 2.0
     and (1-(sa.prediction_embedding<=>sb.prediction_embedding)) >= 0.30
     and (1-(sa.prediction_embedding<=>sb.prediction_embedding)) <  0.68;
  -- expect: >= 1
  ```

## Steps

1. **Record the pre-state.** Count existing tier-2s and capture the
   default candidate the RPC surfaces:

   ```sql
   select count(*) from samskaras where user_id='<user>' and tier=2;
   select samskara_id, left(prediction,60) prediction, round(cofire_weight) w
     from samskara_tier2_candidate(p_user_id := '<user>');
   ```

2. **Confirm lift and raw co-fire disagree (the regression
   contrast).** The fix matters only if the busiest pairs are NOT
   the most-associated. Rank the in-band co-fire pairs both ways and
   eyeball that the top-by-cofires rows are busy-but-low-lift
   (base-rate binding) while top-by-lift rows are the genuinely
   coupled pairs the RPC now seeds on:

   ```sql
   with pc as (
     select least(f1.samskara_id,f2.samskara_id) a, greatest(f1.samskara_id,f2.samskara_id) b,
            count(*)::int cof
       from samskara_fires f1 join samskara_fires f2
         on f1.cohort_id=f2.cohort_id and f1.samskara_id<f2.samskara_id
      where f1.user_id='<user>' and f2.user_id='<user>'
      group by 1,2 having count(*)>=10
   ),
   n as (select count(distinct cohort_id)::real c from samskara_fires where user_id='<user>')
   select pc.cof,
          round((pc.cof*n.c/greatest(sa.fire_count::real*sb.fire_count,1))::numeric,2) lift,
          left(sa.prediction,40) a_pred, left(sb.prediction,40) b_pred
     from pc cross join n
     join samskaras sa on sa.id=pc.a and sa.tier=1
     join samskaras sb on sb.id=pc.b and sb.tier=1
    where (1-(sa.prediction_embedding<=>sb.prediction_embedding)) >= 0.30
      and (1-(sa.prediction_embedding<=>sb.prediction_embedding)) <  0.68
    order by pc.cof desc limit 6;
   -- then re-run with `order by lift desc limit 6` and compare.
   -- expect: top-by-cof rows have lift ~1 (or below); top-by-lift
   -- rows have lift well above the 2.0 gate.
   ```

3. **Confirm the candidate is uncovered.** Cross-check the member
   ids against every existing tier-2's child-set (Jaccard):

   ```sql
   with cand as (select array_agg(samskara_id) g
                   from samskara_tier2_candidate(p_user_id := '<user>')),
   ex as (select sp.samskara_id t2, array_agg(sp.ref_id) ch
            from samskara_provenance sp join samskaras s2 on s2.id=sp.samskara_id
           where sp.user_id='<user>' and sp.kind='samskara' and s2.tier=2
           group by sp.samskara_id)
   select ex.t2,
          cardinality(array(select unnest(g) intersect select unnest(ch)))::real
          / nullif(cardinality(array(select unnest(g) union select unnest(ch))),0) as jaccard
     from cand, ex;
   -- expect: every jaccard < 0.60 (the coverage-skip floor)
   ```

4. **Tick the sweep.** Hit `nak-samskara-sweep` (dev shim tick, or
   `curl` the local function). Watch the Logs drawer for the
   `mint-tier2` phase line.

5. **Tick the sweep a second time** after the first completes,
   without adding fires.

## Expected

- **Default candidate is a coherent, lift-ranked group of >= 3.**
  The members co-activate well above chance; they are NOT the
  busiest predictions in the corpus. The Step 2 ranking shows why:
  the top-by-cofires pairs sit at lift ~1 (base-rate binding) and
  would have seeded the old grab-bag, while the RPC's lift seeds are
  the genuinely coupled pairs - the regression this fix closes.

- **Candidate is uncovered** (Step 3): every Jaccard against an
  existing tier-2 is below 0.60, so detection is offering a NEW
  constellation, not re-surfacing a minted one.

- **First tick mints (or dedup-hits).** A `mint-tier2: candidate
  group of N tier-1 samskaras` log line, then either
  `mint-tier2: minted` or the embedding-dedup branch. On a fresh
  mint the compound carries `'samskara'` provenance to its children:

  ```sql
  select kind, count(*) from samskara_provenance
   where samskara_id='<new-tier2-id>' group by kind;
  -- expect: a 'samskara' group, count = the child count (>= 3)
  select tier from samskaras where id='<new-tier2-id>';  -- expect: 2
  ```

- **Seed iteration advances.** After the first mint covers its
  constellation, the next `samskara_tier2_candidate` call returns a
  DIFFERENT uncovered group (or empty only if no uncovered
  constellation clears the gate) - it does NOT return empty merely
  because the strongest edge is now covered. This is the
  winner-take-all fix: re-run the Step 1 candidate query and confirm
  the member set changed.

- **Quench is honest.** When no uncovered constellation clears the
  lift gate, the phase logs no candidate and spends NO Venice call.

- **Decline path records and advances.** If the minter returns
  `confirm:false`, `mintTier2Probe` writes the candidate's sorted
  child-set to `samskara_tier2_declines`, and the next tick's
  `samskara_tier2_candidate` treats that group as covered (Jaccard
  against the recent-decline set), so detection advances to a
  DIFFERENT uncovered group instead of re-offering the same one. The
  decline is TTL'd (7 days): after the window the group re-qualifies,
  since its co-fire structure may have strengthened. A `null` from the
  minter (transport/parse failure) is NOT a verdict and records
  nothing - the group stays offerable. Verify after a decline:

  ```sql
  select group_key, cardinality(children) n, declined_at
    from samskara_tier2_declines where user_id='<user>'
   order by declined_at desc limit 5;
  -- expect: a row whose children match the just-declined candidate;
  -- then the next samskara_tier2_candidate(...) call returns a group
  -- with a DIFFERENT member set (or empty if nothing else clears the
  -- gate).
  ```

## Cleanup

- Delete any tier-2 minted during the run (cascades its provenance;
  the tier-1 children are untouched):

  ```sql
  delete from samskaras where id='<new-tier2-id>';  -- cascades provenance
  ```

- Retain organically-formed tier-2s. A real compound stands on its
  own embedding and fire history; deleting it loses signal.

## Results log

Append-only; one row per execution. Date, environment, commit.

| Date | Env | Commit | Result | Notes |
|------|-----|--------|--------|-------|
| 2026-06-16 | hosted read-only (offline sim) | 5cdc34a | partial (SQL/detection layer only; no live sweep) | No browser/edge runtime here, so the mint half (sweep route, minter call, provenance insert, toast) is unexecuted. Detection validated by replaying the rewritten seed + grow + coverage in code against a hosted data dump (4727 in-band co-fire pairs, 150 tier-1, 1786 cohorts, the existing tier-2's 6 children): raw-co-fire seeds rank the grab-bag (emoji + pork chops + Thai, all lift < 1.5) to the top; lift seeds rank genuine constellations (2x-25x) instead. At the shipped defaults (p_min_lift 2.0, p_min_cofires 10) the default call emits on probe 1 a 6-member group with Jaccard 0.00 vs the existing tier-2 (uncovered) - so a second tier-2 can mint. NOT covered: the actual sweep firing the probe, the minter confirm, the `'samskara'` provenance landing, the seed-iteration-after-mint step (needs a real mint to cover the first constellation). |
