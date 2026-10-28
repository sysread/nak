# Samskara density admission: the cap replacement (plan)

Status: DRAFT rev 2, 2026-10-28. Rev 1 revised from a fresh-context
review that caught three blockers: the register choice contradicted
the measured claim-vs-claim distributions (a substrate-mean floor
would density-reject nearly every mint); the eviction passes'
only trigger is cap pressure, which the demotion removes; and the
plan premised the unmerged dormancy branch as live. Owner's framing:
no hard numerical caps - a capacity number demotes to a tripwire
arming only on a pathological condition, while the real limiter is a
quality judgment (density-based admission). BUILT (M1-M4, 2026-10-28,
three self-review rounds converged): where this plan's milestone text
differs from the shipped code, the code is the better side - the RPC
signature follows the sibling overload pattern (p_user_id last,
default null) and returns neighbor_count (not `count`); the
UNDERPERFORMER pass deliberately keeps the eviction function's
no-pending-guard divergence; the admission mix carries six outcomes
(four adjudications + the recency probe's two terminal losses); and
corpusAtCap was RENAMED tripwireArmed with the demotion.

## SYNOPSIS

Mint-time admission becomes a two-stage quality judgment: the
existing hard-twin dedup (1-NN >= 0.50, claim-mean register) catches
twins; a NEW density check counts ESTABLISHED claims in the
candidate's neighborhood (claim-mean register, floor 0.40) and
rejects the mint when the count reaches DENSITY_K - reinforcing the
nearest established claim instead. The evidence-based eviction
passes (UNTESTED-JUNK residual, STALE, UNDERPERFORMER) move to the
:13 reap cron as unconditional evidence reapers. The hard 150
population cap demotes to a POPULATION_TRIPWIRE (300) that halts
minting on a pathological condition. Corpus size becomes emergent.

## PURPOSE

- The 150 cap is a hard constant metering formation against test
  throughput - the pattern the owner rejects (limits-as-limits on
  legitimate traffic; the accepted exception pattern is tripwires
  arming on pathological conditions).
- The cap's original justification (keep the corpus tested by
  forcing replacement) is dissolved by shipped machinery: the warmup
  pool delivers pre-tested claims; the dormancy reaper removes
  claims that never engage. What remains unhandled is the ENTRY
  side: a claim that restates an idea the corpus already represents
  should not enter at all.
- The existing dedup is a single-neighbor check (1-NN >= 0.50 under
  the claim-mean register → reinforce). It misses
  spread-redundancy: a claim 0.45-similar to FIVE established claims
  is redundant even though no single row is a twin. The dormancy
  data shows the cost: claims minted into dense neighborhoods that
  never engaged (the collected junk claims' histories).

Out of scope: the judge's verdict-scale recalibration (deferred to
the M5 agreement readout); the dormancy reaper's constants; the
formation probes' cadence.

## SEQUENCING (the stack)

This plan sequences after the dormancy reaper branch
(samskara/dormancy-reaper: plan rev 2, implemented, QA passed, not
yet merged). ORDER OF OPERATIONS:

