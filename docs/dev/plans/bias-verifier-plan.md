# Bias Observer Falsification Verifier via Decision Model (B6)

Status: PLAN (refinement in progress - not yet built).

## SYNOPSIS

Keep the bias observer exactly as it is - ONE chat completion that
reads the transcript and emits observations and reactions with their
required prose - and add a decision-model FALSIFICATION VERIFIER
behind it: one batched `clef-api` call with one `noul` per emitted
observation and per directional reaction, judged against the same
falsification standard the prompt applies, dropping emissions that
fail it. The verifier can only veto (drop), never edit, never write.
Plus one deterministic, model-free provenance check that fixes a
pre-existing save-wedge.

Why this shape: the brainstorm's B6 idea - the Beta-Binomial aggregate
eating noul probabilities directly - is REJECTED here (D2). The
surviving fit uses the decision model for what it is good at:
adversarial verification of a generative claim. The observer's own
prompt names the catastrophe ("a fabricated signal contaminates
aggregate evidence for months"): the aggregate's per-thread evidence
(`p_conv`) is a noisy-OR over observation confidences, so one false
observation lifts a bias's posterior for months. A verifier pass
costs one call (~1 question per emission, typically 0-3 emissions,
sub-second against an hourly cron) and buys: an independent read of
the falsification ladder, calibration data (the observer's
self-confidence vs an independent soundness judgment, logged as a
pair), and a fix to a real wedge class.

This is B6 of the decision-model brainstorm
(`venice-decisions-plan.md:155-161`), the entry that said "do not
lead with it" and "hybrid at most" - the hybrid built here leads with
the chat model and uses the decision model only as a veto. Scope:
the analyze phase only; the aggregate phase, the catalog, the
schema, and every reader are untouched.

## BACKGROUND

The pipeline today (`venice/agents/bias.ts`, read this session):

- **Analyze** (`:411-612`): claim a settled thread cross-user
  (`bias_claim_next_thread_for_sweep`, TTL 300s, day-gated, cap 10
  per tick, a 3-attempt cap at claim time), read the transcript
  (user+assistant rows with id+content; tool calls and reasoning
  excluded; fork framing splices a FORK_POINT_MARKER + a
  only-cite-below note), build ONE JSON payload
  (`{messages, active_biases, fork_note?}`, `:279-289`), and run the
  observer: one chat completion (`BIAS_MODEL`, thinking off, 4096
  tokens) with the catalog + the falsification ladder + confidence
  semantics in the system prompt (`:102-206`). Parse + validate:
  observations `{bias, confidence [0.40,0.85], reasoning,
  evidence_message_id?}` and reactions `{bias in active set,
  was_confirmed true/false/null, reasoning}` - empty reasoning
  drops, non-active-bias reactions drop as fabrication (`:361-382`).
  Save via `bias_save_observations` (delete-then-insert under the
  claim + message-count guard).
- **Aggregate** (`:614-799`): per user per catalog bias, the
  `p_conv` per processed thread is a NOISY-OR over that thread's
  observation confidences (`schema.sql:14663`:
  `1.0 - exp(sum(ln(1.0 - confidence)))`; threads with no
  observation contribute 0) and reactions drive a feedback EMA;
  `aggregatePosterior` folds both into `bias_summary` (alpha, beta,
  mean, ci, tier).
- **Tests**: `tests/bias.test.ts` pins the prompt's catalog
  embedding, its structural sections, and the sweep tunables.

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
  save-wedge class. The null case (no id) is legitimate and common
  (the column is nullable: deleted messages keep the observation,
  lose the deep link).

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
  aggregate eating per-bias noul probabilities directly) fails three
  ways: the falsification ladder is a generative discipline a bare
  noul cannot apply (exactly the brainstorm's false-positive worry -
  and here the false positive IS the catastrophic direction); the
  observations' required reasoning + evidence citation are the
  audit trail (a decision model emits no prose); and the observer's
  confidence semantics ([0.40,0.85] anchors) are a judgment scale,
  not a probability of soundness. The verifier inverts the
  direction: the noul does not CREATE evidence, it vetoes unsound
  evidence - false positives in the verifier's hands protect the
  aggregate instead of poisoning it.
- **D3 - The verifier's contract: veto-only, fail-open.** Per
  emission under test, one `noul` judged against the ladder; below
  `VERIFIER_VETO_THRESHOLD = 0.5` the emission is DROPPED with a log
  line; at or above, it saves with the observer's confidence and
  prose untouched (the verifier never rewrites confidence or
  reasoning). Verifier failure at any layer (transport, timeout,
  malformed answers, no emissions to test) = everything stands -
  byte-for-byte today's behavior. The call is single-attempt and
  timed (`DECISION_CALL_TIMEOUT_MS`, the shared 10s ceiling - a
  stalled fetch must degrade to fail-open, not hang the drain).
- **D4 - What gets verified: observations always; reactions only
  directional.** Observations (the p_conv driver) are all verified.
  Reactions: only `was_confirmed` true/false - directional claims
  that move the feedback EMA. Neutral (null) reactions are skipped:
  verifying "I saw no signal" is proving absence, their recorded
  value is "the agent looked" (schema comment), and they do not
  move the EMA. The question count is capped at the shared
  `DECISION_ITEM_CAP = 12` total (observations first, then
  directional reactions; excess passes unverified and logged -
  typical emission counts are 0-3).
