# Samskara evidence backfill: the warmup pool (plan)

Status: DRAFT rev 1, 2026-10-26. Drafted from the owner's design
after the 150-cap conversation. Owner's framing: when a person
adopts a new predictive pattern, they re-read past experience in
light of it. The system should do the same: a newly minted claim
is judged against the conversations that would have tested it,
before it is allowed to fire live.

## SYNOPSIS

New claims are minted into a QUARANTINE pool: they do not fire in
live conversations. A hourly backfill worker retrieves the
historical exchanges that would have fired each claim (same
centered-cosine predicate as the live fire path), judges the claim
against each exchange in its own completion, and folds the
verdicts into health at reduced weight. When the attempt budget is
spent, the claim activates (or, if history never engaged it, stays
quarantined as evidenced junk). This gives every claim a evidence
baseline at mint time instead of waiting weeks for organic tests,
and it removes the "corpus must stay tested" job the 150-cap was
quietly doing.

## PURPOSE

Two measured problems meet at the same design point:

- A minted claim carries no evidence until the live judge happens
  to test it. Age cannot distinguish "dormant" from "dead": the
  median untested row has only 2 judged fires (schema comment at
  samskara_evict_for_mint), and p90 time-to-first-genuine-test is
  ~13 days. Until then the claim is either a dangerous firer (an
  untested claim can prime the model from a plausible-sounding
  hypothesis) or invisible.
- The 150-cap conversation (samskara-lifecycle-plan.md decision 6)
  established the cap's real job is metering formation against the
  judge's capacity to test. Backfill decouples that: test supply
  becomes a worker rate the owner controls, not a function of what
  conversations organically fire.

Out of scope: the cap value itself, the mint gates, the eviction
tiers, the association backlog. This plan changes what the cap is
FOR (its "keep the corpus tested" rationale dissolves) but not its
value; the cap revisit reads this plan's M5 data.

## DECISIONS

1. Quarantine is real, not advisory: a quarantined claim is
   invisible to the fire RPC (no priming, no fire rows, no cohort
   membership) until activation. Owner decision, 2026-10-26.
2. One completion per (claim, conversation) pair. Each historical
   conversation is judged on its own, never batched with others,
   and never with multiple claims. Owner instruction: separate
   completions minimize cross-conversation pollution. This differs
   from the live judge (which batches a thread's fired predictions
   into one completion, agents/samskara_evaluation.ts
   buildVerdictRequest); the backfill prompt is single-prediction
   and reuses the two-step verdict shape.
3. Backfill evidence is a distinct evidence class, folded at
   reduced weight and separately recorded. The health posterior
   stays a single number; the per-verdict audit trail distinguishes
   virgin backfill from live fires. Owner instruction.
4. The claim's own birthplace is excluded from its backfill
   candidates: provenance-resolvable threads never judge the claim
   they minted (the mint sources would confirm with near
   certainty). Owner design, 2026-10-26.
5. Existing corpus is grandfathered: every row alive at deploy gets
   activated_at = now(). Backfill applies to the quarantine pool
   going forward; no retroactive backfill of the 157 live rows.
6. The judge is not told the claim is new, quarantined, or
   backfilled. The prompt presents a prediction and a transcript;
   provenance disclosure risks a leniency or harshness anchor.

## STATE AND TRANSITION MATRIX

A claim's activation state. Existing machinery (health posterior,
eviction, reap) is unchanged; the matrix covers what this plan adds.
Precedence rule: the worker's own claim columns arbitrate every
transition - a row whose claim is held by a live worker cannot die,
fold, or activate concurrently.

| State | Meaning | Entered by |
| --- | --- | --- |
| QUARANTINED | `activated_at` null. Invisible to the fire RPC; no fires, no cohorts, no priming. | Mint insert (column default). Grandfather block (one-time, deploy). |
| ACTIVE | `activated_at` set. Fires normally; identical to today's semantics. | Transitions 1-3 below. |
| DEAD | Row deleted. | Existing machinery only (see below). |

