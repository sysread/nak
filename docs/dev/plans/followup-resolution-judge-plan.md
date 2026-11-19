# Follow-up Resolution Judge via Decision Model (B5)

Status: PLAN (round-1 lens fan-out folded; round-2 reviewer pending).

## SYNOPSIS

Add a decision-model judge pre-pass to the reflection agent's
follow-up reconciliation: for each OPEN follow-up, one `noul` question
("does this conversation contain this follow-up's outcome?") over the
settled transcript, answered in one batched `clef-api` call whose
verdicts inject into the reflection prompt as advisory evidence. The
agent keeps every bit of its existing authority - it still lists,
still closes, and the close's `resolution` line (required prose) is
still written by the agent, because a decision model emits no prose.

Why: the reconcile instruction is one section in a large prompt whose
agent is juggling the whole memory workflow; a missed close leaves a
resolved loop open, and an open resolved loop re-asks the user about
something they already told us - the exact nag the follow-up feature
exists to prevent. A focused per-follow-up judgment is repeatable and
cheap: ~1.4k input tokens is MEASURED (B4's live QA, a 6-question call
over a small scripted transcript); latency at this shape is UNMEASURED
(the calibration's small-probe bound is sub-second), and the call is
one batched round against a reflection run measured at ~9 minutes
where ROUNDS dominate the wall time (not prompt bytes - see RISKS).
The p values are logged, giving the first calibration data on how
often outcomes actually land in transcripts.

This is B5 of the decision-model brainstorm
(`venice-decisions-plan.md:152-154`). Scope is FOLLOW-UPS only; the
brainstorm's "intent resolution" half needs no new check (the
employment judge already feeds the minter's pruning).

## BACKGROUND

The follow-up design (docs/dev/followups.md, read this session)
constrains the shape hard:

- **Reflection is the ONLY background agent with follow-up tools**
  (Gotchas, first bullet). A dedicated follow-up agent was considered
  and REJECTED (commit ea9c8459, "Settle follow-up resolution
  ownership: reflection, not a new agent", codified at
  `followups.md:192-195`) because it would duplicate reflection's
  whole coordination apparatus (per-thread claim, day gate, catch-up
  sweep, attempt cap), pay a second Venice pass over the same
  transcripts, split mint-vs-resolve - which is one portfolio
  judgment over one context - and split judge from minter when
  "follow-ups have no posterior and nothing to self-grade, so no
  firewall forces a split here." The judge pre-pass reopens none of
  it structurally: it writes nothing, adds no agent/claim/cron/tool,
  and closes still flow through the single close op with its
  open-rows-only guard - but it DOES create the feature's first
  posterior (the logged p values), which D2 distinguishes. The
  separate single-writer rule ("two background resolvers means
  double-close races and prompt sprawl for zero coverage gain",
  `followups.md:190-191`) is about the wiki/record sweep never
  getting tools - also untouched.
- **The close op's resolution is required prose**
  (`reflection.ts:237-242` - wire `minLength: 1`, cap 500
  `MAX_FOLLOWUP_RESOLUTION_CHARS`, `_shared/followups.ts:19`; the
  tool enforces both, `venice/tools/followups.ts:244-253`). The
  resolution is the loop's audit stamp, NOT a persistence channel
  (followups.md:130, 170-173) - a canned "resolved per conversation"
  line defeats the stamp's purpose. Only the agent can close, and no
  reopen op or open-ward status transition exists anywhere - a
  recorded resolution is permanent by design.
- **Reflection runtime is the cost to watch** (followups.md Gotchas
  `:196-201`): measured ~9-minute runs motivated the attempt cap
  (`memory.md:348-359`); "trim the follow-up prompt section - do
  not split out a second agent." The recorded MEASUREMENT
  (c172d948, 2026-06-10) found zero memory writes in the 9-minute
  run and concluded "rounds and thinking dominate the wall time, not
  prompt size" - slice condensing was deliberately not done. So the
  pre-pass's own latency is noise, but induced VERIFICATION ROUNDS
  are the vector to watch (RISKS).
- **Dismissal is the user's veto** - reflection never carries
  dismiss; the wire enum `['list', 'save', 'close']` is the
  enforcement layer (`reflection.ts:209`, the comment at `:182-188`,
  pinned by `tests/reflection.test.ts:73-74`). The judge sees none
  of that surface; it answers one question per open row.
- **The reflection cycle today** (`reflection.ts:387-464`, the claim
  RPC in `sweepClaimAndReflectOnce :553-566`): claim
  (`claim_next_thread_for_reflection_sweep`, TTL 600s, hourly cron
  drain, day-gated, 3-attempts-per-terminal-message cap) ->
  `loadThreadSliceUpTo` (the terminal slice with fork framing,
  `_agent_tools.ts:250-289` - the SAME `StoredMessage[]` shape the
  B4 judge serializes) -> one `runHeadlessAgent` run
  (REFLECTION_MODEL, reasoningEffort low, 8-tool toolbox) over the
  slice with REFLECTION_PROMPT as the final "switch modes" user turn
  (`:406-410`) -> mark reflected under the claim. The cycle throws
  on a missing Venice key at `:403-404` - a no-key cycle errors
  before any judge could exist.

The follow-up reconcile section today (`reflection.ts:328-356`):
call op=list once; close an open follow-up when "the conversation
contains the OUTCOME" (the user reported how it went, asked or
unprompted); reschedule when the plan MOVED; create only when no
matching loop is open or already resolved (the stale re-creation
guard, pinned by `tests/reflection.test.ts:77`).

