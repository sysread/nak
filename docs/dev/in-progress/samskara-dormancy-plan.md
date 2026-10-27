# Samskara dormancy reaper (plan)

Status: IMPLEMENTED rev 2, 2026-10-27 (QA passed: docs/qa/use-cases/samskara-dormancy.md, steps 1-9). Rev 1 revised from a fresh-context
review: the cohort floor now counts conversations (thread_id) - the
original counted turns (cohort_id is per-turn, so five cohorts can
sit inside one thread on one afternoon); the reaper is set-based
like every existing reaper (no user loop exists in the house shape);
the streak definition is split into the reaper's all-N form and the
UI's true-run-length form; expired-stamp fires are explicitly
counted; the UI branch and snapshot column carry the full reaper
predicate. Owner's framing: measure time in conversations on the
topic, not days - usage is spotty and irregular, so wall-clock
dormancy is wrong.

## SYNOPSIS

The live corpus has claims that fire constantly and never once
engage. `not-engaged` is deliberately a no-op for the health
posterior (a loose match is not a fair test), which is correct per
fire - but it means a claim whose verdicts are ALL not-engaged is
immune to decay: its score freezes, it keeps firing at the top of
every adjacent turn, and nothing in the machinery ever touches it.
Four prod claims produced ~150 of last week's 595 not-engaged fires
this way (verified 2026-10-27 against prod rows: streaks of 68,
49, 34, 30 with zero genuine verdicts among them). This plan adds a
dormancy standard measured in the claim's OWN verdicted fires (event
time), and a set-based reaper that deletes behaviorally dormant
claims unconditionally - not just under cap pressure.

## PURPOSE

- The observed gap: four claims whose judged fires are ALL
  not-engaged over the last 7 days. Two carry historical tallies
  (3.37, 2.0) that freeze because not-engaged applies no discount;
  two are tally-zero and will eventually reach the 45-day probation
  reaper - but only that one, and only by wall clock.
- The existing removal paths all miss them: tier-1 cap-pressure
  eviction requires lifetime-zero engagement AND 14+ days of age AND
  cap pressure (the corpus is under 150, so pressure never comes);
  the stale tier requires tally <= 1.0 AND 90 wall days since the
  last genuine verdict; reap_dead requires health below the floor,
  which a never-batting claim never earns (it sits at p0 and never
  quiets - schema.sql:9887-9909).
- The owner's insight: the pattern itself is the evidence. "Fires
  constantly, never once engages, across many separate
  conversations" means the predicted situation is not part of the
  user's life in the form the claim predicts - regardless of what
  the frozen score says.

Out of scope: any change to the verdict scale (broadening
held/contradicted/not-borne-out, narrowing not-engaged) - that is a
judge recalibration, gated on the M5 agreement readout and the
labeled probe set; not-engaged as ANY input to the health posterior
(the 4x-decay incident, schema.sql:9433-9445, is the recorded
rejection); the cap value itself.

## DESIGN

