# Bias Observer Falsification Verifier via Decision Model (B6)

Status: PLAN (round-1 lens fan-out folded; round-2 reviewer pending).

## SYNOPSIS

Keep the bias observer exactly as it is - ONE chat completion that
reads the transcript and emits observations and reactions with their
required prose - and add a decision-model FALSIFICATION VERIFIER
behind it: one batched `clef-api` call with one `noul` per emitted
observation and per directional reaction, judged against the same
falsification standard the prompt applies (compressed into the
criteria - the divergence is measured, see D7), vetoing emissions
that fail it. The verifier can only veto (drop an observation,
downgrade a reaction - D4), never edit, never
write. Plus one deterministic, model-free provenance check that fixes
a pre-existing save-wedge class.

Why this shape: the brainstorm's B6 idea - the Beta-Binomial aggregate
eating noul probabilities directly - is REJECTED here (D2). The
surviving fit uses the decision model for what it is good at:
adversarial verification of a generative claim. The observer's own
prompt names the catastrophe ("a fabricated signal contaminates
aggregate evidence for months"): the aggregate's per-thread evidence
(`p_conv`) is a noisy-OR over observation confidences, so one false
observation lifts a bias's posterior for months. A verifier pass
costs one call (~1 question per emission, sub-second against an
hourly cron) and buys: an independent read of the falsification
standard, calibration data closing a RECORDED open item - the QA
doc's "[hosted] follow-up" on the observer's real-conversation
hit-rate, open since 2026-06-11 (`bias-pipeline.md:114`) - and a fix
to a pre-existing save-wedge class.

This is B6 of the decision-model brainstorm
(`venice-decisions-plan.md:162-168`), the entry that says "do not
lead with it" and warns "bare noul calls risk exactly the false
positives the prompt works to prevent" - the hybrid built here leads
with the chat model and uses the decision model only as a veto.
Scope: the analyze phase only; the aggregate phase, the catalog, the
schema, and every reader are untouched.

## BACKGROUND

The pipeline today (`venice/agents/bias.ts`, read this session):

- **Analyze** (`:411-612`): claim a settled thread cross-user
  (`bias_claim_next_thread_for_sweep`, TTL 300s, day-gated, cap 10
  per tick; NO attempt cap exists on this claim - unlike
  reflection's), read the transcript (user+assistant rows with
  id+content; tool calls and reasoning excluded; fork framing
  splices a FORK_POINT_MARKER + a only-cite-below note), build ONE
  JSON payload (`{messages, active_biases, fork_note?}`, `:279-289`),
  and run the observer: one chat completion (`BIAS_MODEL`, thinking
  off, 4096 tokens) with the catalog + the falsification ladder +
  confidence semantics in the system prompt (`:102-206`). Parse +
  validate: observations `{bias, confidence [0.40,0.85], reasoning,
  evidence_message_id?}` and reactions `{bias in active set,
  was_confirmed true/false/null, reasoning}` - empty reasoning
  drops, non-active-bias reactions drop as fabrication (`:361-382`).
  Confidence clamps in the CALLER (`:574-578`): below-floor
  observations drop entirely, supra-cap pull down. Save via
  `bias_save_observations` (delete-then-insert under the claim +
  message-count guard).
- **Aggregate** (`:614-799`): per user per catalog bias (18 keys),
  the `p_conv` per processed thread is a NOISY-OR over that thread's
  observation confidences (`schema.sql:14663`:
  `1.0 - exp(sum(ln(greatest(1.0 - confidence, 1e-9))))`; threads
  with no observation contribute 0 via the `coalesce(..., 0.0)`) and
  reactions drive a feedback EMA (neutral/null rows carry no
  directional signal, `_shared/bias-math.ts:229`);
  `aggregatePosterior` folds both into `bias_summary` (alpha, beta,
  mean, ci, tier).
- **History that bears on the design** (archaeology, all cited):
  the falsification ladder was born PREEMPTIVELY at feature birth
  (`f4d09ad4`, 2026-05-17) from a design-time analysis of exactly
  the failure mode the verifier targets - "the clustering-illusion
  failure mode of the math kernel is fed by false positives" - not
  in response to incidents; the five questions are byte-identical
  since v2 (2026-05-18) through the verbatim port (`40440b7b`,
  2026-06-11). The observer has NEVER been audited against reality:
  the only QA rows (2026-06-11, local) found prod at 2/231 threads
  processed and 0 observations on every thread, with the hit-rate
  follow-up explicitly parked [hosted]. The 0.85 confidence cap and
  the aggregate's per-conversation noisy-OR ceiling are the same
  number BY DESIGN (a guard against same-pass correlated signals).
- **Tests**: `tests/bias.test.ts` pins the prompt's catalog
  embedding, its structural sections, and the sweep tunables. It
  NEVER exercises `observeThread` - the `__test` export is dead
  surface today; there is no fetch stub in the file.

The falsification ladder (`:117-127`): five questions - defensible
reasoning from a different prior; exploratory framing; playful
conversations; frame-confined suspension of disbelief; one-sentence
generalization. The reaction falsification (`:159-167`): reaction
specificity (compensation vs correctness), bias specificity vs
generic style pushback, in-play register, multi-turn vs one-shot.

Failure modes in the current save path (verified in schema.sql):

- `bias_save_observations` inserts
  `nullif(v_obs->>'evidence_message_id', '')::uuid` - a
  hallucinated-but-well-formed id passes the cast and violates the
  FK on `bias_observations.evidence_message_id`; the whole save
  throws (the caller logs and returns 'error'), the thread
  re-eligibles, and the next analysis can hallucinate again - a
  save-wedge class. REACHABLE-BUT-NEVER-OBSERVED: no FK failure
  appears in any log row, doc, or commit in the project's history,
  and the recorded traffic (2/231 threads, 0-observation QA runs)
  makes it unlikely anyone ever hit it. The fix is prophylactic.
  The null case (no id) is legitimate and common (the column is
  nullable: deleted messages keep the observation, lose the deep
  link).

Decision-API facts ride the parent plan's calibration (32k-token
state, batching sublinear, `noul` -> probability) and the B1/B4/B5
precedents: the composition doctrine (a decision call composes with
the generative path, never replaces it, fails open), the shared
state-shaping module (`venice/agents/_decision_state.ts`: coercers,
`DECISION_ITEM_CAP`, `DECISION_CALL_TIMEOUT_MS`), and log-only
probabilities.