Decision-API facts and call patterns ride the parent plan's
calibration (32k-token state cap, batching sublinear - state counted
once, `noul` returns a probability) and B1/B4's precedents: B1's
composition doctrine (the gate composes with the deterministic
evaluator, never replaces it, fail-open on any failure) and B4's
shape (one batched call, questions minted per item, a fenced
transcript state with budget trim + row clip + tool-body cap, log-only
probabilities, single-attempt transport).

B4's hoist note ("if a fourth decision consumer lands someday, hoist
a shared body builder", `intent-employment-decisions-plan.md:152-154`)
triggers with B5 on the rationale that matters: two consumers now
serialize the SAME `StoredMessage[]` transcript for the SAME judgment
shape (whole settled thread, typed per-item questions) over the same
32k-token budget. B3 (grocery) never used the transcript serializer -
consumer count is not the real reason; the shared shape is. Today
`serializeTranscript` is exported from `intent_employment.ts:128`
consumed only by that module and its `__test`; the coercers
(`noulOf :215`, `choiceOf :223`) are genuinely module-private.

## DECISIONS (proposed - refinement may amend)

- **D1 - Model: `clef-api` via `DECISION_MODEL`** (the B4 tier
  constant, `agent-models.ts:54`): the state carries the user's own
  words (parent plan D1). The judge gets its own one-line alias
  `FOLLOWUP_JUDGE_MODEL = DECISION_MODEL` in
  `_shared/agent-models.ts` (the `INTENT_EMPLOYMENT_MODEL` precedent
  there, `:76-78`) so logged model ids stay greppable per consumer.
- **D2 - The judge composes; reflection keeps all authority.** The
  verdicts are ADVISORY EVIDENCE in the prompt. The agent still calls
  op=list, still verifies against the transcript, still decides, and
  still writes the resolution line. The judge cannot close, cannot
  suppress creation, and cannot dismiss. This is B1's composition
  doctrine applied to reflection, and it keeps followups.md's
  single-background-writer design intact. The recorded rejection
  rationale "follow-ups have no posterior and nothing to self-grade"
  (ea9c8459) is deliberately distinguished: the logged p values
  CREATE the feature's first posterior, but no firewall analog is
  needed - the verdicts never grade the agent, never feed any score,
  and nothing downstream consumes them (log-only, D6).
