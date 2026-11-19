# Intent Employment Judge via Decision Model (B4)

Status: IMPLEMENTED 2026-11-19 (branch intent-employment-decisions;
base origin/main cf45fb0e). Refinement: the seven-lens fan-out, then
one fresh-context reviewer; round 2 caught a wrong mechanism claim
folded in round 1 (D4's minter-consequence sentence - the row is
aggregate-NEUTRAL) and the plan was rerooted per its prescription.
Live QA passed and surfaced a day-one schema bug (PLAN step 3).

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
thought to leak. Two casualties, both verified harmless: the
`reasoning` sentence - telemetry with zero readers in any revision
of the repo (verified this session by grep over current code, full
git history of the readers, and the unmerged parallel commits) - and
the non-empty-reasoning entry-validity gate it fed (D4 names the
structural replacement).

The sweep's skeleton - claim, guard, save, cap - does not change. This
is a judge swap, not a workflow change. No UI, no routes. One schema
line: the save RPC's service_role execute grant, a day-one bug the
live QA surfaced (PLAN step 3).

## BACKGROUND

What the judge does today, end to end (all read this session):

- **Sweep tick** (`intent_employment.ts:150-186`): claims up to 10
  settled threads cross-user (`intent_employment_claim_next_thread`,
  TTL 300s, min 2 user messages), toggle-gated on `intentsEnabled`
  with `intent_active_at_turn` non-empty. Claims order oldest-first
  (`order by t.updated_at asc`) and take one thread per call
  (`for update skip locked`; the tick loops the cap). Per-thread
  failure is caught and logged; the tick never throws.
- **The day-gate** (the claim RPC's date predicate): a thread is
  eligible only when its last update landed on a PREVIOUS local day -
  `(t.updated_at at time zone usertz.tz)::date <
  (now() at time zone usertz.tz)::date` (schema.sql,
  claim RPC). A settled conversation is judged no earlier than the
  day after it went quiet, and after processing, re-evaluation
  requires BOTH a newer update (`processed_at is null or <
  updated_at`) AND that update crossing a day boundary again. This
  document uses "day-gate" only in that sense.
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
  (`:244-249`). Note the ASYMMETRY in today's contract: a transport
  failure leaves the thread unprocessed, but a garbage REPLY (parse
  yields nothing) still saves an empty set and stamps processed -
  the queue advances (`:251-266`; save RPC stamps under the guard).
- **Parse** (`intent_employment.ts:81-136`): strip a JSON fence, then
  per-entry validation - tag must be one we asked about, non-empty
  reasoning (a content-quality gate: an entry that "said nothing
  checkable" is dropped, `:120-121`), `acted` forced false without an
  opening, `reaction` forced null unless acted and in
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
  (`venice/agents/intent.ts:507`) and **excludes null reactions** from
  the aggregate (`:553-557`, `if (row.user_reaction)`), so the
  tri-state NULL semantics are load-bearing.
- The backtest reads `intent_id, acted` only (the `EmploymentRow`
  interface, `_shared/intent-backtest.ts:75-78`; `buildCorpus` counts
  ACTED rows among ALL rows, `:101-104`).
- The browser reads nothing: `grep -rn 'intent_employments|user_reaction' src/`
  is zero hits.
- **Nobody reads `reasoning`.** It is prompt-only telemetry today, and
  always was (archaeology: the column was created before any writer,
  and no historical revision of any reader selected it).

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
  (`venice-decisions-plan.md:164-165`) is the precedent. This
  knowingly departs from B2's shape (a local `VERDICT_MODEL` const,
  `second_thoughts.ts:77`): B2's shared constant still feeds the
  note call; this one has exactly one consumer, so the repoint is
  clean. The comment must state that the file's thinking-pin mandate
  (`agent-models.ts:30-36`) is a chat-completion rule - a decisions
  call has no thinking knob to pin - and the tier preamble gains a
  line noting this constant is a decision model, not a tier alias,
  so a future edit of `EASY_TASK_MODEL` does not assume this agent
  moves with it.
- **D2 - ONE decision call per thread, 3N questions.** Minted from
  the live intent list: `opening-eN` (noul), `acted-eN` (noul),
  `reaction-eN` (choice). The state's tokens are counted once
  regardless of question count, so N intents cost Nx(2 noul + 1
  choice) plus one state pass. No conditional minting: `acted` is
  asked even when `opening` reads false, and coercion enforces
  `acted = opening and p >= cut` - today's parser rule
  (`intent_employment.ts:123-131`) lifted to probabilities (today
  takes a verbatim boolean; the threshold is the probability
  translation). No conditional minting also means no second round
  trip. If a fourth decision consumer lands someday, hoist a shared
  body builder into `_shared/venice/decisions.ts` then - two
  consumers with documented divergence is the existing convention.
- **D3 - The reaction choice carries a 4th option, `none`.** The
  minter drops null reactions from its aggregate, so a forced 3-way
  pick would fabricate a signal today's judge refuses to give
  (null when "no signal to read", `intent_employment.ts:48`).
  `none` = "the assistant did not act, or the user's response is not
  observable" and coerces to NULL (as does anything when `acted` is
  false). Schema check constraint unchanged
  (`user_reaction in (...)` or NULL). The tri-state split is day-one
  design (neutral = acted with no directional signal, DISTINCT from
  null; schema comment cites `bias_reactions.was_confirmed`'s null
  as loose precedent), and the `none` option preserves it.
