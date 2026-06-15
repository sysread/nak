# Samskara Relevance-Gated Decay Implementation Plan

Status: PROPOSED. Not implemented. This doc is the design of record;
the living reference once it lands is `docs/dev/samskara.md` (decay,
reaction, health sections). Sequenced AFTER the advisor-hygiene
cleanup is pushed. Grounded in a read-only prod audit of the single
live user's data on 2026-06-15 - the numbers in **EVIDENCE** are
from that audit and should be re-pulled before implementation, since
the corpus will have moved.

## SYNOPSIS

Samskara `health` currently decays on a **wall-clock cron**
(`samskara_decay_sweep`, twice hourly) that docks a fixed amount per
pass regardless of whether the user was active or whether the
decayed prediction was ever relevant to anything that happened. This
plan **replaces rate-based decay with relevance-gated, event-driven
decay**: a prediction only loses (or gains) health when it was
actually **tested** - i.e. when it fired into a conversation and
that conversation has settled enough to judge whether the prediction
held. A new **next-day retrospective evaluation sweep** (a sibling
of the reflection sweep) becomes the single source of health
verdicts, **replacing** the live 1-10 minute reaction classifier.
The three wall-clock decay rules and the 60-day stale rule are
**retired**. A one-time **repair** reseeds the predictions the
earlier int-truncation bug euthanized, and a **reaper** clears the
genuinely-dead.

## PURPOSE

Decay today answers the wrong question. It asks "how much wall-clock
time has passed?" when it should ask "**was this prediction tested
and found wanting?**" Three concrete failures follow from that:

- **Idle time kills.** The `locked-in-no-feedback` rule docks
  `-0.03` every cron pass - 48 passes/day - on any samskara with
  `fire_count > 10` and `< 0.5` accumulated reaction weight. That is
  `~-1.44`/day of **elapsed time**, so a prediction craters from 1.0
  to 0 in ~17 hours whether the user sent 200 turns or none. Step
  away for a few days and the corpus dies with no chance to earn
  signal.

- **Relevance-blindness kills.** Decay fires on **all** matching
  rows every pass, including predictions whose topic never came up.
  "When discussing <narrow topic>, the user tends to <Y>" should not
  lose health on days that topic is absent - it was never given the
  chance to be right. A prediction that is simply **untested** is not
  the same as one that is **wrong**.

- **The feedback signal is nearly absent.** The live reaction
  classifier only resolves a tiny fraction of fires (EVIDENCE
  below), so the `confirm_count`/`disconfirm_count` that decay reads
  are mostly zero not because predictions failed but because nothing
  ever judged them. Decay then reads that silence as "unreinforced"
  and prunes.

The recent `bbfd7d9` fix (int `confirm_count` truncating the
sub-unit reaction increment to 0) stopped decay from euthanizing
**every** prediction, but it left the structural problem: decay is
still wall-clock and still relevance-blind, and the predictions
killed during the bug are permanently stuck at `health = 0`.

## EVIDENCE (prod audit 2026-06-15, single user)

The design choices below are not abstract - they are what this
user's data argues for:

- **Live classifier resolves 4.4% of fires.** 28,848 fires:
  1,040 confirmed, 225 disconfirmed, **27,583 never judged**. 22% of
  cohorts get any resolution. Replacing the live classifier with a
  next-day judge that rules on every fired prediction fills a
  near-total vacuum, not a competition.
- **The dead are the workhorses.** Of 140 samskaras at `health=0`,
  **102 fired on more than 5 distinct days** (avg 228 fires, avg
  13.6 distinct fire-days); **59 fired in the last 7 days**. The bug
  guillotined the highest-frequency, most-recurring predictions -
  exactly the ones worth keeping if they are any good.
- **The feature is currently crippled.** Distinct samskaras firing
  per day fell from **42-69** (early June, corpus alive) to **6-8**
  now, because 140 are below the `FIRE_SCORE_FLOOR` and can no
  longer surface. The layer is running on ~7 live predictions of
  150.