- **D3 - The shared decision-state module, homed at
  `venice/agents/_decision_state.ts`.** Extract from
  `intent_employment.ts`: the transcript serializer
  (`serializeTranscript` + the private `clip`/`renderToolCalls`
  helpers), the three serializer clip caps (`MAX_ROW_CHARS` 24k,
  `MAX_TOOL_RESULT_CHARS` 4k, `MAX_TOOL_ARG_CHARS` 300) as
  parameters, the coercers (`noulOf` / `choiceOf` + the answers-map
  shape), and the item cap (`EMPLOYMENT_MAX_INTENTS` moves and is
  renamed `DECISION_ITEM_CAP`; B4's `__test` export and its
  `>= 1` assert follow the rename). NOT homed in `_shared/venice/`: that
  directory's contract is "the barrel re-exports every symbol"
  (`_shared/venice.ts:12-13`) and every member is a wire relay;
  worse, the module needs `StoredMessage` from
  `venice/agents/_recall_helpers.ts:15` - a shared-to-agents import
  direction that exists nowhere in the tree (the precedent,
  `thread-transcript.ts:81-87`, defines its own row type rather
  than import across). Both consumers live in `venice/agents/`;
  the `_`-prefix path-import convention (`_run.ts`,
  `_agent_tools.ts`, `_recall_helpers.ts`) covers it. What does NOT
  move: the 80k trim budget (`EMPLOYMENT_STATE_BUDGET_CHARS` stays
  B4's call-site constant, applied via the existing
  `trimToCharBudget` - the trim was never part of the serializer)
  and the question builders (per-consumer shapes). B4's call site
  and `__test` re-exports follow the move - this is a signature
  change (parameterized caps), not a pure move, and B4's budget pin
  (`intent_employment.test.ts:57-60`) keeps pinning B4's chosen
  budget after parameterization. B1's `coerceGateAnswer`
  (`pivot-gate.ts:144-153`) - the one noul-coercer twin hardcoded to
  the `pivot` id - is rewired to the shared coercer in the same
  change (one line; a "shared answers coercer" module that leaves a
  fresh duplicate in the tree undercuts its own rationale).
- **D4 - Judge scope: all open follow-ups, capped.** Read directly
  (`select id, question, context from followups where user_id = ?
  and status = 'open'`, oldest first, capped at the shared
  degenerate-portfolio constant - the moved `EMPLOYMENT_MAX_INTENTS`,
  renamed `DECISION_ITEM_CAP` in the shared module so neither
  consumer owns "the number 12"). NOT the due-side selection
  (`selectDueFollowups`): an outcome can land in a transcript BEFORE
  its relevant_after date; the reconcile section's contract is over
  the whole open set. Skipped rows (cap excess) are unaffected - the
  agent's own list-based reconcile still covers them; the judge is
  additive evidence, never the only path. Known mismatch: the agent's
  op=list reads newest-first capped 50 (`tools/followups.ts:67-68`) -
  with more than 50 open rows the judge's flagged ids can fall
  outside the agent's list window (close still works by id; the
  list-based dedup evidence narrows). A >50-open-rows portfolio is
  degenerate; noted, not solved here.