- **D4 - Probability cut at 0.5; confidence is log-only; the
  row-level semantics change is named and accepted.**
  `EMPLOYMENT_NOUL_THRESHOLD = 0.5` maps noul probability to the
  boolean - the neutral reading of "is this yes" - as a named,
  documented knob (B1 calibrated its own `GATE_FIRE_THRESHOLD = 0.7`
  for a different question). Per the B3 ruling's spirit: low
  confidence never drops a row - every ASSESSED intent gets its
  employment row regardless of confidence (the D6 intent cap bounds
  "assessed"; a missing or malformed per-tag ANSWER still drops that
  tag's row - the presence check, `:120-121`'s only survivor); the
  per-tag probabilities and the choice confidence are logged (debug)
  for observability and later calibration. THE ROW-LEVEL CHANGE,
  named: today an intent the judge cannot assess gets NO row (the
  model may omit it, `intent_employment.ts:54`; empty-reasoning
  entries drop, `:120-121`). Post-change every assessed intent gets
  a row, and evidence that would have been "cannot assess" coerces
  to `opening=false, acted=false, reaction=null`. That row is
  AGGREGATE-NEUTRAL for today's consumers: the minter's counters
  move only on `opening=true`, `acted=true`, or a non-null reaction
  (`intent.ts:553-557`), so an all-false row moves nothing - the
  aggregate cannot tell the new row from the old absence, and the
  DORMANT signal ("few or no recent openings") is untouched. The
  change is real only at row level - a future reader of the table
  sees rows v1 never wrote - and in the logs. Accepted, because the
  alternative (a drop-below-floor rule) reintroduces row loss and
  violates the no-drop principle, and the day-gate means the judge
  only ever sees finished days. Documented in intents.md item 11 as
  a v2 behavior change (row-level; aggregate-neutral). The retired
  non-empty-reasoning gate had no content-quality replacement - the
  answers-map presence check is structural only; that gate's
  retirement is part of this same accepted change.
