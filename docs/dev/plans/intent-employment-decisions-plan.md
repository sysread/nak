# Intent Employment Judge via Decision Model (B4)

Status: PLAN (refinement in progress - not yet built).

## SYNOPSIS

Convert the intent employment judge - the settled-thread sweep that
records, per active intention, what actually happened with it
(`supabase/functions/venice/agents/intent_employment.ts`) - from one
chat completion with a JSON contract to one Decisions API call with
typed questions. The prompt is already decision-shaped: per intent it
asks a yes/no (`opening`), a yes/no (`acted`), and a closed-set pick
(`reaction`), minted dynamically from the thread's active intent list
(`intent_employment.ts:43-54`). A decision model answers those
natively: no JSON fence to strip, no prose to parse, no chain-of-
thought to leak. The `reasoning` sentence is the only casualty, and it
is telemetry with zero readers (verified below).

The sweep's skeleton - claim, guard, save, cap - does not change. This
is a judge swap, not a workflow change. No UI, no routes, no schema.

## BACKGROUND

What the judge does today, end to end (all read this session):

- **Sweep tick** (`intent_employment.ts:150-186`): claims up to 10
  settled threads cross-user (`intent_employment_claim_next_thread`,
  TTL 300s, min 2 user messages), toggle-gated on `intentsEnabled`
  with `intent_active_at_turn` non-empty and
  `processed_at is null or < updated_at` (schema.sql, claim RPC).
  Per-thread failure is caught and logged; the tick never throws.
- **Per thread** (`intent_employment.ts:188-268`): resolves the
  snapshot ids to intents that still exist (FK), tags them
  `e1..eN` (`:205-209`), loads the transcript via `loadThreadSlice`
  (`_recall_helpers.ts:196-229` - last-user-turn trim, then
  `trimToCharBudget` at `MAX_RECALL_CHARS = 200_000`,
  `_recall_helpers.ts:47,78-94`), and runs ONE chat completion:
  system prompt (the bookkeeping-framed judge prompt), the transcript
  as role-tagged wire rows (`messageToVenice`), and a final user turn
  carrying the tagged intent list (`:224-228`,
  `buildEmploymentRequest :72-79`). Call config:
  `INTENT_EMPLOYMENT_MODEL = EASY_TASK_MODEL` = `z-ai-glm-5-3-flash`
  (`_shared/agent-models.ts:47,69`), `disableThinking: true`,
  `retryRateLimit: true`, 2048 max tokens (`:230-242`). Completion
  failure = no save, no stamp; the thread re-eligibles next tick
  (`:244-249`).
- **Parse** (`intent_employment.ts:81-136`): strip a JSON fence, then
  per-entry validation - tag must be one we asked about, non-empty
  reasoning, `acted` forced false without an opening, `reaction`
  forced null unless acted and in
  `{receptive, neutral, resistant}`. Dropped entries are just lost
  (the save stamps the thread processed either way).
- **Save** (`intent_employment.ts:270-297`): `intent_employment_save`
  RPC - delete-then-insert per thread under the claim + message-count
  guard. The RPC inserts `v_e->>'reasoning'` verbatim (column is
  `text NOT NULL`) and `nullif(v_e->>'user_reaction', '')` so an
  empty reaction string lands as NULL (schema.sql, save RPC).

Why the conversion is safe, reader-wise (verified this session):

- The minter reads aggregates only:
  `select('intent_id,opening,acted,user_reaction,created_at')`
  (`venice/agents/intent.ts:506`) and **excludes null reactions** from
  the aggregate (`:553-557`, `if (row.user_reaction)`), so the
  tri-state NULL semantics are load-bearing.
- The backtest reads `intent_id, acted` only
  (`_shared/intent-backtest.ts:79-82`).
- The browser reads nothing: `grep -rn 'intent_employments|user_reaction' src/`
  is zero hits.
- **Nobody reads `reasoning`.** It is prompt-only telemetry today.

Decision API facts the design rides on (parent plan
`venice-decisions-plan.md`, live-calibrated 2026-11-18):

- One call = one `state` (string / JSON object / array; **32k
  tokens**) + a map of typed questions, each evaluated independently
  against the same state (`:27-29`). `clef-api` limits: 32k state /
  32k total (`:51-52`).
- Batching is sublinear - one question on a small state: 392 input
  tokens; four questions on the SAME state: 546; the state's tokens
  are counted once, not per question (`:61-65`). Per-intent question
  fan-outs are cheap.
- `noul` returns a probability (no separate confidence); `choice`
  returns the pick, the full option distribution, and a confidence
  (`:31-40`).