- **D5 - State: the observer's exact payload, rebuilt once.** The
  verifier sees the SAME `{messages, active_biases, fork_note?}`
  JSON the observer saw (extracted into a pure `buildObserverPayload`
  used by both paths) - including the fork marker + note, so the
  verifier inherits the only-cite-below-the-marker rule. No
  transcript re-serialization (the payload IS the state shape this
  consumer already owns - `_decision_state.ts`'s serializer is for
  StoredMessage[] renders and is not forced here). The questions
  carry the emission under test (bias key, the observer's reasoning,
  the confidence, the evidence pointer's presence) and the ladder:
  observation criteria = the five falsification questions compressed;
  reaction criteria = the four reaction-falsification questions +
  the specificity bar.
- **D6 - The deterministic provenance check (model-free), which
  also fixes the wedge.** Before the verifier: a present
  `evidence_message_id` that does not resolve to a USER message row
  in the transcript payload is nulled out (the observation is kept,
  the deep link is dropped - the exact semantics the schema already
  documents for deleted messages) with a log line. This is the
  free half of the falsification discipline: the observer can only
  cite ids it saw, so an unresolvable id is a fabrication class the
  model need not judge. It removes the FK-violation wedge: no
  unresolvable id reaches `bias_save_observations`' cast.
- **D7 - Calibration is the deliverable.** Every verified emission
  logs the pair (observer confidence, verifier p) plus usage - the
  first real measurement of the observer's calibration against an
  independent judgment. Nothing persists beyond what today saves
  (no schema change; the pair lives in the drawer logs, user-visible
  at debug like B4/B5's). A future tuning of CONFIDENCE_FLOOR/CAP or
  the ladder reads these logs.

## PLAN

1. **`bias.ts`**: extract `buildObserverPayload` (pure; used by both
   paths); add the deterministic provenance check (D6); add
   `verifyEmissions` (the batched verifier call + coercion + veto,
   D3/D4/D5) wired into `observeThread` after validation, before
   return; add `BIAS_VERIFIER_MODEL` to `agent-models.ts`. The
   observer prompt, the catalog, the sweep skeleton, the save RPC
   call, and the aggregate phase are untouched.
2. **Tests** (`tests/bias.test.ts` + the shared suite): the payload
   extraction (fork note + marker splice identical to today's);
   the provenance check (a resolvable id passes; an unresolvable id
   is nulled and logged; a missing id tolerated); the verifier body
   builder (model alias, state = the payload verbatim, per-emission
   noul ids, the ladder in the criteria, the cap); the coercion +
   veto table (drop below 0.5, keep at/above, fail-open on null/
   malformed/empty); the directional-only reaction rule; the
   calibration log line. `tests/decision-state.test.ts` (if the
   shared coercers' tests need a home - currently pinned transitively
   through B4/B5's suites).
3. **Docs.** `docs/qa/use-cases/bias-pipeline.md`: the analyze phase
   gains the verifier stage (veto-only, fail-open, the wedge fix)
   and the executed row after the live run. The parent plan's B6
   entry flips to implemented + pointer here. (There is no separate
   bias feature doc in docs/dev/ - the pipeline's header comment +
   the QA doc carry the behavior.) The shared coercers stay pinned
   transitively through the B4/B5 suites - no new test file for
   them.
4. **Gate, self-review, QA, land.** `mise run check` (exit code
   un-piped), the codified pre-merge self-review, live QA below,
   land on main, CI watch through deploy.

## RISKS

- **False vetoes** (a real observation dropped - the aggregate
  loses a true signal). Mitigations: the prompt's own philosophy
  accepts this ("a missed signal today gets caught next
  conversation"); the threshold is a named knob with the calibration
  pairs logged; the veto rate is visible in the logs. Accepted
  residual: the verifier's judgment, not the observer's, breaks
  ties at the margin.
- **The verifier's criteria are a compression of the ladder** - a
  five-question generative discipline compressed into noul criteria
  text may not judge identically. Mitigation: the criteria carry
  each question's substance; the calibration pairs measure the
  divergence; the veto is the ONLY place the compression acts.
- **Verifier false negatives** (it passes a fabricated observation)
  leave today's exposure unchanged - the verifier is strictly
  additive protection, never a new risk surface.
- **Beta wire drift / timeout** -> fail-open -> today's behavior.
  Same exposure as B1-B5.
- **The fork-marker splice in the verifier's state**: the payload
  carries the marker as a system entry with NO id - the observer is
  told not to cite it; the verifier's criteria do not need the
  marker rule (it constrains CITATION, and the provenance check
  handles citation integrity deterministically).

## VERIFICATION

- Unit: the extended Deno suites (`mise run check`).
- **Live QA (shared-stack protocol, fixtures prefixed `ZZQA-B6`;**
  stack serves functions only from `~/dev/nak` - the branch dance;
  the sweep route dispatches ASYNC - poll the DB after):
  follow `docs/qa/use-cases/bias-pipeline.md`'s levers (day-gate
  backdate via SQL; POST the bias-sweep route with the SR key).
  1. **Clean-transcript arm**: a playful/light thread (no biased
     positions). Assert: zero observations before AND after the
     verifier (empty saves are valid); the verifier does NOT run on
     an empty emission set (no verifier log line).
  2. **Sound-observation arm**: a transcript with a clearly stated
     biased position (e.g. explicit sunk-cost reasoning). Assert:
     the observation saves with the observer's confidence; the
     verifier's p is logged high; the calibration pair logged.
  3. **Veto/provenance arms are unit-pinned, not live-forced**: the
     veto path needs an observer miscalibration no scripted
     transcript can guarantee; the provenance check is
     deterministic. Live, assert on whatever the observer emits:
     the verifier ran (log lines + usage) and the calibration pairs
     are in the drawer.
  The executed row lands in the QA doc's Results log.