- **D5 - The `reasoning` sentence is retired; the column receives
  `''`.** No reader exists (verified above); the column is
  `text NOT NULL` so `''` satisfies it, and the save RPC passes it
  verbatim. No migration, no schema change - the column goes
  vestigial; a future migration that drops it must also touch the
  save RPC's insert list (it consumes `v_e->>'reasoning'`). The
  judge's bookkeeping framing ("NOT a judgment of whether the
  intention is good" - the firewall language, `intent_employment.ts:38-42`)
  travels into the question `instructions` (B2's D5 pattern), where
  the "do not invent openings" and "only if you can point to where
  it shows" rules also land. The firewall's enforcement is
  structural (separate table, separate writer - archaeology: the
  commit message binds "prompt framed as bookkeeping" to the
  firewall, but the enforcement lives in the schema separation), so
  a transport swap threatens nothing as long as the framing travels.
- **D6 - State budget: trim rows, clip rows, cap tool bodies - one
  pass, no re-serialization loop.** The 32k-TOKEN state cap vs
  `loadThreadSlice`'s 200k-CHAR budget is the conversion's one real
  collision. Order of operations: `trimToCharBudget(slice,
  EMPLOYMENT_STATE_BUDGET_CHARS = 80_000)` (existing helper,
  keep-newest, `_recall_helpers.ts:78-94`), then serialize with a
  per-row content clip (`MAX_ROW_CHARS = 24_000` - the trim's
  always-keep-last edge would otherwise let one giant row fail the
  thread on every eligible tick, a failure the 1M-window chat path
  never had) and B2's 4k per-tool-result cap
  (`MAX_TOOL_RESULT_CHARS = 4000`, `second_thoughts.ts:121`),
  reimplemented in the new serializer (nothing reusable exists -
  see D8). Accounting note: the trim counts
  `content + JSON.stringify(tool_calls)` (`_recall_helpers.ts:86-88`)
  while the serializer renders tool calls as short lines, so the
  counted chars OVERCOUNT what gets serialized - the safe direction;
  fence and role-prefix overhead add a small uncounted amount. A
  debug log of the final serialized length feeds calibration. 80k
  chars ~ 20k tokens at ~4 chars/token; questions + intent
  statements ride in the same 32k budget with headroom. Two bounds
  on the question count: (1) the judge assesses at most
  `EMPLOYMENT_MAX_INTENTS = 12` snapshot ids (first by id order;
  excess logged and skipped - no row for them this round, a
  degenerate-portfolio guard; today ALL snapshot ids are judged);
  (2) the intents select gains `.order('id')` so tags `e1..eN` are
  deterministic (today: PostgREST return order - cosmetic, but the
  QA asserts per-tag ground truth). Residual: a pathological state
  past every bound -> upstream 400 -> D7's deterministic-rejection
  path. Keep-newest is the right degradation: recent behavior is
  the most diagnostic, and the day-gate re-evaluates the thread
  after its next update. CJK risk: ~4 chars/token is an
  English-calibrated figure; CJK-heavy transcripts run ~1-3
  chars/token and can push 80k chars past 32k tokens - accepted for
  now (the usage log in VERIFICATION exposes the real ratio; lower
  the budget constant if it bites).
- **D7 - Transport: `veniceDecision`, single attempt, no timeout
  race, and the failure contract mirrors today's asymmetric one.**
  The helper is a thin verbatim relay with no retry loop
  (`_shared/venice/decisions.ts:1-14`). Failure handling splits by
  kind, extracted as a pure classifier pinned by tests:
  - **Deterministic rejection** (`http` kind, status 400/422 -
    oversized state, beta wire drift): save an empty set + stamp
    processed, matching today's garbage-parse contract (the queue
    ADVANCES; `intent_employment.ts:251-266`). Without this, a
    deterministic 400 leaves the thread re-eligible forever, and
    since claims order oldest-first, enough poison threads would
    permanently occupy the tick's 10 slots and starve newer threads.
  - **Transient failure** (network, rate_limit, 5xx, response parse):
    log + no save + no stamp, the same contract as today's
    completion-failure path (`intent_employment.ts:244-249`) - the
    thread re-eligibles next tick.
  This sweep is a cron tail, not the TTFT path - B1's 1500ms race
  does not apply here; the claim TTL bounds the work. Decision calls
  expose no thinking control (the endpoint owns any reasoning
  behavior); the calibration's ~360ms and the usage log are the
  cost evidence.