- Established call patterns: B1's `buildGateRequest` body shape
  `{ model, state, questions: { <id>: { type, instructions,
  criteria } } }` + answer at `answers.<id>.noul`
  (`venice/priming/pivot-gate.ts:117-153`); B2's rules-in-question
  pattern - verdict-shaping lives in the question's
  `instructions`/`criteria` (`second_thoughts.ts:517-542`), model as
  a local named constant (`:77`), state budget with tool-cap
  tightening (`:544-552`).

## DECISIONS (proposed - refinement may amend)

- **D1 - Model: `clef-api`, repointing the existing constant.** The
  state carries the user's own words, so the private-tier decision
  model is mandatory (parent plan D1). `INTENT_EMPLOYMENT_MODEL`
  (`agent-models.ts:69`) is repointed from `EASY_TASK_MODEL` to
  `'clef-api'` with a comment - same name, same home, so imports and
  the `__test` exposure stand; the "decision models own the
  EASY_TASK tier's classification half" rule
  (`venice-decisions-plan.md:164-165`) is the precedent.
- **D2 - ONE decision call per thread, 3N questions.** Minted from
  the live intent list: `opening-eN` (noul), `acted-eN` (noul),
  `reaction-eN` (choice). The state's tokens are counted once
  regardless of question count, so N intents cost N×(2 noul + 1
  choice) plus one state pass. No conditional minting: `acted` is
  asked even when `opening` reads false, and coercion enforces
  `acted = opening ∧ p ≥ cut` - exactly today's parser rule
  (`intent_employment.ts:123-131`).
- **D3 - The reaction choice carries a 4th option, `none`.** The
  minter drops null reactions from its aggregate, so a forced 3-way
  pick would fabricate a signal today's judge refuses to give
  (null when "no signal to read", `intent_employment.ts:48`).
  `none` = "the assistant did not act, or the user's response is not
  observable" and coerces to NULL (as does anything when `acted` is
  false). Schema check constraint unchanged
  (`user_reaction in (...)` or NULL).
- **D4 - Probability cut at 0.5; confidence is log-only.**
  `EMPLOYMENT_NOUL_THRESHOLD = 0.5` maps noul probability to the
  boolean - the neutral reading of "is this yes" - as a named,
  documented knob (B1 calibrated its own `GATE_FIRE_THRESHOLD = 0.7`
  for a different question). Per the B3 ruling's spirit: the cut
  picks a SIDE, it never drops a row - every intent gets its
  employment row regardless of confidence; the per-tag probabilities
  and the choice confidence are logged (debug) for observability and
  later calibration.