- **D5 - Injection: a pure builder, a `<followup_judge>` block,
  placed BEFORE the single-word-reply contract.** The prompt const
  splits: `REFLECTION_PROMPT_BODY` + `SINGLE_WORD_REPLY_LINE` (the
  final paragraph, `:355-356`). The builder is pure over (body,
  verdicts-or-failure): no verdicts -> return the composed prompt
  byte-identical to today's; verdicts -> `BODY` + the block + the
  single-word line, so the discard-your-reply contract stays the
  LAST thing the model reads. The block follows the
  `loadThreadAttachmentsNote` contract (`_agent_tools.ts:291-319`):
  best-effort, returns the composed string, and a judge failure
  yields no block (the caller appends nothing). Per judged
  follow-up: id, the question, the verdict ("likely resolved here
  (p=0.87)" / "not resolved here"), and the advisory framing:
  verify against the transcript before closing; a close needs your
  own one-line resolution; a not-resolved verdict changes nothing.
- **D6 - Fire discipline: pre-pass, bounded, log-only, and the
  failure modes named.** Runs inside the reflection cycle after the
  slice loads and only when BOTH: the slice is non-empty AND the
  user has >= 1 open follow-up (a no-key cycle errors earlier at
  `:403-404` - not a skip case). The judge call carries
  `AbortSignal.timeout(FOLLOWUP_JUDGE_TIMEOUT_MS = 10_000)` - a
  STALLED fetch is not an error fail-open can catch: without the
  timeout it hangs the cycle before the agent runs (no mark, no log,
  the isolate dies at ~400s, the claim burns an attempt; three hangs
  wedge the thread out of reflection). 10s is ~25x the expected
  latency and far under the kill. The same timeout fix lands for
  B4's judge (its hang starves the remaining drain loop) AND B2's
  verdict call (its hang stalls the completed-turn waitUntil tail) -
  both currently pass no signal (see PLAN 2).
  Timeout/transport/coercion failure = info log (B4's level) + no
  block (fail-open). The p values, the decision response's `usage`,
  AND a post-run reconciliation line are logged: after the agent's
  run, one re-read of the judged rows (a single query by id) joins
  each follow-up's p value with its row state -
  a close of a low-p row is a false-close candidate, a still-open
  high-p row is a missed-close candidate. (The Logs drawer
  broadcasts debug to the user - "log-only" means in-drawer, same
  as B4's usage/answers lines.) Nothing is persisted: no schema, no
  rows, no new readers.
- **D7 - The prompt's reconcile section stays the authority.** The
  section's instructions do not weaken: op=list first, the
  answered/dismissed dedup guard, conservative closing. The
  injection's wording must not read as a command ("close the flagged
  ones") - it is evidence about WHERE an outcome may sit, aimed at
  fixing misses, with the verification burden on the agent.

## PLAN

1. **Extract `venice/agents/_decision_state.ts`** (D3): move
   `serializeTranscript` + helpers + coercers + the item cap
   (renamed `DECISION_ITEM_CAP`) out of `intent_employment.ts` with
   parameterized clip caps; rewire B1's `coerceGateAnswer` to the
   shared coercer; update `intent_employment.ts` (imports, call
   site, `__test` re-exports, and the `:73-75` sync-by-intent
   comment now pointing at the shared home) and its test (the
   budget pin stays; the cap assert follows the rename; the
   serializer tests follow the `__test` re-export).
2. **Add the judge to `reflection.ts`**: the follow-ups read (D4),
   the body builder (per-follow-up noul with the question + context
   in the instructions; state = `{ transcript, followups }`), the
   coercion (per-id verdicts, fail-open), the pure prompt builder
   with the split consts (D5), and the wiring in
   `reflectClaimedThread` (D6, including the timeout; B5's own trim
   budget = the same 80k figure as B4, applied at the judge's call
   site - same constraint set). The alias
   `FOLLOWUP_JUDGE_MODEL = DECISION_MODEL` lands in
   `_shared/agent-models.ts`. ALSO fix-forward: B4's judge call in
   `intent_employment.ts` AND B2's verdict call in
   `second_thoughts.ts` gain the same `AbortSignal.timeout` (the
   hang case is pre-existing in both: B4's starves the remaining
   drain; B2's stalls the completed-turn waitUntil tail).
3. **Tests.** New `followup-judge.test.ts`: the body builder (model
   alias, state fences, one noul per follow-up, the question
   verbatim in the instructions); coercion (happy path;
   missing/malformed dropped per id; clamp); the prompt builder's
   byte-stability (body + failure == today's prompt; body + verdicts
   places the block BEFORE the single-word line); the skip predicate
   (empty slice / no open follow-ups). `reflection.test.ts`: the
   toolbox/prompt pins stand unchanged (they pin the composed
   const). `intent_employment.test.ts`: the budget pin + serializer
   tests follow the move. ASCII import spelling per the siblings.
4. **Docs.** `docs/dev/followups.md`: the Resolution bullet gains
   the judge pre-pass (advisory, fail-open, no new writer); the
   reflection.ts bullet in Files gains it; a Gotcha line: the judge
   adds one bounded call + a log line per cycle (rounds, not prompt
   bytes, are the wall-clock mechanism); the chat-closer description
   at `:43-44` trued up (the chat tool already closes on volunteered
   outcomes, `followups.schema.ts:55-56`).
   `docs/qa/use-cases/followup-capture.md`: the reflection-close arm
   gains the judge step (and the executed row after the live run).
   `docs/dev/plans/venice-decisions-plan.md`: flip the B5 entry to
   implemented + pointer here. B4's plan doc's hoist note
   (`intent-employment-decisions-plan.md:152-154`) gains a pointer
   to the shared module's actual home (it named
   `_shared/venice/decisions.ts` - the deviation is D3's, reasoned).
5. **Gate, self-review, QA, land.** `mise run check` (exit code
   un-piped), the codified pre-merge self-review (slop-grep over
   added lines; straggler scan; adversarial read of own comments),
   live QA below (NOTE: fresh fixture threads are unclaimable past
   the day gate - backdate `updated_at`/`created_at` to yesterday
   via SQL, per the followup-capture doc's own Results log), land on
   main, CI watch through deploy.

## RISKS

- **False closes** (closing a loop the transcript does not resolve -
  the worse failure direction: a false close permanently records a
  known outcome that is unknown). Mitigations: the advisory framing +
  the verify requirement in the injection; the close op's own
  open-rows-only guard; the agent's conservative-close instruction
  stays; the D6 reconciliation log makes close-vs-p mismatches
  visible per row; QA's arms watch both directions. Accepted
  residual: the agent's judgment, not the judge's, remains the close
  authority.
- **Induced verification ROUNDS, not prompt bytes, are the
  wall-clock vector.** The repo's own measurement (c172d948) ruled
  out prompt size as the binding constraint; the injection may
  induce extra list/close rounds. QA arms carry a tool-call-count
  check (with vs without the block). The prompt-trim lever stays
  where followups.md points it.
- **Rollback is cheap and pre-authorized**: the design is additive
  and fail-open; if the logged p values show no signal after
  calibration, dropping the judge (and the split-consts builder
  folds back) restores today's behavior with no migration.
- **The serializer move touches B4's landed code** - a signature
  change (parameterized caps), covered by B4's suite with the budget
  pin retained; the straggler scan pins no leftover copies; the dev
  cron shim never ticks the employment sweep (invisibility risk) -
  the live-QA arm for B5 doubles as a B4 smoke check only if
  manually POSTed; accepted.
- **Stale reads are benign**: a row closed/dismissed/expired between
  the judge read and the agent's close turns the close into a
  "not found" tool error - one wasted round, no corruption; the
  re-claimed-thread case self-heals.
- **Beta wire drift** surfaces as a judge failure -> fail-open ->
  today's behavior. Same exposure as B1/B2/B4.

## VERIFICATION

- Unit: the rewritten/extended Deno suites (`mise run check`).
- **Live QA (shared-stack protocol, fixtures prefixed `ZZQA-B5`):**
  stack serves functions only from `~/dev/nak` (the branch dance).
  Three arms, per `docs/qa/use-cases/followup-capture.md`'s
  reflection levers (reset the reflection stamp, POST the
  reflection-sweep route; the route dispatches ASYNC - poll the DB
  after, never in the same chain):
  1. **Resolution arm**: an open follow-up + a settled thread whose
     transcript contains the outcome. Assert: the judge call logged
     (noul + usage), the `<followup_judge>` block visible at trace
     level, the row closed `answered` with a NON-EMPTY resolution
     line the agent wrote.
  2. **Missed-close arm** (fail-soft check): an open follow-up whose
     outcome is NOT in the transcript. Assert: the row stays open;
     the judge's low p is logged.
  3. **Fail-open arm**: a thread with NO open follow-ups. Assert: no
     judge call logged; reflection completes byte-identically (the
     builder's byte-stability unit test covers the shape; the arm
     proves the skip predicate live).
  Plus in arms 1-2: the tool-call-count sanity check (`result.toolCalls`
  is already logged by the finish line) and the reconciliation log
  line. The executed rows land in the QA doc's Results log.