- **Most of the corpus is idle on any given day.** Even at peak
  health only ~40-70 of 150 fire daily, so rate-based decay erodes
  the alive-but-not-today majority. **Recurrence averages 13.6
  fire-days/samskara**, so anything real recurs well inside two
  weeks - which is why the 60-day rule is redundant.

## DESIGN

### Firing already IS the topic-match

Samskaras fire by **cosine similarity** between their embedding and
the current turn (`samskara_fire_top_k`), and every fire is logged
to `samskara_fires` (`samskara_id`, `thread_id`, `cohort_id`,
`fired_at`, `score`, `was_confirmed`, `user_round`). So "did this
prediction's topic come up in this conversation?" is **already
answered** by "did it fire?" No separate semantic matcher is needed;
the live system computes relevance per turn. A prediction that fired
= its topic was present and it had its chance. One that never fired
in a conversation = its topic was absent -> leave it untouched.

### The retrospective evaluation sweep (new; sibling of reflection)

A new cron-driven sweep, structurally modeled on the **reflection
sweep** (same `claim_next_*`-style RPC, same **next-day +
`>= 2` user-round guard**), processes settled conversations one at a
time. For each claimed thread it:

1. Gathers the **distinct samskaras that fired** in the thread
   (from `samskara_fires`).
2. Feeds the agent the thread transcript plus each fired
   prediction, and asks for a per-prediction **verdict** against
   what actually happened:
   - `held` - the prediction was borne out -> a **hit**
   - `contradicted` - the user did the opposite / it was wrong -> a
     **miss**
   - `fired-but-not-engaged` - relevant-ish but the conversation
     neither confirmed nor refuted it -> **no evidence** (neither hit
     nor miss); it only marks that the prediction got another at-bat,
     which ages its older evidence (the forgetting)
3. Updates the prediction's verdict tallies and recomputes its
   **derived health** (see "Self-calibrating health"). There are no
   hand-tuned deltas.

Predictions that **did not fire** in the thread are not evaluated at
all - the core of the redesign.

### Replace the live reaction classifier

The live 1-10 minute reaction classifier (`samskara_apply_reaction`
plus the classify path) is **retired**. It resolved only 4.4% of fires
and depended on a follow-up landing inside a narrow window; the
retrospective judge sees the whole settled conversation and rules on
everything that fired. Removing it also removes a source of
double-judging (the retrospective sweep would otherwise re-judge
cohorts the live path already touched). The tradeoff is accepted
deliberately: **confirmations land a day late** instead of
in-session, in exchange for ~full verdict coverage and a single
health-authority code path.

### Retire wall-clock decay entirely

`samskara_decay_sweep` and its three rules (stale-fire, disconfirm,
locked-in-no-feedback) and the **60-day stale rule** are **removed**.
Health no longer changes on a timer. Decay becomes the
`contradicted` / `fired-but-not-engaged` arm of the retrospective
verdict. Dormant predictions (topic never recurs) simply persist
untouched until their topic returns - the intended behavior for a
narrow-but-valid claim.

### Self-calibrating health (derived from verdicts, not hand-tuned deltas)

Health is **not an accumulator nudged by fixed deltas**. It is a
*derived statistic* - a prediction's smoothed hit rate: of the times
its topic actually came up (it fired) and the conversation tested it,
how often did it hold? This is the same shape the codebase already
uses for `confidence` (`(confirm+2)/(confirm+disconfirm+3)`, a
Laplace-smoothed hit rate), so it is not a new pattern; it is that
pattern promoted to the single survival signal.

Mechanics, online, mirroring the existing `confirm_count` /
`disconfirm_count` update plus one discount step:

- Reuse `confirm_count` / `disconfirm_count` (already `real`, already
  read by the fire-score sample-size term) as the hit / miss tallies.
  `held` increments confirm, `contradicted` increments disconfirm,
  `not-engaged` increments neither.