- **D5 - The `reasoning` sentence is retired; the column receives
  `''`.** No reader exists (verified above); the column is
  `text NOT NULL` so `''` satisfies it, and the save RPC passes it
  verbatim. No migration, no schema change - the column goes
  vestigial; a future migration may drop it. The judge's bookkeeping
  framing ("NOT a judgment of whether the intention is good" - the
  firewall language, `intent_employment.ts:38-42`) travels into the
  question `instructions` (B2's D5 pattern), where the "do not
  invent openings" and "only if you can point to where it shows"
  rules also land.
- **D6 - State budget: trim rows, clip rows, cap tool bodies - one
  pass, no re-serialization loop.** The 32k-TOKEN state cap vs
  `loadThreadSlice`'s 200k-CHAR budget is the conversion's one real
  collision. Order of operations: `trimToCharBudget(slice,
  EMPLOYMENT_STATE_BUDGET_CHARS = 80_000)` (existing helper,
  keep-newest, `_recall_helpers.ts:78-94`), then serialize with a
  per-row content clip (`MAX_ROW_CHARS = 24_000` - the trim's
  always-keep-last edge would otherwise let one giant row fail the
  thread on every tick, a failure the 1M-window chat path never
  had) and the existing 4k per-tool-result cap in the serializer.
  80k chars ≈ 20k tokens at ~4 chars/token; questions + intent
  statements ride in the same 32k budget with headroom. Residual: a
  pathological state past every bound → upstream 400 → no save, no
  stamp → re-eligible next tick (accepted; mirrors B2's residual).
  Keep-newest is the right degradation: recent behavior is the most
  diagnostic, and the day-gate re-evaluates the thread on its next
  update.
- **D7 - Transport: `veniceDecision`, single attempt, no timeout
  race.** The helper is a thin verbatim relay with no retry loop
  (`_shared/venice/decisions.ts:1-14`). Failure (network, 429, 400,
  malformed) = log + no save + no stamp, the same contract as
  today's completion-failure path (`intent_employment.ts:244-249`).
  This sweep is a cron tail, not the TTFT path - B1's 1500ms race
  does not apply here; the claim TTL bounds the work.
- **D8 - State shape: object `{ intents, transcript }`.** The intent
  list rides as structured data (`[{tag, statement}]`); the
  transcript rides as a fenced string rendered from the slice rows -
  `[user]` / `[assistant]` content, tool calls as a rendered line
  list, `[tool result: name]` bodies with the cap. B2's
  `serializeExchange` is NOT reused: its fence names, reasoning
  inclusion, and quote-verification extras are second-thoughts
  semantics (`second_thoughts.ts:392-450`), and today's employment
  judge never sees reasoning (the slice selects no reasoning
  column, `intent_employment.ts:28`). The module gets its own small
  serializer, exported for tests.

## PLAN

1. **Rework `intent_employment.ts`.** Replace the prompt,
   `buildEmploymentRequest`, `stripJsonFence`, and the JSON parsing
   with: `buildEmploymentRequest(intents, transcript)` → the
   `/decisions` body (D2/D5/D8), `parseEmploymentVerdicts(payload,
   validTags)` → the same `Map<tag, verdict>` contract from the
   answers map (D2/D3/D4), the transcript serializer + budget trim
   (D6/D8), and the runner swap (`toolComplete` → `veniceDecision`,
   D7). `EmploymentVerdict` loses `reasoning`; the row builder
   writes `reasoning: ''` (D5). Claim/save/sweep skeleton, cap, TTL,
   and logging shape unchanged.
2. **Repoint the model constant** (`agent-models.ts:69`) with the
   decision-model comment (D1). `INTENT_EMPLOYMENT_MAX_TOKENS`,
   `disableThinking`, and `retryRateLimit` die with the chat call.
3. **Rewrite `tests/intent_employment.test.ts`.** Pin: the body
   shape (model, state fences, 3 correctly-typed questions per
   intent), the firewall language living in the question
   instructions, and the coercion table - happy path; `acted` forced
   false without an opening (reaction nulled too); reaction `none` →
   NULL; unknown tag dropped; missing/malformed answers dropped per
   tag; budget trim + per-row clip behavior on an over-budget
   fixture.
4. **Docs.** `docs/dev/in-progress/intents.md` item 11: the judge
   rides the decisions endpoint (`clef-api`), reasoning no longer
   produced (column receives `''`), the state budget guard.
   `docs/dev/plans/venice-decisions-plan.md`: flip the B4 entry to
   implemented + pointer here. QA use-case doc gets its executed row
   after the live run.
5. **Gate, self-review, QA, land.** `mise run check` (exit code read
   un-piped), the codified pre-merge self-review (slop-grep over
   added lines, straggler scan for retired names, adversarial read
   of own comments), live QA below, then land on main.

## RISKS

- **Probability calibration.** The 0.5 noul cut is untested against
  real transcripts; B1 needed its own calibrated threshold. The
  constants are the knobs and the QA run sanity-checks a scripted
  transcript; post-landing, the logged distributions are the
  calibration data.
- **Keep-newest trim narrows very long threads** relative to
  today's 200k view (D6). Accepted: telemetry only, day-gated
  re-evaluation on update, and the alternative is per-tick failure.
- **`none` vs `neutral` criteria blur** could inflate one bucket.
  The criteria wording carries the distinction (engaged-without-
  direction vs nothing-observable); QA watches the mix on the
  scripted transcript.
- **Beta wire drift** (`/decisions` is BETA) surfaces as upstream
  400 → no save → re-eligible; the sweep degrades to "not recording"
  without writing wrong rows. Same exposure as B1/B2.

## VERIFICATION

- Unit: the rewritten Deno suite (`mise run check`).
- **Live QA (shared-stack protocol, fixtures prefixed `ZZQA-B4`):**
  local stack serves functions only from `~/dev/nak` (check this
  branch out there for the QA, restore after). Follow
  `docs/qa/use-cases/intent-employment.md` preconditions: opted-in
  profile, forged active intent, settled thread with the snapshot;
  POST the `intent-employment-sweep` route (the deterministic
  stand-in for the hourly cron) with the service-role key. Assert:
  `intent_employments` rows match the scripted transcript's ground
  truth (opening/acted/reaction per intent); `reasoning = ''`;
  reaction NULL when not acted; per-tag probabilities in the debug
  log. Then: toggle-off user → not claimed; message-count drift →
  save rejected + thread re-eligibles (RPC guard, unchanged).
  The QA doc's manual case gets its executed row.