- **D8 - State shape: object `{ intents, transcript }`.** The intent
  list rides as structured data (`[{tag, statement}]`); the
  transcript rides as a fenced string rendered from the slice rows -
  `[user]` / `[assistant]` content, tool calls as a rendered line
  list, `[tool result: name]` bodies with the 4k cap,
  fork-framing `[system]` rows rendered verbatim (they are short
  boundary context; today's chat path sends them as system
  messages). B2's `serializeExchange` is NOT reused: its fence
  names, reasoning inclusion, and quote-verification extras are
  second-thoughts semantics (`second_thoughts.ts:392-450`), and
  today's employment judge never sees reasoning (the slice selects
  no reasoning column, `_recall_helpers.ts:219`). A bespoke
  serializer is also the repo's stated convention, not a one-off:
  `_shared/thread-transcript.ts:71-75` documents that transcript
  renderers are deliberately not shared because each consumer's
  caps serve different purposes (its own renderer is no fit - it
  drops tool-result bodies entirely, `:160`). The new serializer
  cross-references B2's `MAX_TOOL_RESULT_CHARS` in a comment so the
  two caps stay numerically consistent by intent. The module's
  header comment changes shape with it: "pure request builder +
  coercion pinned via `__test`", not "pure prompt + parser".

## PLAN

1. **Rework `intent_employment.ts`.** Replace the prompt,
   `buildEmploymentRequest`, `stripJsonFence`, and the JSON parsing
   with: `buildEmploymentRequest(intents, transcript)` -> the
   `/decisions` body (D2/D5/D8), `parseEmploymentVerdicts(payload,
   validTags)` -> the same `Map<tag, verdict>` contract from the
   answers map (D2/D3/D4), the transcript serializer, the budget
   trim, and the intent cap (D6/D8), the failure classifier
   (deterministic-vs-transient, D7), and the runner swap
   (`toolComplete` -> `veniceDecision`, D7). `EmploymentVerdict`
   loses `reasoning`; the row builder writes `reasoning: ''` (D5).
   The intents select gains `.order('id')` (D6). Claim/save/sweep
   skeleton, cap, and TTL unchanged (the new debug logs - per-tag
   probabilities, serialized length, `usage` - extend, not change,
   the logging shape); the module header comment updates with the
   shape (D8).
2. **Repoint the model constant** (`agent-models.ts:69`) with the
   decision-model comment and the tier-preamble line (D1).
   `INTENT_EMPLOYMENT_MAX_TOKENS`, `disableThinking`, and
   `retryRateLimit` die with the chat call (`toolComplete` keeps its
   11 other import sites - not orphaned).
3. **Grant the save RPC its execute** (schema.sql, one line beside
   the existing revoke): `grant execute on function
   public.intent_employment_save(...) to service_role`. Born without
   it (the claim RPC got the grant, the save never did), every save
   failed with `permission denied` and the sweep swallowed it as a
   warn - the use case had never been executed live (its Results log
   read "not run" since 2026-06-25). Production shows 167
   employment rows as of 2026-07-29, so prod's ACL presumably
   carries a live patch this backports to the source of truth.
4. **Rewrite `tests/intent_employment.test.ts`.** Pin: the body
   shape (model via the destructured `INTENT_EMPLOYMENT_MODEL` -
   which also gives the currently-unused `__test` export a consumer,
   state fences, 3 correctly-typed questions per intent, the
   intent cap), the firewall language living in the question
   instructions, the coercion table - happy path; `acted` forced
   false without an opening (reaction nulled too); reaction `none` ->
   NULL; unknown tag dropped; missing/malformed answers dropped per
   tag; budget trim + per-row clip behavior on an over-budget
   fixture; the failure classifier's split (deterministic ->
   empty-save-and-stamp, transient -> leave). Follow the sibling
   suites' import spelling (`'@std/assert'`, not `'jsr:@std/assert'`).