- **Forgetting = evidence discounting.** Before applying a verdict,
  scale the existing tallies by `d = 0.5 ** (1/L)`, with `L` a
  half-life measured in *evaluations*. Each at-bat ages prior
  evidence, so a prediction that keeps firing but stops earning hits
  sees its tallies shrink and **regresses toward the prior**. It does
  not crash to 0 - untested is not wrong.
- **Health is the empirical-Bayes posterior mean:**
  `health = (confirm_eff + k*p0) / (confirm_eff + disconfirm_eff + k)`,
  where `p0` is the **population's aggregate hit rate** (held over
  held-plus-contradicted across all of the user's verdicts) and `k` is
  the prior strength. A fresh or evidence-less prediction sits at `p0`
  - the user's own baseline - not at a guessed constant. This is the
  answer to "base it on aggregate metrics": the prior is computed from
  the population, and each individual health is a shrinkage estimate
  toward it.

Only two knobs, both interpretable and both read off the aggregates
rather than eyeballed:

- `p0` - taken directly from the population's verdict tallies
  (recomputed periodically; falls back to a weak neutral prior while
  data is sparse).
- `L` - the evidence half-life; default to a small multiple of the
  median number of evaluations a prediction receives, so "forgotten"
  means "went unconfirmed across roughly its normal testing cadence".

**Health and confidence merge.** Both are now "hit rate from
verdicts," so they collapse into one score - "is this prediction
earning its keep." The fire-score `sqrt(health * confidence)` term
becomes that single posterior; the sample-size term keeps reading
`confirm_count + disconfirm_count`. The old Laplace constants `+2` /
`+3` are exactly the `k*p0` / `k` of the new prior, now data-derived
instead of flat.

### Repair is (almost) free under the derived model

The int-truncation bug left the bug-killed dead with `confirm_count` /
`disconfirm_count` at 0 (the truncation) and `health` decayed to 0.
Under derived health, **health is recomputed from the tallies** - and
a prediction with zero evidence evaluates to `p0`, the population
baseline. So simply switching the fire score onto the derived
posterior lifts every evidence-less casualty back to "unproven" (and
fire-able), where the relevance-gated judge re-sorts it as its topic
recurs. No fragile "seed to ~`0.3` to clear `FIRE_SCORE_FLOOR`" guess
is needed; the model subsumes the repair. The one-shot migration is
just a recompute of `health` for all rows when the new fire score goes
live. Because the dead are mostly high-recurrence (EVIDENCE), the 102
recurring ones get re-judged within days from that baseline.

### Reaper (new) + collapse (unchanged)

Because evidence-less predictions regress to `p0` (not 0), "dead" now
means **repeatedly contradicted** - a posterior driven well below the
baseline by real misses. The reaper deletes samskaras whose derived
health is **below a low floor AND that have not fired in `>= N` days**
(start N = 14), so genuinely-wrong, long-quiet predictions are cleared
while an untested-but-baseline prediction is left alone (it is still
eligible to fire and prove itself). `samskara_collapse_by_cofiring` is
**unchanged** - it remains the duplicate-merge and, via the 150
population cap, the bound on the baseline-sitting majority.

## Why this is not "just tune the decay constants"

A flat per-user-round rate (the first proposal, rejected) trades a
wall-clock timer for a usage timer but is **still relevance-blind**:
it decays predictions whose topic was absent, just pacing the damage
to activity instead of elapsed time. The data is decisive - only
~40-70 of 150 fire on an active day, so any rate, on any clock,
erodes the idle-but-valid majority. The fix is not a better
**constant**; it is moving decay from a **sweep over the population**
to an **event on the tested subset**. Relevance-gating is a
different question, not a retuned answer.

## Risks and rollout

- **The judge becomes the sole survival authority.** No fast feedback
  loop: a systematically harsh judge drags the corpus toward `p0` and
  below; a systematically lenient one (LLMs over-confirm) pins it high
  and leans on the cap. This is the main risk - but it is bounded:
  derived health is a *rate*, so it cannot run away the way an
  unbounded accumulator could, and an evidence-less prediction can
  only ever sit at `p0`, never higher.
