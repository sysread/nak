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
   - `held` - the prediction was borne out -> **health up**
   - `contradicted` - the user did the opposite / it was wrong ->
     **health down (large)**
   - `fired-but-not-engaged` - relevant-ish but the conversation
     neither confirmed nor refuted it -> **health down (small)**;
     this is the relevance-gated "forgetting" term, and it only
     touches predictions that actually fired
3. Applies the health deltas (clamped `[0, 1]`) and records the
   verdict for observability.

Predictions that **did not fire** in the thread receive **no
delta** at all - the core of the redesign.

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

### Health increment widens

Today health rises **only** via the `+0.02` dedup-bump on re-mint of
a near-duplicate (`samskara_reinforce_existing`). Under this plan a
`held` verdict also raises health (the lever the system is missing -
confirmation currently feeds `confidence`/`confirm_count` but never
`health`). The dedup-bump stays as a second path.

### One-time repair migration

After the sweep is live, reseed the bug-killed dead to a
**fire-able** health (~`0.3`) so relevance-gated evaluation can
re-sort them. The seed must clear `FIRE_SCORE_FLOOR` - the intuition
of "set it just above death" fails because at ~`0.003` the
`sqrt(health * confidence)` term keeps the fire score below the
floor, so the prediction never fires and never gets re-tested.
Because the dead are mostly high-recurrence (EVIDENCE), the 102
recurring ones get re-judged within days; held ones climb,
contradicted ones die in ~2 strikes.

### Reaper (new) + collapse (unchanged)

A reaper deletes samskaras that are **`health = 0` AND have not
fired in `>= N` days** (start N = 14), so corpses stop counting
against the 150 population cap while a recurring prediction mid-re-
evaluation is never reaped. `samskara_collapse_by_cofiring` is
**unchanged** - it remains the duplicate-merge and overpopulation
backstop.

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

- **The judge becomes the sole health authority.** No fast feedback
  loop: too harsh re-euthanizes the corpus; too lenient (LLMs over-
  confirm) bloats it past the 150 cap. This is the main risk.
- **Mitigations:**
  - **Shadow-run first.** Run the sweep for ~1 week applying
    **reduced** deltas (or write verdicts without applying), and
    compare its verdicts against the 1,040 historical live-confirms
    to calibrate magnitudes before full force.
  - **Skeptical judge prompt.** Default to `fired-but-not-engaged`;
    require explicit transcript evidence for `held`. Err toward the
    cap, not against it.
  - **Backstops stay.** Reaper + collapse + the 150 cap bound bloat
    regardless of judge calibration.
  - **Observability.** Surface per-verdict deltas in the Health
    panel and edge logs so drift is visible.
- **Deltas are first-draft** (`held` `+~0.2`, `contradicted`
  `-~0.2`, `not-engaged` `-~0.05`, seed `~0.3`, reaper `N=14d`) and
  are the shadow-run's job to confirm.

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
   (`src/lib/samskara/index.ts`) - confirm the seed clears the floor
   for a topically-matching turn at the chosen `confidence` prior.
4. The Health snapshot RPC + `SamskaraHealthPanel.svelte` - where
   verdict/delta observability lands.

## Itemized changes

- **schema.sql:** new claim RPC for the evaluation sweep (definer,
  service-role-locked, `set search_path = public`); new cron job +
  trigger fn (guarded `do` block, pg_net POST, same auth pattern as
  the other sweeps); new health-apply RPC (or fold into the claim
  result); reaper RPC + cron; **drop** `samskara_decay_sweep` + its
  cron; remove the live-reaction RPC. Repair is a one-shot guarded
  `update`.
- **supabase/functions/venice/:** new evaluation-sweep agent (judge
  prompt + per-prediction verdict + delta apply), modeled on
  reflection; remove the live reaction-classify call site.
- **Frontend:** retire any UI tied to the live reaction window;
  add verdict/delta surfacing to the Health panel.
- **Docs/QA:** update `docs/dev/samskara.md` (decay/reaction/health
  sections) in the same PR; add a `docs/qa/use-cases/` walkthrough
  for the evaluation sweep.

## Open items

- Replace vs supplement the live classifier: **decided = replace**
  (4.4% coverage does not justify the second code path).
- Final deltas + reaper window: **shadow-run calibrates**.
- Whether `contradicted` should also feed `confidence`/counts (kept
  for the Bayesian confidence display) or only `health`: decide at
  implementation against the reaction lifecycle.