5. **Docs.** `docs/dev/in-progress/intents.md`: item 11 gains the
   v2 behavior (decisions endpoint, `clef-api`, the D4 row-level
   change named - unassessable intents now leave `opening=false`
   rows where v1 left none, aggregate-neutral since the minter's
   counters ignore all-false rows; the reasoning gate retired; the
   state budget + intent cap); the `### intent_employments` data-model section
   (`:387-406`) marks the reasoning column vestigial; the day-one
   phrase "one row per (intent, thread) where the judge ACTED" is
   corrected - rows land regardless of acted; `opening` exists
   precisely to split no-opening from missed-opening
   (`buildCorpus` counts acted rows among all rows).
   `docs/qa/use-cases/intent-employment.md`: the Expected section's
   "non-empty `reasoning`" assertion and its verification SQL flip
   to `reasoning = ''`; the "could assess" row-count phrasing
   updates to row-per-assessed-intent; the executed row lands after
   the live run. `docs/dev/plans/venice-decisions-plan.md`: flip
   the B4 entry to implemented + pointer here.
6. **Gate, self-review, QA, land.** `mise run check` (exit code read
   un-piped), the codified pre-merge self-review (slop-grep over
   added lines, straggler scan for retired names, adversarial read
   of own comments), live QA below, then land on main.

## RISKS

- **Probability calibration.** The 0.5 noul cut is untested against
  real transcripts; B1 needed its own calibrated threshold. The
  constants are the knobs and the QA run sanity-checks a scripted
  transcript; post-landing, the logged distributions + usage lines
  are the calibration data.
- **The row-level semantics change** (D4): evidence today's judge
  omits now records as `opening=false` rows - aggregate-neutral for
  today's minter and backtest (their counters ignore all-false
  rows), visible only to future readers of the table and the logs.
  Accepted and documented; no pruning-signal risk.
- **Deterministic-rejection wedge shape** (D7): the empty-save +
  stamp path keeps the queue advancing, but a uniform beta wire
  drift would stamp EVERY thread processed with no rows - loud in
  logs (empty saves + warnings on every tick), fixed by a code fix,
  and the day-gate means the re-judge backlog drains a day later.
  Accepted; an attempt-counter column was rejected as schema churn
  this change does not need.
- **Keep-newest trim narrows very long threads** relative to
  today's 200k view (D6). Accepted: telemetry only, day-gated
  re-evaluation after the next update, and the alternative is
  per-tick failure.
- **CJK token density** (D6): the 80k-char budget assumes English
  calibration; CJK transcripts can overflow 32k tokens. Accepted
  with the usage log as the tripwire.
- **`none` vs `neutral` criteria blur** could inflate one bucket.
  The criteria wording carries the distinction (engaged-without-
  direction vs nothing-observable); QA watches the mix on the
  scripted transcript.
- **Beta wire drift** (`/decisions` is BETA) surfaces as upstream
  400 -> deterministic-rejection path (above); the sweep degrades to
  "not recording" without writing wrong rows. Same exposure as
  B1/B2.

## VERIFICATION

- Unit: the rewritten Deno suite (`mise run check`).
- **Live QA (shared-stack protocol, fixtures prefixed `ZZQA-B4`):**
  local stack serves functions only from `~/dev/nak` (check this
  branch out there for the QA, restore after). Follow
  `docs/qa/use-cases/intent-employment.md` preconditions: opted-in
  profile, forged active intent, settled thread with the snapshot;
  POST the `intent-employment-sweep` route (the deterministic
  stand-in for the hourly cron) with the service-role key. HARD
  asserts (structure): one row per assessed intent; `reasoning =
  ''`; reaction NULL when not acted; the thread stamped processed
  and the claim released. SOFT observations (logged for
  calibration, not asserted - a real model may judge the scripted
  transcript differently than the author did): the actual
  opening/acted/reaction values per tag; per-tag probabilities + the
  decision response's `usage` (actual state tokens - pins D6's
  budget against real data). Then: toggle-off user -> not claimed;
  message-count drift -> save rejected + thread re-eligibles
  (RPC guard, unchanged by this diff; best-effort in QA - the drift
  is a race by construction, not deterministically scriptable).
  The QA doc's manual case gets its executed row.