- **Mitigations:**
  - **Shadow-run measures the prior; it does not hand-tune deltas.**
    The ~1 week of shadow verdicts gives the aggregate hit-rate
    distribution that *sets `p0`* and the evaluation cadence that sets
    `L`. The data parameterizes the model; nothing is eyeballed.
  - **Skeptical judge prompt.** Default to `not-engaged`; require
    explicit transcript evidence for `held`. A `not-engaged` is
    no-evidence, so an over-cautious judge only slows learning - it
    does not actively mis-score.
  - **Backstops stay.** Reaper + collapse + the 150 cap bound bloat
    regardless of judge calibration.
  - **Observability.** Surface the verdict mix, `p0`, and each
    prediction's derived health in the Health panel and edge logs so
    drift is visible.
- **The two model knobs (`p0`, `L`) are data-derived, not first-draft
  guesses** - `p0` from the population tallies, `L` from the median
  evaluation cadence. The reaper floor and `N` are the only remaining
  hand-set values, and both are low-stakes (they gate deletion of
  already-contradicted, long-quiet rows).

## Implementation prerequisites (read before coding)

1. `samskara_apply_reaction` (schema.sql) and the classify path in
   `supabase/functions/venice/agents/samskara.ts` (~1409-1487) - the
   live classifier being replaced; understand the cohort/reaction
   lifecycle and what stops referencing it once removed.
2. The **reflection sweep** end to end (its `claim_next_*` RPC in
   schema.sql, the next-day + `>= 2`-round guard, the edge entry,
   the `createEdgeLogger` usage) - the structural template for the
   new sweep.
3. `samskara_fire_top_k` and `FIRE_SCORE_FLOOR`
   (`src/lib/samskara/index.ts`) - confirm the derived posterior at
   `p0` clears the floor for a topically-matching turn, so
   evidence-less predictions still fire and get re-tested.
4. The Health snapshot RPC + `SamskaraHealthPanel.svelte` - where the
   verdict mix + derived-health observability lands.

## Itemized changes

- **schema.sql** (slice-1 claim/mark RPCs + cron already landed): a
  verdict-apply RPC that discount-then-increments `confirm_count` /
  `disconfirm_count` from the verdict mix and recomputes `health` as
  the posterior; a `p0` (population hit-rate) computation, periodically
  refreshed; the fire score `samskara_fire_top_k` collapsed onto the
  single posterior; reaper RPC + cron; **drop** `samskara_decay_sweep`
  and its cron, and remove `samskara_apply_reaction`. Repair = a
  one-shot `health` recompute (no seed constant).
- **supabase/functions/venice/:** flip `SHADOW_MODE` off so the judge
  routes verdicts through the verdict-apply RPC; remove the live
  reaction-classify call site (`reactionClassifyProbe`,
  `agentClassifyReaction`, the `CLASSIFY_*_MS` window consts).
- **Frontend:** retire any UI tied to the live reaction window; add
  the verdict-mix + derived-health surfacing to the Health panel.
- **Docs/QA:** update `docs/dev/samskara.md` (decay/reaction/health
  sections) in the same PR; add a `docs/qa/use-cases/` walkthrough
  for the evaluation sweep.

## Open items

- Replace vs supplement the live classifier: **decided = replace**
  (4.4% coverage does not justify the second code path).
- Health as derived posterior vs accumulator deltas: **decided =
  derived** - self-calibrating from the population prior `p0`, no
  hand-tuned deltas. See "Self-calibrating health".
- Merge `health` and `confidence` into one verdict-derived score:
  **decided = merge** once the live classifier (today's confidence
  source) is retired.
- `p0` recompute cadence, `L` default, and reaper floor / `N`: set
  from the shadow week's aggregates at slice-2 build time.