- **Event-time dormancy standard (the reaper's form).** A claim is
  DORMANT when, among its VERDICTED fires (samskara_fires rows with
  verdict not null, ordered newest first), the 15 most recent are
  ALL not-engaged, AND those 15 span at least 5 distinct
  conversations (thread_id), AND the claim has no unresolved fire
  (the spare-the-pending-test guard every other tier carries), AND
  the claim is activated (quarantined claims are the warmup pool's
  domain; they have no live fires anyway). Constants:
  DORMANT_STREAK = 15, DORMANT_COHORT_FLOOR = 5.
- **Expired stamps count.** `samskara_expire_unjudgeable_fires`
  stamps terminal not-engaged on fires the judge never ruled (the
  conversation never settled enough to judge). Semantically that is
  the same claim - "the situation never arose" - so the streak reads
  VERDICTED fires, not model-judged fires, and the reaper runs AFTER
  expire_unjudgeable_fires in the same cron statement so freshly
  expired stamps are visible. Consequence, accepted: an expired
  stamp can extend a streak without a model ruling. The cron
  statement order becomes expire -> reap_dormant -> reap_dead ->
  reap_untested.
- **Why 15 and 5.** Healthy claims run roughly half not-engaged
  (prod, last 7d: 54% overall). The four junk claims sit at 30-68
  consecutive not-engaged - the margin between junk and healthy is
  wide in observed data; the independence-based 3e-5 figure is an
  underestimate of the margin, not a proof of it. The cohort floor
  closes the correlation that matters: fires arrive per turn, and a
  single hot afternoon could manufacture a 15-streak inside ONE
  thread - so the floor counts distinct thread_id (conversations),
  NOT cohort_id (turns; five cohorts can sit inside one thread).
- **Wall clock stays for silence only.** The 45-day probation reaper
  and the "an idle account never bleeds" property are unchanged:
  "topic never recurs" has no events to count and is inherently
  wall-clock. The division: failed engagement is measured in
  at-bats; silence is measured in days.
- **The newborn guard converts to event time.** Tier-1's 14-day age
  floor was a wall-clock proxy for "has had a real chance." Fifteen
  verdicted fires across five conversations IS having had a real
  chance - no day-counting in the dormancy standard. (A 15-verdict
  claim is also implicitly >= 1 day old: the judge is next-day.)
- **The reaper is set-based, like every existing reaper.** No user
  loop exists in the house shape - reap_dead (schema.sql:9887-9909)
  and reap_untested are single set-based statements over all users.
  One window-function CTE over all verdicted fires (partitioned by
  samskara_id, ordered fired_at desc), aggregated per claim, joined
  to the delete. Cheaper than per-claim correlated subqueries at the
  fire table's size, and it matches the house shape.
- **Death is the existing eviction-style delete, not a new machinery
  class.** Security definer, service_role grant, returns the count,
  runs on the existing :13 `nak-samskara-reap` cron statement
  (schema.sql:15933-15946) after expire_unjudgeable_fires - no new
  schedule, no new runtime. The ordering is documented in the reap
  block's header comment and pinned by tests/samskara-dormancy.test.ts.
- **Interaction with the backfill.** Quarantined claims are
  unaffected (they have their own pin-and-reaper path). M5's
  agreement readout LOSES samples: deleting a dormant claim
  cascades its fires and backfill ledger rows, removing its
  live-vs-backfill agreement pairs from the readout pool. Accepted -
  a dormant claim is exactly the claim whose further judgment is
  noise; its pre-death pairs still count.

## M1 - SCHEMA

`supabase/schema.sql`, idempotent per house rules:

- `samskara_reap_dormant()` - security definer, service_role grant,
  returns int. Set-based: one window-function CTE over verdicted
  fires (partition by samskara_id, order fired_at desc), per-claim
  aggregates (the 15 most recent are all not-engaged; distinct
  thread_id among them >= 5), joined against samskaras (activated
  only, no unresolved fire via NOT EXISTS on verdict-null fires).
  Deletes and returns the row count. The constants are declared as
  SQL `constant`s (dormant_streak, dormant_cohort_floor) with the
  mirror-comment discipline; the pending-fire guard is load-bearing
  (a verdict may be the first genuine test in flight).
- Added to the :13 `nak-samskara-reap` cron statement
  (schema.sql:15933-15946), ordered AFTER
  `samskara_expire_unjudgeable_fires` (freshly expired stamps must
  count toward the streak) and BEFORE reap_dead/reap_untested
  (ordering documented in the cron comment; the schema-reading test
  pins it).
- `samskara_verdict_counts(uuid)` gains `recent_not_engaged_streak
  int` - the claim's CURRENT all-not-engaged run length (true run:
  the rank of the most recent non-not-engaged verdicted fire minus
  one; 0 when the most recent judged fire is genuine; total judged
  when every verdict is not-engaged) - AND `recent_not_engaged_threads
  int`, the distinct conversations the NEWEST 15 verdicted fires span
  (the reaper's predicate is window-scoped, so a run longer than 15 is
  judged by its newest 15). Together these are the UI's dormancy
  signal. Requires the drop-then-create
  the house rules mandate (RETURNS TABLE change) and a subquery
  restructure - the existing RPC is a single aggregate pass with no
  window function (schema.sql:11069-11089); the streak cannot ride
  the existing pass.