Transitions QUARANTINED -> ACTIVE:

| # | Trigger | Condition |
| --- | --- | --- |
| 1 | Grandfather block | One-shot at the column-adding deploy; every row alive that day activates. Never re-runs (M1's flag). |
| 2 | Worker gate check | `backfill_attempts >= ATTEMPT_BUDGET` AND genuine engaged tests >= 1. |
| 3 | Zero-candidate exception | Candidate query returns 0 rows because the account has no (or too-short) history - activate immediately; an empty corpus cannot warm a claim up. |
| 4 | Short-history gate pass | Candidates existed but fewer than the budget; spent, then transition 2's condition evaluated on the smaller total. |

Transitions QUARANTINED -> DEAD:

| # | Trigger | Condition |
| --- | --- | --- |
| 5 | Adjacency-junk reap | attempts >= ATTEMPT_BUDGET, all attempts not-engaged, age >= 14 days. The backfill ledger is the evidence standard's new source. |
| 6 | Stale-tier reap (existing) | 90 days quiet, tally <= 1.0 - a never-activated row qualifies (tally 0). |

ACTIVE -> DEAD: existing machinery only (probation reaper, reap_dead,
cap-pressure eviction tiers). Backfill never touches an ACTIVE row.

Readers of the state: fire RPC (exclusion filter), health panel and
browse list (badge), apply_backfill (gate arithmetic). Explicit
non-readers: dedup-reinforce (geometry ignores activation; reinforcing
a quarantined claim is allowed), collapse_by_cofiring (quarantined
claims have no fires, so they cannot enter a cohort), eviction tiers
(no tallies mid-quarantine; the 14-day floors cover the gap).

## DELTAS-FROM-TEMPLATE LEDGER

Template: the live judge, `agents/samskara_evaluation.ts` (the
next-day evaluation sweep). The backfill judge is its clone with
these deltas. Each row verified against the source this drafting.

| Aspect | Live judge | Backfill judge |
| --- | --- | --- |
| Completion unit | One completion per judged THREAD, predictions batched (p1..pn tags, buildVerdictRequest). | One completion per (claim, exchange) pair; single prediction, single tag. |
| Trigger | Fires recorded in a thread; day-gated thread claim; */10 cron. | Quarantine pool; hourly claim-based sweep (:33); claim-RPC pattern. |
| Conversation framing | "predictions that were live during the conversation above" | Prediction + transcript only; no live/quarantine/backfill disclosure (decision 6). |
| Transcript input | Whole thread transcript. | Exchange slice: target round's user message + assistant reply, +-1 adjacent exchange. |
| Verdict kinds | held / contradicted / not-borne-out / not-engaged, two-step prompt, skeptical bias. | Same four kinds, same two-step shape, same semantics - prompt adapted for tense only. |
| Evidence weights | held -> confirm += 1; contradicted -> disconfirm += 1; not-borne-out -> disconfirm += w_soft (0.25); not-engaged -> nothing. | Same mapping scaled by w_backfill (0.5): held 0.5, contradicted 0.5, not-borne-out 0.125. not-engaged counts toward attempts, never toward tallies. |
| Record of verdicts | `verdict` column on the existing samskara_fires row. | New samskara_backfill_verdicts row per attempt. NO fire row is ever written. |
| Control arm | Yes - samskara_control_verdicts draws unfired controls per thread. | None. The selection question does not arise (the worker chooses its own candidates); noted, out of scope. |
| Model | EVALUATION_MODEL = BIG_WINDOW_MODEL (agent-models.ts:71, samskara_evaluation.ts:38,559). | Same model constant; single-prediction completions are smaller, not cheaper-per-token. |
| Parse defense | JSON parse; malformed/missing/out-of-enum entries dropped silently. | Reused verbatim (single-entry map). |
| Discount | Evidence aged by d per genuine test, inside apply_evaluation. | Same discount math inside apply_backfill; discount applies per genuine backfill test at scaled weight. |

## VERIFIED MECHANICS THIS PLAN BUILDS ON

- The fire predicate is reproducible math. Live fire embeds the
  query text (user message + doubt note) with the local embedder
  and calls samskara_fire_top_k (priming/samskara.ts:118-175).
  Score = centered-cosine ramp (cosine 0.30 saturates to full
  score) x sqrt(health x confidence) x evidence bonus
  (schema.sql:8495-8543). A historical exchange embedded the same
  way yields an exact "would have fired" test.
- All embeddings share one space: claims, substrate situations, and
  fire queries are bge-m3 1024-dim zero-padded to 2048
  (schema.sql samskara_substrate situation_embedding comment;
  _shared/local-embed.ts). Centering uses the shared claim mean
  (_samskara_centering_mean).
- The judge's verdict scale: held -> confirm += 1; contradicted ->
  disconfirm += 1; not-borne-out -> disconfirm += w_soft (0.25);
  not-engaged -> no evidence, no discount (schema.sql:9288-9330,
  w_soft at :9314). The two-step prompt (engagement gate, then
  outcome) and the skeptical bias exist because prod data killed
  their absence (92.5% held-rate incident; agents/
  samskara_evaluation.ts:127-157).
- Mint provenance resolves to threads: samskara_provenance kinds
  ('substrate', 'association') carry ref_id into
  samskara_substrate rows, which carry thread_id
  (schema.sql:7354-7380, 7945-7950).
- The claim-RPC pattern is the house mutual-exclusion primitive
  (per-row claim columns + claim RPC + guarded save). The embedder
  already runs two phases per substrate row off independent claims.
- Hourly cron minute :33 is free (taken: every-minute embed backfill
  and stream janitor; :03 bias; :07 wiki; :13 reap; :17 wiki-records
  and rem; :23 samskara sweep; :27 reflection; :37 wiki-librarian;
  :43 samskara decay; :47 deep-sleep; :57 curation; evaluation
  every 10 min).

## M1 - SCHEMA

All idempotent, per the house rules (add column if not exists,
drop-if-exists + recreate for RPCs, grants block at file end).

- `samskaras` gains:
  - `activated_at timestamptz` - NULL = quarantined. Default NULL
    (new mints land quarantined).
  - `backfill_claim_holder text` + `backfill_claim_expires
    timestamptz` - the claim-RPC pair for the worker.
  - `backfill_attempts int not null default 0` - spent attempt
    budget.
  - One-shot grandfather block: `update samskaras set activated_at
    = now() where activated_at is null` guarded on a marker (the
    column add itself is the marker; the block runs once on the
    deploy that adds the column - subsequent re-applies see no
    NULL... EXCEPT new mints, which must NOT be grandfathered by
    a re-apply. So the grandfather must be a one-shot: guard on a
    distinct sentinel, e.g. `where id in (select id from
    samskaras where activated_at is null) and to_regclass(...)
    marker table absent`. Concrete mechanism: a tiny
    `samskara_backfill_grandfathered boolean` row in app_config or
    a guarded do-block checking whether the column was JUST added
    (information_schema + a side-table flag). Implementation must
    resolve this to a provably one-shot form; premise flagged for
    refinement.)
- New table `samskara_backfill_verdicts`: one row per judged
  (claim, exchange) attempt. Columns: id, user_id, samskara_id,
  thread_id, user_message_id, verdict text, cosine real, judged_at,
  model text. Never touched by health directly (the fold RPC is the
  writer of tallies); this table is the audit ledger and the
  activation gate's input. RLS: owner-selectable, service-role
  writes.
- `samskara_substrate` gains `query_embedding vector(2048)` - the
  RAW user-message text of the round, embedded by the existing
  embeddings worker (same claim pair as situation_embedding or a
  third claim column; implementation picks, keeping the two-phase
  claim independence). This is the retrieval index for candidate
  exchanges. Historical rows backfill via the worker's normal
  pending-embed poll (embedding_model stamps the source).
- RPC `samskara_backfill_candidates(p_samskara_id, p_k, p_user_id)`:
  returns the top-p_k substrate rounds by CENTERED cosine between
  the claim's prediction_embedding and substrate.query_embedding,
  where centered cosine >= p_floor (initial 0.30, the fire ramp's
  saturation point; calibrated on the labeled probe set before
  deploy), EXCLUDING every thread reachable from the claim's
  samskara_provenance rows, and only rounds with query_embedding
  not null. Invoker-safe (auth.uid()), service-role passes user id
  explicitly (b-strict overload pattern).
- RPC `samskara_claim_quarantined_samskara(p_user_id)`: oldest
  quarantined row with backfill_attempts < p_max and claim columns
  free, `for update skip locked`, stamps the claim pair. The save
  path (fold RPC) only commits if the claim still belongs to the
  caller - the canonical pattern.
- RPC `samskara_apply_backfill(p_user_id, p_samskara_id, p_held
  uuid[], p_contradicted uuid[], p_not_borne_out uuid[], p_weight
  real, p_claim_holder text)`: folds verdicts into the SAME tallies
  via the same discount math as samskara_apply_evaluation, scaled
  by p_weight (w_backfill, initial 0.5): held -> confirm += w_bf;
  contradicted -> disconfirm += w_bf; not-borne-out -> disconfirm
  += w_soft x w_bf; not-engaged never passed. Advances
  backfill_attempts by the total attempt count INCLUDING
  not-engaged, then releases or re-stamps the claim. Guarded on
  claim holder + expiry (stale worker cannot double-fold).
- Fire RPC filter: samskara_fire_top_k gains
  `and s.activated_at is not null`. Quarantined claims cannot fire,
  join cohorts, inflate fire_count, or enter the co-fire graph.
  Also exclude them from samskara_control_verdicts' control draw
  (control arm mirrors the fired pool).

## M2 - EMBEDDER WIRING

Extend the embeddings worker's samskara_substrate source to also
fill query_embedding (embed the round's raw user message text).
One extra local-embed call per round; no Venice cost; the existing
pending-embed claim pattern carries it. Historical substrate rows
drain through the same poll (bounded by the worker's per-tick cap).

## M3 - THE BACKFILL WORKER

New agent `supabase/functions/venice/agents/samskara_backfill.ts`,
route `/samskara-backfill-sweep`, cron `33 * * * *` (pg_net POST,
house dispatch shape). One claim per tick, work registered under
EdgeRuntime.waitUntil.

Per-tick flow:

1. Claim one quarantined claim (oldest mint first).
2. Retrieve candidates: samskara_backfill_candidates with
   p_k = ATTEMPT_BUDGET (8) - p_backfill_attempts.
3. For each candidate, in order (highest cosine first):
   - Fetch the exchange slice: the round's user message + its
     assistant reply, plus the adjacent exchange on each side for
     context (the judge's "pointable moment" standard needs a
     quotable transcript, not a whole thread; whole threads would
     multiply tokens for marginal evidence).
   - ONE completion: system prompt = the live judge's two-step
     framing adapted to single-prediction, past-tense, with no
     provenance disclosure; user turn = the prediction + the
     transcript slice + the verdict request (single tag, JSON
     reply; reuse the live judge's parse-and-drop-malformed
     defense).
   - Record the verdict row (including not-engaged - every spent
     attempt is ledgered) and fold via the backfill RPC.
4. Gate check: attempts >= ATTEMPT_BUDGET ->
   - genuine engaged tests (held + contradicted + not-borne-out)
     >= 1: activate (set activated_at = now()).
   - zero engaged tests: stay quarantined. Its ledger is the
     adjacency-junk evidence standard's new input (below).
5. Release the claim.

Constants (initial values, probe-set calibrated before deploy):
ATTEMPT_BUDGET = 8, candidate floor = 0.30 centered cosine,
w_backfill = 0.5, exchange context = +-1 adjacent exchange.

The adjacency-junk standard: reap_untested (or a sibling) gains a
backfill source - a quarantined claim with ATTEMPT_BUDGET spent
attempts, all not-engaged, and age >= 14 days is evidenced junk
under the same logic as the live tier-1 eviction standard (10+
judged not-engaged, zero engagements). This is the death path for
claims whose neighborhood never actually engages them.

## M4 - SURFACES

- Health panel + browse list: quarantined claims get a status badge
  ("warming up", n of m conversations judged). No editing of
  quarantined claims beyond what exists today.
- docs/dev/samskara.md: the lifecycle section gains the quarantine
  stage and the backfill worker; Interactions ledgers updated
  (embeddings, evaluation sweep, eviction, fire path).
- docs/user/: the observable behavior - new claims do not
  influence replies immediately; they warm up against history
  first; the badge.
- New QA use case: docs/qa/use-cases/samskara-backfill.md (forge a
  quarantined claim, seed/forge substrate embeddings, run the
  sweep route with the service-role JWT, assert verdict rows, fold
  weights, activation gate both branches, birthplace exclusion).

## M5 - READOUTS

- Agreement: for claims with >= 1 backfill genuine test and later
  live genuine tests, P(live verdict agrees with backfill verdict).
  This is the signal-validity gate: if backfill verdicts do not
  predict live verdicts better than chance, the mechanism measures
  the judge's mood, not the claim, and gets retired.
- Throughput: activation rate per week, quarantine pool depth,
  attempts per claim, not-engaged share.
- Precision side-effect: live fire not-engaged share for
  backfill-activated claims vs grandfathered claims (does an
  evidence-backed claim fire more precisely?).
- Cap inputs: population now decomposes into quarantined /
  activated / evidenced - the data the cap revisit consumes.

## GOTCHAS AND PREMISE LEDGER

- The grandfather block must be provably one-shot (see M1 flag).
  A re-apply that re-runs `set activated_at = now() where null`
  would activate every NEW quarantined mint - silently disabling
  the whole feature. This is the deploy-blocking premise.
- Substrate rows with NULL situation (assimilation lag) still get
  query_embedding (embedding needs only the raw user text). The
  two waits are independent.
- A claim with fewer candidates than the budget (short history,
  aggressive floor): spend what exists, then gate. A brand-new
  account with no history: zero candidates - activate immediately
  (quarantine against an empty corpus is indefinite starvation;
  the live judge is the only signal there anyway).
- Fires are NEVER written for backfill attempts: fire_count stays
  "live fires", the co-fire graph stays behavioral, collapse is
  untouched. The backfill ledger table is the only record.
- The mint probes' dedup-reinforce may hit a quarantined claim
  (geometry ignores activation). Reinforcing a quarantined claim's
  tallies is harmless and honest; it does not activate.
- Eviction tiers read tallies; quarantined claims have none, so
  tier-1/tier-3 cannot pick them mid-backfill (also protected by
  the 14-day floors). The 90-day stale tier can reap a never-
  activated claim - correct death.
- The evaluation sweep's day-gate and the backfill worker are
  independent claim spaces; no contention (different tables).
- Centered cosine uses the LIVE claim mean, which drifts as the
  corpus changes: "would have fired" is evaluated against today's
  centering, not the historical day's. Accepted (the alternative -
  freezing per-round means - is machinery the evidence does not
  need); noted for the readout.

## WHAT THIS PLAN REPLACES

- The "backfill" sketches in the 2026-10-26 cap conversation
  (this document is their resolution).
- Nothing else: the cap, mint gates, eviction tiers, and the
  lifecycle plan's milestones M1/M2/M4 are untouched. The
  lifecycle plan's decision 6 (cap parked) now reads THIS plan's
  M5 as additional input.