1. Land the dormancy branch on main first (it is QA'd; its M0 gate
   needs the overnight data only main's cron will produce).
2. Rebase THIS branch onto the dormancy merge; M0's inspection runs
   on the combined state.
3. Build M1-M2 behind the M0 gate - M1 carries the tripwire demotion
   (per DESIGN and the gotcha below: the live dormancy reaper and
   warmup pool are the active limiters during the transition, and all
   milestones ship in one PR, so the demotion cannot wait for the
   post-deploy M5 readouts); M3 calibration; M4 surfaces; M5
   readouts. Further changes beyond this plan (e.g. removing the
   transition eviction wiring) gate on the M5 readouts.

## DESIGN

- **The density check runs at mint time, in BOTH probes, after the
  existing dedup.** Order: hard-twin dedup (1-NN >= MINT_DEDUP_COSINE
  0.50, claim-mean register, unchanged) → density check → mint. The
  density check counts ESTABLISHED claims whose centered cosine to
  the candidate (CLAIM-mean register, `_samskara_claim_centering_mean`
  - the mint dedup's own register, calibrated for claim-vs-claim) is
  >= DENSITY_FLOOR. If the count >= DENSITY_K, the mint is rejected:
  the candidate's evidence reinforces the nearest established claim
  (the samskara_reinforce_existing path) and the probe logs the
  rejection.
- **The register: CLAIM mean.** The density question is
  claim-vs-claim ("is this idea already represented in the claim
  corpus") - the mint dedup's register, calibrated for
  claim-vs-claim comparison. The measured distributions drove this:
  claim-vs-claim nearest-neighbor median is 0.404 under the claim
  mean vs 0.648 under the substrate mean (samskara.md:939-942) - a
  0.35-0.40 floor under the SUBSTRATE mean would count nearly every
  established claim and density-reject every mint (rev 1's blocker,
  caught by review). The fire path's substrate-mean register stays
  where it belongs: message-vs-claim firing. The M3 probe set is the
  EXISTING claim-pair set (claim-mean, matching) - no new register
  needed.
- **Established-only counting is the entrenchment mitigation.** A
  neighborhood of unproven newcomers must not gate a genuinely new
  claim. ESTABLISHED = confirm_count + disconfirm_count > 0 AND
  activated_at is not null: a claim with any genuine test (live or
  backfill-folded) that has ACTIVATED. Quarantined claims never gate
  (the warmup pool's domain; their tallies exist but they are not
  yet part of the live corpus).
- **The constants: DENSITY_FLOOR (initial 0.40, claim-mean register)
  and DENSITY_K (initial 3).** 0.40 sits below the dedup bar (0.50,
  same register - comparable scales now) and at the measured
  nearest-neighbor median: the median claim has ~1 neighbor above
  the floor; DENSITY_K = 3 rejects the densest neighborhoods. Both
  are set from the existing labeled claim-pair probe set before
  deploy (the house discipline).
- **The reinforce target: the nearest ESTABLISHED claim in the
  window.** When density rejects, the candidate's evidence
  reinforces the closest established claim (not an unproven one -
  dedup's no-filter 1-NN can hit an unproven claim; the density
  rejection's reinforce must not).
- **The 150 demotes to a tripwire.** corpusAtCap's limit becomes
  POPULATION_TRIPWIRE = 300: armed, the mint probes halt and log at
  warn (an armed tripwire means something is broken - density
  admission should have kept the corpus bounded). The collapse RPC's
  overflow pass (target 150) demotes identically (target =
  POPULATION_TRIPWIRE); in steady state it should never fire - a
  firing is a calibration alarm (distinct from a race overshoot,
  which the readout tracks separately by population-at-fire).
- **The eviction passes move to evidence-based unconditional
  execution.** Their ONLY trigger today is cap pressure
  (ensureMintHeadroom → corpusAtCap → samskara_evict_for_mint,
  agents/samskara.ts:1217) - the demotion removes that trigger, and
  the tiers would become unreachable. They are evidence standards
  that stand on their own:
  - the UNTESTED-JUNK pass (10+ judged fires, zero genuine
    engagements, 14+ days) - partially covered by the dormancy
    reaper (which catches 15-fire all-not-engaged runs across 5+
    threads); the 10-14-judged and sub-5-thread residual shapes
    remain;
  - the STALE pass (weakly-established gone stale: tally <= 1.0, 90
    days since the last genuine verdict) - NOT covered by dormancy
    (a claim with one old held has no not-engaged streak);
  - the UNDERPERFORMER pass (demonstrated failure: health below 85
    percent of p0) - NOT covered (reap_dead's floor is 50 percent of
    p0 plus 14 quiet days).
  New `samskara_reap_evidence()`: set-based, runs the three
  eviction predicates (the passes above - named by content, NOT
  "tiers": that word now belongs to the retired compound layer)
  unconditionally on the :13 reap cron (with the pending-fire
  guards), deleting qualifying victims. Death by
  evidence, not by capacity - the same principle as the dormancy
  reaper. `samskara_evict_for_mint` KEEPS its cap-pressure role
  during the transition (an armed mint normally halts; eviction
  fires only in the window before the next reap tick collects a row
  that just crossed a predicate - the function is dead code in
  steady state, noted for later removal).
- **The failure mode is open, not closed.** A density-rejected
  claim's substrate evidence stays in the corpus (the observations
  remain; a future re-mint when the neighborhood thins can mint it
  fresh).

## M0 - THE MORNING INSPECTION (gates the build)

Tonight's conversations generate the first organic data through all
of the shipped changes. After the dormancy branch lands, inspect and
square:

1. The warmup pool: activations from last night's mints (the
   backfill judged them against history).
2. The dormancy reaper: collections (the first prod passes; the
   four junk claims' outcomes).
3. Tonight's mints: the admission mix so far (dedup-reinforced vs
   minted vs declined).
4. The judge's verdicts on yesterday's fires (the M5 agreement
   readout's first samples).

If the data contradicts the plan's premises (e.g. the warmup pool
misbehaves, or the admission mix shows the dedup bar already
rejecting everything), revise before building.

## M1 - SCHEMA

- RPC `samskara_density_check(p_query_embedding vector(2048),
  p_user_id uuid, p_floor real) returns table (count int,
  nearest_id uuid, nearest_cosine real)` - the count of ESTABLISHED
  claims (tallies > 0, activated) whose centered cosine to the
  candidate (CLAIM-mean register, `_samskara_claim_centering_mean`)
  is >= p_floor, plus the nearest established claim's id and cosine
  (the reinforce target). Cold-start gate: when claim centering is
  not ready (below the readiness floor), SKIP (return count 0 + the
  readiness flag via a nullable nearest_id... concrete shape: return
  `ready boolean` as a column; the mint path skips the density
  branch when not ready - the house SKIP-not-raw pattern for
  decisive claim-space work).
- `samskara_reap_evidence()` - set-based, the three tier predicates
  (untested-junk, stale, underperformer) run unconditionally with
  the pending-fire guards, on the :13 reap cron after the dormancy
  reaper. Constants declared; the parity/sync discipline with
  `samskara_evict_for_mint`'s copies (the eviction function keeps
  its copies for the cap-pressure transition; both pinned by the
  schema-reading test).
- corpusAtCap's limit → POPULATION_TRIPWIRE = 300, warn-log when
  armed. The collapse RPC's p_target_count default → 300 with the
  existing mirror-comment + parity-test discipline.
- The grants block and schema-reading tests updated.

## M2 - THE MINT PATH

- agents/samskara.ts: after the dedup check, the density check - one
  RPC call, the DENSITY_K comparison, the reinforce-nearest branch on
  rejection (logging `mint: density-rejected (K established claims
  in neighborhood)`), and the admission-mix debug line on every
  outcome (minted / dedup-reinforced / density-rejected / declined).
- The association-mint probe gets the same gate (shared helper). A
  density rejection in the association probe is a VERDICT: the hub's
  edges stamp consumed (mirroring the dedup-hit semantics) - a
  non-verdict would re-feed the hub every sweep (the documented
  re-ask pathology).
- The fail-open property is inherited deliberately: a density-RPC
  failure logs and proceeds with the mint (better a possible
  redundant claim than a dropped signal; the dormancy reaper is the
  cleanup lane).

## M3 - CALIBRATION

- The floor and K set from the EXISTING labeled claim-pair probe set
  (claim-mean register - matching). Before deploy.
- The dormancy reaper's collected-claims history is the negative
  calibration data: claims minted into dense neighborhoods that
  never engaged are evidence the floor was too low.

## M4 - SURFACES

- Density rejections log via the mint probes' existing Logs-drawer
  lines (no new ledger table in v1; the M5 readout counts from the
  logs). The association probe's edge-stamp verdict semantics above.
- docs/dev/samskara.md: the admission section (dedup → density →
  mint order, the claim-mean register, the tripwire demotion, the
  evidence-reaper migration).
- docs/user/samskara.md: unchanged (density rejection is invisible -
  the claim just doesn't appear).
- docs/qa/use-cases/samskara-density-admission.md: forge K+1
  established claims in a neighborhood, mint a restatement, assert
  rejection + reinforcement; the entrenchment case (K unproven
  neighbors + mint -> minted); the tripwire arms at 300; the cold-
  start skip; the evidence reaper's tier cases.
- tests: the schema-reading pins (the density RPC's register,
  tally gate, cold-start skip; the evidence reaper's tier
  predicates; the POPULATION_TRIPWIRE/ p_target_count parity), the
  admission-order test in the mint-path test file.

## M5 - READOUTS

- The admission mix: minted / dedup-reinforced / density-rejected /
  declined, per week (from the mint probes' log lines).
- The corpus trajectory post-demotion: does the population
  stabilize below the tripwire without the cap?
- The evidence reaper's collection rate vs the dormancy reaper's
  (is death keeping pace with admission?).
- Race-overshoot vs miscalibration: an overflow firing at population
  301 is a race; one at 400 is miscalibration - the readout records
  the population at fire.
- The tripwire: never armed in steady state (armed = the density
  constants are mis-calibrated - the alert is the signal).

## GOTCHAS AND PREMISES

- The register split is load-bearing and now correctly split: the
  twin dedup AND the density check both use the CLAIM mean
  (claim-vs-claim work); the fire path keeps the SUBSTRATE mean
  (message-vs-claim work). The register warning lives at
  schema.sql:8358-8371 (rev 1 cited 8260-8272 - wrong lines, caught
  by review).
- The tally gate makes the density count DEPEND on the judge's
  history: a neighborhood of untested claims admits freely until
  they establish. Accepted: unproven claims must not gate (the
  entrenchment mitigation), and the dormancy reaper is the backstop
  for untested junk. Quarantined claims never gate (activation
  required) - a backfill-folded tally does not establish a claim
  until it activates.
- The 150 → 300 demotion doubles the ceiling BEFORE the density
  gate is proven. Sequenced deliberately: the dormancy reaper (live)
  and the warmup pool (live) are the active limiters during the
  transition; the tripwire arms only at 300; the M5 readouts gate
  any further change.
- The collapse overflow pass (evidence-free cosine merging) keeps
  running but at the demoted target: with density admission the
  overflow should never fire in steady state - a firing is either a
  race overshoot (population 301) or a calibration alarm (population
  well past 300); the readout distinguishes them.
- The eviction passes' migration: the STALE and UNDERPERFORMER
  passes move to the :13 cron unconditionally (evidence standards);
  the UNTESTED-JUNK pass's core is subsumed by the dormancy reaper,
  its residual shape (10-14 judged, sub-5-thread zero-engagement)
  stays in the evidence reaper; `samskara_evict_for_mint` becomes
  dead code unless the tripwire arms - noted for later removal, not
  deleted in this plan. (Naming note: the eviction function's
  internal comments number these passes "tier 1/2/3" - colliding
  with the retired compound layer's tier vocabulary; the schema
  comment rename rides this plan.)
- The rollback story: reverting re-arms the 150 cap - and the
  overflow pass would then drain the corpus back via evidence-free
  merges (the old treadmill). Note for the rollback runbook: demote
  the overflow target back to 150 ONLY together with re-arming the
  cap, or the treadmill resumes; and re-arming does not drop the
  deployed `samskara_reap_evidence()` copy (the revert removes its
  definition from schema.sql but not the function from the database)
  - drop it manually or leave it orphaned (uncalled once the cron
  statement reverts, harmless).
- The reinforcement bump is not evidence: the +0.02 health bump
  moves an established claim's posterior off its evidence-derived
  value - the existing dedup pattern, reused deliberately.
- The tripwire inherits corpusAtCap's fail-open: a persistent count
  failure silently disables the tripwire; only the overflow pass
  remains as backstop. Accepted (the existing behavior).

## WHAT THIS PLAN REPLACES

- The 150 population cap as a routine limiter (demoted to the
  tripwire; the lifecycle plan's decision 6 parking resolves).
- The eviction tiers as cap-pressure-only machinery (their evidence
  predicates move to the :13 reap cron; the cap-pressure eviction
  function becomes transition-only dead code).
- Nothing else: the warmup pool and dormancy reaper are untouched;
  the judge recalibration stays deferred to the M5 agreement
  readout.