- `samskara_health_snapshot()` gains `dormant int` - the FULL reaper
  predicate as a count (15-streak AND >= 5 threads AND no pending
  fire AND activated), in lockstep with the reaper like every other
  mirror column; a drifted copy here reports a pool the reaper
  doesn't drain.

## M2 - SURFACES

- `samskara_verdict_counts` mapper + types
  (src/lib/supabase/samskara.ts, types/samskara.ts): the new field,
  coalesced at the boundary (`?? 0`) so mixed-version windows
  degrade silently.
- `releaseStatus` (src/lib/ui/samskara-browse.ts): a dormancy branch
  gated on the FULL predicate the UI can see - streak >= 15 AND
  threads >= 5 AND counts.pending === 0 (the reaper withholds while
  a fire is pending, or while the run's thread span is under the
  floor; the pane must not promise collection the worker won't
  deliver) - with the same first-position precedence as the warmup
  branch. Copy: "dormant - never engaged in its last 15 judged
  fires; the hourly reaper collects it." Streaks below 15 render
  the existing branches unchanged.
- Health panel: "Dormant" row, informational like "Warming up"
  (never thresholded; hidden at zero with the same rationale
  comment shape).
- docs/dev/samskara.md: the Release section gains the dormancy
  reaper (event-time vs wall-clock division, the constants, the
  thread-vs-cohort rationale, the expired-stamp decision); the
  Interactions ledger notes the :13 cron statement change.
  docs/user/samskara.md: the release status line's new "dormant"
  reading.
- docs/qa/use-cases/samskara-dormancy.md: forge streaks (spanning
  and non-spanning threads, pending-fire guard, a genuine verdict
  resetting the run, expired-stamp contribution via the full reap
  cron statement), assert deletions and survivors; UI states.
- tests: a vitest reading the reaper body out of schema.sql pinning
  N/C, the thread-floor clause, the pending guard, and the cron
  statement order (the schema-grants/backfill-parity file-reading
  precedent); releaseStatus dormancy cases in
  tests/samskara-browse.test.ts; verdict_counts mapper coverage
  (the ?? 0 coalesces, pinned by reading the slice in
  tests/samskara-dormancy.test.ts).

## JOURNEY NOTES (verified benign, recorded)

- A claim deleted while its detail pane is open: the pane renders
  the in-memory row until the next list refresh; verdict_counts and
  provenance return empty shapes rather than throwing; after
  refresh the pane falls to the empty state. No code change.
- A tally-zero dormant claim past 45 days qualifies for BOTH the
  dormancy reaper and the probation reaper; whichever deletes first
  wins, both are in one cron statement, and the health panel may
  list the claim under both columns that hour - informational
  rows, acceptable.
- The reaper and the evaluation sweep (*/10) can race on a verdict
  stamp: a lost UPDATE or a same-instant deletion are the same race
  class reap_dead already has with apply_evaluation; milliseconds
  wide, documented, not engineered for.

## GOTCHAS AND PREMISES

- The pending-fire guard is load-bearing: without it, a claim whose
  first genuine verdict is in flight can be deleted on the strength
  of not-engaged history. The reaper withholds for the claim this
  pass; expire_unjudgeable_fires clears genuinely-stuck pendings in
  the same statement so the deferral is one tick, not forever.
- Claims deleted by the reaper cascade their fires, provenance, and
  ledger rows - standard FK behavior; no tombstone (the lifecycle
  plan's M2 death-certificate milestone is separately pending and
  untouched).
- The four live prod junk claims will be collected by the first
  reaper pass after merge - expected, and the point.
- A claim whose situation is genuinely rare but real (narrow claim,
  busy neighborhood) can be collected: the corpus cap is what makes
  the death defensible (a never-engaging claim occupies a slot a
  better claim could use), and this plan's record preserves the
  reasoning. N is set generously (15) exactly for this case.
- NOT the 4x-decay wound: not-engaged never touches confirm_count,
  disconfirm_count, health, confidence, or p0. The reaper reads
  verdicts; the posterior stays pure genuine tests.

## WHAT THIS PLAN REPLACES

- The "behaviorally dormant" discussion in the 2026-10-27 post-deploy
  review (this document is its resolution).
- Nothing else: eviction tiers, cap pressure, the probation reaper,
  and the backfill machinery are untouched.
