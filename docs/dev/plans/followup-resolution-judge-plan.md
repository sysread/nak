# Follow-up Resolution Judge via Decision Model (B5)

Status: PLAN (refinement in progress - not yet built).

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
cheap (~400ms + ~1.4k tokens, measured on B4's identical shape against
a ~9-minute reflection run - noise). The p values are logged, giving
the first calibration data on how often outcomes actually land in
transcripts.

This is B5 of the decision-model brainstorm
(`venice-decisions-plan.md:146-148`). Scope is FOLLOW-UPS only; the
brainstorm's "intent resolution" half needs no new check (the
employment judge already feeds the minter's pruning).

## BACKGROUND

The follow-up design (docs/dev/followups.md, read this session)
constrains the shape hard:

- **Reflection is the ONLY background agent with follow-up tools**
  (Gotchas, first bullet). A dedicated follow-up agent was considered
  and REJECTED: "two background resolvers means double-close races
  and prompt sprawl for zero coverage gain" - and "mint-vs-resolve
  is one portfolio judgment over one context." A standalone decision
  sweep that closes follow-ups would be exactly that rejected second
  writer. The judge must compose into reflection, not bypass it.
- **The close op's resolution is required prose**
  (`venice/tools/followups.ts` via the wire schema's
  `minLength: 1`, `reflection.ts:237-242`; cap
  `MAX_FOLLOWUP_RESOLUTION_CHARS = 500`, `_shared/followups.ts:19`).
  The resolution is the loop's audit stamp, NOT a persistence channel
  (followups.md:130, 170-173) - a canned "resolved per conversation"
  line defeats the stamp's purpose. Only the agent can close.
- **Reflection runtime is the cost to watch** (followups.md Gotchas):
  measured ~9-minute runs motivated the attempt cap; "trim the
  follow-up prompt section - do not split out a second agent." The
  pre-pass must stay bounded and must not grow the agent's round
  count.
- **Dismissal is the user's veto** - reflection never carries
  dismiss (the wire enum omits it, `reflection.ts:186-188`). The
  judge sees none of that surface; it answers one question per open
  row.
- **The reflection cycle today** (`reflection.ts:387-464`): claim
  (`claim_next_thread_for_reflection_sweep`, TTL 600s, hourly cron
  drain, day-gated) -> `loadThreadSliceUpTo` (the terminal slice with
  fork framing, `_agent_tools.ts:250-289` - SAME `StoredMessage[]`
  shape the B4 judge serializes) -> one `runHeadlessAgent` run
  (REFLECTION_MODEL, reasoningEffort low, 8-tool toolbox) over the
  slice with REFLECTION_PROMPT as the final "switch modes" user turn
  (`:406-410`) -> mark reflected under the claim.

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

B4's plan hoist note ("a fourth decision consumer lands -> hoist a
shared body builder") triggers with B5: two consumers now serialize
the SAME `StoredMessage[]` transcript for the SAME judgment shape
(whole settled thread, typed per-item questions). The serializer and
the answers-coercion helpers are currently module-private in
`intent_employment.ts`.

## DECISIONS (proposed - refinement may amend)

- **D1 - Model: `clef-api` via `DECISION_MODEL`** (the B4 tier
  constant, `agent-models.ts`): the state carries the user's own
  words (parent plan D1). No new constant needed.
- **D2 - The judge composes; reflection keeps all authority.** The
  verdicts are ADVISORY EVIDENCE in the prompt. The agent still calls
  op=list, still verifies against the transcript, still decides, and
  still writes the resolution line. The judge cannot close, cannot
  suppress creation, and cannot dismiss. This is B1's composition
  doctrine applied to reflection, and it keeps followups.md's
  single-background-writer design intact (no second resolver exists
  after this change either).
- **D3 - The shared decision-state module (the hoist).** Extract from
  `intent_employment.ts` into `_shared/venice/decision-state.ts`:
  the transcript serializer (`serializeTranscript` + the clip/render
  helpers), the budget constants (`*_BUDGET_CHARS`, row/tool/arg
  caps, parameterized so each caller passes its budget), and the
  answers coercers (`noulOf` / `choiceOf` + the answers-map shape).
  B4's module imports from the new home (mechanical move, same
  behavior, its tests follow). Rationale: the caps are BUDGET-driven
  (the 32k-token state cap) not judgment-driven, which is the point
  where the "renderers deliberately not shared" convention
  (`_shared/thread-transcript.ts:71-75`) stops applying - two
  consumers, identical purpose, identical numbers. Question builders
  and per-question coercion stay per-consumer (the question shapes
  differ).
- **D4 - Judge scope: all open follow-ups, capped.** Read directly
  (`select id, question, context from followups where user_id = ?
  and status = 'open'`, capped at 12, oldest first) - NOT the due-side
  selection (`selectDueFollowups`), because an outcome can land in a
  transcript BEFORE its relevant_after date; the reconcile section's
  contract is over the whole open set. The cap is the same
  degenerate-portfolio guard B4 uses; excess logged and skipped.
  Skipped rows are unaffected (the agent's own list-based reconcile
  still covers them - the judge is additive evidence, never the only
  path).