## DECISIONS (proposed - refinement may amend)

- **D1 - Model: `clef-api` via `DECISION_MODEL`** (the tier
  constant); a one-line alias `BIAS_VERIFIER_MODEL = DECISION_MODEL`
  in `_shared/agent-models.ts` (the greppable-log precedent).
- **D2 - The direct-noul observer is REJECTED; the chat observer
  stays the generative writer.** The brainstorm's idea (the
  aggregate eating per-bias noul probabilities directly) fails
  three ways. First, the error asymmetry: an authoring false
  positive creates months of poisoned evidence (`p_conv`'s
  noisy-OR); a verifier false positive deletes one observation and
  self-heals ("a missed signal today gets caught next
  conversation", `bias.ts:109`). Second, verification is easier
  than authoring: the verifier's question CARRIES the emission
  under test (bias key, the observer's reasoning, the evidence
  pointer) - a direct-noul observer would run open-world
  hypothesis tests (18 per-bias questions per thread, no candidate
  attached), each an independent false-positive generator the
  ladder's ordered discipline was built to suppress. Third, the
  required reasoning + evidence citation are the audit trail (the
  only reader-facing explanation of why a bias was flagged about
  the user's own cognition) - a decision model emits no prose. The
  pre-answer to the obvious objection ("if a noul can judge the
  ladder well enough to veto, it can author"): the criteria do the
  work in both directions, but the verifier judges a CARRIED claim
  on the CLOSED set of already-flagged emissions; the author would
  re-open the world. The verifier inverts the risk: false positives
  in its hands protect the aggregate instead of poisoning it.
- **D3 - The verifier's contract: veto-only, fail-open, after the
  clamp.** Sequencing: the verifier runs in the CALLER
  (`analyzeClaimedThread`), over the post-clamp set (`cleaned` +
  the directional reactions) - verifying pre-clamp emissions would
  spend veto questions on below-floor rows that can never save, and
  the calibration pair must log the SAVED confidence. Per emission
  under test, one `noul`; below `VERIFIER_VETO_THRESHOLD = 0.5` the
  emission is vetoed (the actuator differs by type - D4) with a log
  line; at or above, it saves with
  the observer's confidence and prose untouched (the verifier never
  rewrites). Verifier failure at any layer (transport, timeout,
  malformed answers, nothing to test) = everything stands -
  byte-for-byte today's behavior - and every fail-open path logs at
  INFO with the reason, so the drawer distinguishes "no emissions"
  from "verifier down" (info is the B4/B5 level). CONTRACT
  DIFFERENCE from B4, named: B4 distinguishes deterministic
  rejection (advance the queue) from transient failure (do not
  stamp); B6 collapses both into save-and-stamp because the
  verifier has NO queue - the save-and-stamp is the OBSERVER's
  contract, unchanged; a verifier failure only means unverified
  emissions saved, which is exactly yesterday's behavior. The call
  is single-attempt and
  timed (`DECISION_CALL_TIMEOUT_MS`, the shared 10s ceiling - a
  stalled fetch must degrade to fail-open, not hang the drain).
- **D4 - What gets verified: observations always; reactions only
  directional; the veto's actuator differs by type.** Observations
  (the p_conv driver) are all verified; a vetoed observation is
  DROPPED (it never saved - the row would assert fabricated
  cognition about the user). Reactions: only `was_confirmed`
  true/false are verified - directional claims that move the
  feedback EMA (neutrals carry none,
  `bias-math.ts:229`), and their recorded value is "the agent
  looked" (schema comment) - verifying "I saw no signal" is
  proving absence. A vetoed directional reaction is DOWNGRADED to
  `was_confirmed = null` (the row is kept with its reasoning): the
  schema's third state exists to distinguish "the agent looked and
  saw nothing" from "the agent never ran" - a drop would record
  the second for what was really the first, and nulls do not move
  the EMA. The question count is capped at the shared
  `DECISION_ITEM_CAP = 12` total (observations first, then
  directional reactions; excess passes unverified and logged - the
  residual: a crowded cap leaves reactions unverified-but-saved
  exactly when observations crowd it; matches D2's severity
  order).
  Emission counts in the recorded runs are 0 - the 0-3 typical
  figure is an unmarked assumption; the cap + excess path bound it
  regardless.
- **D5 - State: the observer's payload (budgeted - see D8), rebuilt
  once; criteria carry the catalog entry.** The verifier sees the SAME
  `{messages, active_biases, fork_note?}` JSON the observer saw
  (extracted into a pure `buildObserverPayload` used by both
  paths) - marker + note included. The per-question instructions
  carry: the bias key, the CATALOG ENTRY (`definition` +
  `nearMiss` from `_shared/bias-catalog.ts` - the nearMiss is the
  per-bias complement of the ladder's first question, already
  written, currently unseen by any verifier), the emission under
  test (the observer's reasoning, the confidence, the evidence
  pointer's presence), and the ladder compressed into the criteria
  (observations: the five questions; directional reactions: the
  four reaction-falsification questions + the specificity bar).
  No transcript re-serialization (`_decision_state.ts`'s serializer
  is for StoredMessage[] renders - verified not to fit).
- **D6 - The deterministic provenance check (model-free), which
  also closes the wedge.** Before the verifier: a present
  `evidence_message_id` must resolve to a USER message row in the
  transcript payload AT OR BELOW the fork boundary (the boundary
  index is already computed for the splice; the fork note's
  only-cite-below rule becomes deterministic) - an unresolvable OR
  above-boundary id is nulled out (the observation is kept, the
  deep link is dropped - the exact semantics the schema already
  documents for deleted messages) with a log line. This is the
  free half of the falsification discipline: it closes the
  FK-violation wedge (no unresolvable id reaches the save's cast)
  AND the re-cite class (inherited rows were analyzed in the
  parent thread - citing them double-counts). The marker entry
  itself carries no id (bias's bespoke splice, verified), so the
  check cannot collide with it.
- **D7 - Calibration is a deliverable that closes a recorded
  debt.** Every verified emission logs the pair (observer's SAVED
  confidence, verifier p) plus usage - the first real measurement
  of the observer's calibration, closing the QA doc's parked
  "[hosted] follow-up" (open since 2026-06-11). The veto ships
  WITH the logging rather than after a measure-first month:
  the pair is logged before the veto decision, so the data
  quality is identical, the aggregate stays protected meanwhile,
  and `VERIFIER_VETO_THRESHOLD` set to 0 (or removing the call)
  restores today's behavior - measure-while-acting with a
  reversible knob dominates measure-then-act. The veto extends an
  established pattern: the 0.40 floor already drops sub-floor
  confidences at ingest. Note for future tuning: the 0.85
  confidence cap and the aggregate's per-conversation noisy-OR
  ceiling are the same number by design - recalibration informed
  by these logs touches aggregate math, not just prompt text.
- **D8 - State: the observer's payload, BUDGETED, with per-emission
  fail-open outside the window.** The verifier sees the observer's
  payload EXCEPT that an over-budget state is trimmed keep-newest to
  `BIAS_VERIFIER_STATE_BUDGET_CHARS = 80_000` (the B4/B5 figure -
  same constraint set). Why a budget at all (it was not obvious):
  untrimmed, a long thread's verifier call 400s deterministically
  over clef-api's 32k-token state and fails open - and since the
  save stamps `bias_processed_at`, those threads would be silently,
  permanently unverified (no re-eligibility until a new message)
  while the calibration data skews to short threads. The trim's own
  hazard is handled per emission: on a TRIMMED state, an emission
  whose support cannot be located in-window fails open INDIVIDUALLY
  - an evidence id absent from the trimmed payload, or (on a trimmed
  state only) no evidence id at all - it STANDS with a log line; it
  is never vetoed on missing context. On a non-trimmed state (the
  common case) everything is judged. No queue-advance machinery
  (the verifier has no queue - B4's pattern does not apply).

## PLAN

1. **`bias.ts`**: extract `buildObserverPayload` (pure; used by both
   paths; the payload-identity test is load-bearing - assert the
   marker splice position and the id-less marker entry); fix the
   stale user-message doc comment while there (it documents
   `{messages, active_biases}` only - the payload conditionally
   carries `fork_note`, `bias.ts:89-95` vs `:285-289`); add the
   deterministic provenance check (D6: resolvable + below-boundary
   or nulled); add the verifier wiring in the CALLER after the
   clamp (D3): `verifyEmissions(payload, cleaned, directionalReactions,
   apiKey, log)` -> the filtered/downgraded set + the calibration
   log lines; add `BIAS_VERIFIER_MODEL` to `agent-models.ts`. The
   observer prompt, the catalog, the sweep skeleton, the save RPC
   call, and the aggregate phase are untouched.
2. **Tests** (`tests/bias.test.ts`): the verifier needs a NET-NEW
   harness - the existing suite never exercises `observeThread`
   (no fetch stub exists). Use the `globalThis.fetch` URL-routing
   stub pattern (`tests/image-op-tools.test.ts:151-176`) routing
   `/chat/completions` vs `/decisions` from day one (`toolComplete`
   takes no fetchImpl - the global stub is the only seam). Pin:
   the payload identity (fork note + marker splice); the provenance
   check (resolvable+below passes; unresolvable nulled + logged;
   above-boundary nulled; missing id tolerated); the verifier body
   builder (model alias, state = the payload verbatim, per-emission
   noul ids, the catalog entry + ladder in the criteria, the cap);
   the coercion + veto table (drop below 0.5, keep at/above,
   fail-open on null/malformed/empty); the directional-only
   reaction rule; the calibration pair log line. The timeout path
   is glue - live-QA-covered, not unit-pinned.
3. **Docs.** `docs/dev/bias-profile.md` (EXISTS - the pipeline's
   rationale doc): the analyze phase gains the verifier stage
   (veto-only, fail-open, the provenance check, the calibration
   deliverable). `docs/qa/use-cases/bias-pipeline.md`: the verifier
   arms + the executed row after the live run. The parent plan's
   B6 entry flips to implemented + pointer here.
4. **Gate, self-review, QA, land.** `mise run check` (exit code
   un-piped), the codified pre-merge self-review, live QA below,
   land on main, CI watch through deploy.

## RISKS

- **False vetoes on observations** are worse than a lost signal: a
  thread whose only observation is vetoed saves as a zero-
  observation pass (valid, stamped processed) and the aggregate
  records p_conv = 0 on the BETA side - recorded EVIDENCE OF
  ABSENCE, baked in until the thread changes (not merely "caught
  next conversation": the thread leaves the queue). Mitigations:
  the threshold is a named knob with the calibration pairs logged;
  the veto rate is visible in the logs; a veto never edits a saved
  row (the observation never lands). Accepted residual: the
  verifier's judgment, not the observer's, breaks ties at the
  margin.
- **False vetoes on reactions** downgrade to `was_confirmed = null`
  (D4) - no EMA movement, the "looked" record survives; the
  calibration pair shows the downgrade.
- **The verifier's criteria are a compression of the falsification
  standard** - a five-question generative discipline compressed into
  noul criteria text may not judge identically. Mitigation: the
  criteria carry each question's substance + the catalog's nearMiss;
  the calibration pairs measure the divergence; the veto is the ONLY
  place the compression acts.
- **Verifier false negatives** (it passes a fabricated observation)
  leave today's exposure unchanged - the verifier is strictly
  additive protection, never a new risk surface.
- **Trimmed-state threads get partial verification** (D8's
  per-emission fail-open outside the window) - accepted, logged,
  revisit-if-common.
- **Claim-TTL arithmetic**: the observer's 429 retry ladder plus the
  verifier's 10s ceiling stay well inside the 300s TTL; a timeout
  fail-opens into a save, so the worst case is one save-rejected
  recycle next tick.
- **Beta wire drift / timeout** -> fail-open -> today's behavior.
  Same exposure as B1-B5.

## VERIFICATION

- Unit: the extended Deno suite (`mise run check`).
- **Live QA (shared-stack protocol, fixtures prefixed `ZZQA-B6`;**
  stack serves functions only from `~/dev/nak` - the branch dance;
  the sweep route dispatches ASYNC - poll the DB after):
  follow `docs/qa/use-cases/bias-pipeline.md`'s levers (day-gate
  backdate via SQL; POST the bias-sweep route with the SR key; the
  verifier's debug lines need the Logs drawer's level filter
  opened - it defaults to the profile's default level).
  1. **Clean-transcript arm**: a playful/light thread (no biased
     positions). Assert: zero observations before AND after (empty
     saves are valid); the verifier does NOT run on an empty
     emission set (no verifier log line).
  2. **Sound-observation arm**: a transcript with a clearly stated
     biased position (e.g. explicit sunk-cost reasoning). Assert:
     the observation saves with the observer's confidence; the
     verifier's p is logged; the calibration pair logged.
  3. **Veto/provenance arms are unit-pinned, not live-forced**: the
     veto path needs an observer miscalibration no scripted
     transcript can guarantee; the provenance check is
     deterministic. Live, assert on whatever the observer emits:
     the verifier ran (log lines + usage) and the calibration pairs
     are in the drawer.
  The executed row lands in the QA doc's Results log.