- **D5 - Injection shape: a `<followup_judge>` block appended to the
  final user turn.** `REFLECTION_PROMPT` stays the message; the block
  appends after it (one user turn - the "switch modes" idiom
  keeps its shape). Per judged follow-up: id, the question, the
  verdict ("likely resolved here (p=0.87)" / "not resolved here"),
  and the advisory framing: verify against the transcript before
  closing, and a close needs your own one-line resolution; a
  not-resolved verdict changes nothing. Fail-open: no open
  follow-ups, judge failure, transport error, or unusable coercion =
  no block - the prompt is byte-identical to today's.
- **D6 - Fire discipline: pre-pass, bounded, log-only.** Runs inside
  the reflection cycle after the slice loads and only when BOTH: the
  slice is non-empty AND the user has >= 1 open follow-up. One
  batched call (state counted once), single attempt, no timeout race
  (a cron tail; ~400ms against a multi-minute run). The p values and
  the decision response's `usage` are logged (debug), never
  persisted - no schema, no rows, no new readers. The skip predicate
  is deterministic and testable.
- **D7 - The prompt's reconcile section stays the authority.** The
  section's instructions do not weaken: op=list first, the
  answered/dismissed dedup guard, conservative closing. The
  injection's wording must not read as a command ("close the flagged
  ones") - it is evidence about WHERE an outcome may sit, aimed at
  fixing misses, with the verification burden on the agent.

## PLAN

1. **Extract `_shared/venice/decision-state.ts`** (D3): move
   `serializeTranscript` + helpers + coercers out of
   `intent_employment.ts` with parameterized budgets; update
   `intent_employment.ts` imports and its test's import path; the
   barrel does NOT re-export it (it is a state-shaping utility, not
   a Venice relay - imported by path like `_recall_helpers.ts`).
2. **Add the judge to `reflection.ts`**: the follow-ups read (D4),
   the body builder (per-follow-up noul with the question + context
   in the instructions; state = `{ transcript, followups }`), the
   coercion (per-id verdicts, fail-open), the injection block
   builder (D5), and the wiring in `reflectClaimedThread` (D6).
   `buildReflectionToolbox` and the tool wire schemas are untouched.
3. **Tests.** `reflection.test.ts`: the toolbox/prompt pins stand;
   the prompt pin gains the no-judge-block byte-stability check.
   New `followup-judge.test.ts`: the body builder (model, state
   fences, one noul per follow-up, the question verbatim in the
   instructions); coercion (happy path; missing/malformed dropped
   per id; clamp); the injection block (renders verdicts + advisory
   framing; absent on failure); the skip predicate (empty slice /
   no open follow-ups / no key). ASCII import spelling per the
   sibling suites.
4. **Docs.** `docs/dev/followups.md`: the Resolution section gains
   the judge pre-pass (advisory, fail-open, no new writer); the
   reflection.ts bullet in Files gains it; a Gotcha line: the judge
   adds ~400ms + ~1.4k tokens per cycle, budget-driven caps shared
   with B4 via `decision-state.ts`. `docs/qa/use-cases/followup-capture.md`:
   the reflection-close arm gains the judge step (and the executed
   row after the live run). `docs/dev/plans/venice-decisions-plan.md`:
   flip the B5 entry to implemented + pointer here.
5. **Gate, self-review, QA, land.** `mise run check` (exit code
   un-piped), the codified pre-merge self-review (slop-grep over
   added lines; straggler scan; adversarial read of own comments),
   live QA below, land on main, CI watch through deploy.

## RISKS

- **The judge could bias the agent into false closes** (closing a
  loop the transcript does not actually resolve - the worse failure
  direction: a false close permanently records a known outcome that
  is unknown). Mitigations: the advisory framing + the verify
  requirement in the injection; the close op's own open-rows-only
  guard; the agent's conservative-close instruction stays; QA's
  missed-close arm watches the opposite direction and the
  live-QA watch watches the mix. Accepted residual: the agent's
  judgment, not the judge's, remains the close authority.
- **Prompt growth on an agent near the wall clock** (followups.md
  Gotcha). The block is bounded (12 follow-ups x ~1 line) and the
  call adds ~400ms; the skip predicate keeps no-op cycles free.
  If reflection still dies at the wall, the trim lever stays where
  the doc says it is (the prompt section, not this module).
- **The serializer move touches B4's landed code.** Mechanical
  (imports + a parameter), covered by B4's own suite re-pointed at
  the new home; the straggler scan pins no leftover copies.
- **Beta wire drift** surfaces as a judge failure -> fail-open ->
  today's behavior. Same exposure as B1/B2/B4.

## VERIFICATION

- Unit: the rewritten/extended Deno suites (`mise run check`).
- **Live QA (shared-stack protocol, fixtures prefixed `ZZQA-B5`):**
  stack serves functions only from `~/dev/nak` (the branch dance).
  Three arms, per `docs/qa/use-cases/followup-capture.md`'s
  reflection levers (reset the reflection stamp, POST the
  reflection-sweep route):
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
     prompt pin covers the shape).
  The executed rows land in the QA doc's Results log.
