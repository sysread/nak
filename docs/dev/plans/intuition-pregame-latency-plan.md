# Intuition Pregame Latency Plan

Status: IMPLEMENTED + live-QA'd 2026-11-25 (branch
intuition-pregame-latency; deep-mode round 1 + quick-mode round 2
refinement, both audits PASS; D3 confirmed keep-retries by Jeff).
Live QA on the local stack (4 turns, warm thread): the 5s race,
fallback pulse, and round-guarded late persist all behaved as
specified - the checklist dismissed at the deadline on every
timed-out turn, replies were never blocked, and the thread row
carried fresh payloads after each timeout. Two observations for
prod: the intuition pipeline did not finish inside 5s locally
(12-17s elapsedMs - the timeout path was the common path there),
and on an active thread the MOOD trigger fires every turn (each
reply mints a samskara and shifts the band), so the pregame runs
nearly every turn - the mood fuse, not the pivot gate, is the
remaining "fires too often" lever if it still feels hot in prod.

## SYNOPSIS

Bound the "Predicting" step of the chat pregame. The intuition
pipeline currently runs on the pre-response critical path with no
deadline, three sequential model calls, 429 retries, and a perception
stage that prefills the entire transcript. This plan gives the
intuition and recall pipelines each a 5-second deadline (total
pregame worst case ~6.5-7s including the untouched 1.5s samskara/gate
races, down from unbounded), moves perception onto the fast dense
non-reasoning id (executing the fallback path the model-split commit
pre-authorized), adds a generic fallback intuition pulse when no real
payload is ready, and retunes three thresholds: the pivot-gate fire
level, the shared stale-rounds fuse, and the B9 smoothing judge's
rewrite bar.

## BACKGROUND

The pregame card dismisses on BEGIN, and BEGIN publishes only after
`getStreamingResponse` awaits the whole priming stage
(`getStreamingResponse.ts:623`, `:635`). Time-to-first-token pays for
everything priming does.

Inside `runThinkChain` (`venice/priming.ts:615`): the samskara fire
and the pivot gate are each raced against 1500ms and run concurrently
(`priming.ts:70`, `pivot-gate.ts:48`) - bounded and fine. The
intuition + recall pair then runs as `Promise.all` with **no timeout
at all** (`priming.ts:797-848`), and `veniceComplete` has no deadline
of its own (the `complete.ts:270` setTimeout is retry backoff).

The intuition pipeline is 3 **sequential** non-streaming Venice calls
(`priming/intuition.ts`):

1. Perception on `deepseek-v4-flash-0731-fast` (1M window) over the
   ENTIRE untrimmed transcript (`intuition.ts:186`; transcript built
   at `:107-118`).
2. Drives (one collapsed JSON call) on `mistral-small-3-2-24b-instruct`
   (`intuition.ts:208-225`).
3. Synthesis on mistral (`intuition.ts:284-302`).

All three pass `retryRateLimit: true` (`intuition.ts:93`, `:223`,
`:300`), so a 429 adds Retry-After backoff on the critical path. On a
long thread the perception prefill alone is seconds; the whole chain
easily runs 10-30s. That is the user-visible "forever". (History:
commit `31ae4063` attributes an earlier 15-30s pregame to GLM
reasoning overhead and split the models; deepseek-vs-mistral prefill
was never separately measured - see RISKS.)

Refresh frequency is governed by `evaluatePreRoundTrigger`
(`_shared/priming-triggers.ts:81`): cold, mood shift, 8-user-round
fuse (`STALE_FUSE_ROUNDS = 8`, `:35`), 1-hour wall clock, or the
pivot gate firing at noul >= 0.7 (`pivot-gate.ts:54`). Jeff reports
"Predicting" fires too often; the gate threshold and the round fuse
are the two dials.

Separately, the B9 smoothing judge fires its rewrite when the
smoothing score falls below `SMOOTHING_REWRITE_THRESHOLD = 1.5` on a
0-indexed 0-3 rubric (`_shared/clarity.ts:185`, `:197-209`). Jeff
reports it fires too often.

## DECISIONS

- **D1 - Perception moves to mistral.**
  `AGENT_MODELS.intuitionPerception`: `deepseek-v4-flash-0731-fast`
  -> `mistral-small-3-2-24b-instruct` (`src/lib/models/index.ts:617`).
  This EXECUTES the fallback path the model-split commit pre-authorized
  ("If perception regresses on deepseek, mistral-small is the
  fallback" - `31ae4063`, comment still at `models/index.ts:573-574`);
  the registry already notes 256k "covers the perception stage's
  full-transcript read for any realistic thread"
  (`models/index.ts:250-253`). Jeff approved.
  - **D1a - window safety valve.** Add a head-trim in
    `buildTranscript` (keep the tail) so a monster thread cannot 400
    on mistral's 256k window: `PERCEPTION_TRANSCRIPT_MAX_CHARS`
    keeping the last ~900k chars (~225k tokens), sliced with the
    local-constant idiom of `context-recall.ts:307-309`. Never fires
    on realistic threads; converts a hard failure into an
    old-context trim.
  - **D1b - the deepseek registry entry is deleted.** After the swap
    it has zero consumers (AGENT_MODELS was the only role pointing at
    it; `stream-guards.ts:183-189` never contained the id, and its
    `leaksSpecialTokens` flag was dead-on-arrival for this
    non-streaming path). Dead code goes; the registry comment edits
    consume the now-exercised fallback sentence. The id flows
    browser-side only (`Chat.svelte:4820` -> request body ->
    `priming.ts:639`), so no server-registry twin exists to sync.
- **D2 - No stage collapse.** The drives + synthesis merge (one call
  producing both) is REJECTED: the synthesis depends on the drives
  as separate stage outputs (Jeff's call). 3 sequential calls stay.
- **D3 - Retries: REVISED by refinement, Jeff to confirm.** Jeff's
  original call was "prevent retries", made when the pipeline was
  unbounded (a retrying call stretched the pregame). The D4 deadline
  invalidates that premise: the per-pipeline races resolve null at
  5s regardless of what the calls do, so 429 retries can no longer
  add user-visible latency - and they still help, two ways: a
  Retry-After (floored at the schedule base, capped at 5s -
  `complete.ts:332-336`) that completes inside the window still
  lands for the CURRENT turn, and the detached late-persist path
  (D4) gets durability instead of dying on the first 429. Dropping
  the flag buys nothing and creates a new failure shape: one 429
  kills the detached pipeline, so a long thread gets the fallback
  pulse now AND no fresh cache next turn - two consecutive unprimed
  turns under Venice overload.
  RECOMMENDATION: keep `retryRateLimit: true` on all three calls.
  The do-it-anyway alternative (drop the flag; accept the
  consecutive-unprimed shape) is one line if Jeff prefers it.
  Either way, the refreshed `callOnce` docstring (`:61-99` - it
  names deepseek and calls `disable_thinking` load-bearing, moot on
  the dense non-reasoning id) must say precisely what retrying
  remains: the base transient-5xx schedule `[500, 1500, 4000]`
  (`_shared/venice/complete.ts:60`) applies unconditionally;
  `retryRateLimit` only adds 429 to the retryable set
  (`complete.ts:324-327`). "No retries" would be false.
- **D4 - 5s deadline + fallback pulse.**
  - New `PRIME_PIPELINE_TIMEOUT_MS = 5000` in `venice/priming.ts`,
    raced PER-PIPELINE: each of the intuition and recall promises
    gets its own 5s deadline race (house inline-race idiom:
    resolve-null sentinel + clearTimeout handle, as the samskara
    race at `priming.ts:735-745`; NOT `AbortSignal.timeout` /
    `withTimeout` - those cancel or throw, and D4 needs the loser
    alive). Per-pipeline racing means a slow recall cannot mask an
    intuition payload that finished in time, and the stage's
    wall-clock is still bounded by the same 5s. The samskara/gate
    1.5s races are untouched, so the pregame ceiling becomes about
    1.5s + 5s + DB roundtrips (~6.5-7s worst case), down from
    unbounded. The constant is injectable for tests (a `deps`-style
    override on `ServerPrimingOpts`), so the deadline tests do not
    burn 5s of real clock.
  - On timeout the race resolves null and the underlying pipeline
    continues **detached**, persisting its payload late. The
    samskara race's floating-promise precedent survives only while
    the orchestrator is still running - the registrar's real
    beneficiary is a turn that completes NORMALLY (short response,
    no abort) while the timed-out pipeline is still retrying; on an
    aborted turn (`ctl.signal` at `getStreamingResponse.ts:631`)
    the pipeline's fetches die with it and there is nothing to
    persist. So the late persist is registered through a REAL
    `edgeWaitUntil` registrar threaded through `ServerPrimingOpts`
    (module-local at `venice/index.ts:249-263`, held by
    `handleStreamFresh` at `:1153-1167`; passing it as an opt is
    cycle-free - priming.ts cannot import index.ts). The
    pre-existing samskara floating-promise hole is noted for a
    future pass, not fixed here (scope).
  - **Late-persist write guard.** `persistThreadCache` is a blind
    `.update` (`priming.ts:964-968`), so turn N's detached pipeline
    could settle after turn N+1 already persisted a fresher payload
    and regress the cache to an older round. The late continuation
    re-reads the row's current payload and skips the write when the
    stored `computed_at_round` is >= the late payload's round.
  - **Late continuation flushes its own logger.** Drawer delivery
    requires an explicit `await flush()` (`edge-log.ts:17-24`), and
    the orchestrator's flush block (`priming.ts:502-513`) runs
    BEFORE the detached pipeline emits its late lines - so the
    registrar-registered continuation ends with its own flush, or
    the VERIFICATION pass below cannot see the late completion line.
  - Fallback pulse: when no fresh intuition payload exists to splice,
    splice a generic intuition think block instead of nothing:
    blank `drives`, `synthesis: "i need to focus on clear writing
    and what i know about the user."` (the phrasing shape the
    synthesis always produces), `perception` filled with the
    existing ambiguous-marker idiom ("Classification: ambiguous" -
    `ensureClassificationPrefix`, `intuition.ts:128-131`) so no new
    filler is invented mid-implementation. `buildIntuitionThinkMessage`
    renders only the synthesis field plus the age note
    (`intuition-payload.ts:170-179`), so the block reads as a
    normal-but-generic pulse. Field pins that keep the renderer
    honest: `computed_at_round = currentUserRound` and
    `computed_at_at = nowMs` (an older value would append the
    "formed a few exchanges ago" suffix to a this-turn pulse), and
    `trigger` set to a valid enum value (required by the type,
    `intuition-payload.ts:100-109`).
  - **Fallback condition (splice-time, both halves load-bearing).**
    The pulse is the ELSE branch of the SAME guard that injects the
    cache: `if (intuitionCache && isPayloadFreshForInjection(...))`
    (`priming.ts:892`) -> cache; `else if <fallback-eligible>` ->
    pulse. Keying "stale" on anything else double-splices: the
    pivot gate can veto a round-fuse 'stale' verdict
    (`pivot-gate.ts:175-179`), leaving an injectable cache AND a
    trigger that says stale.
  - **Fallback eligibility.** The pulse applies only when the
    intuition pipeline actually COMMITTED to running this turn -
    `intuitionModelId` present AND the composed trigger fired. With
    intuition disabled, no pulse: a generic monologue must not
    appear on a feature the user turned off.
  - The fallback pulse is THIS-TURN-ONLY: never persisted, never
    published as an `intuition_payload` event, never fed to the
    pivot gate's digest. It must never flow into the
    `freshIntuition` variable - the only two gates that matter are
    `if (freshIntuition)` at `priming.ts:854` (persist) and `:862`
    (publish), and the naive implementation that returns the
    fallback from the raced promise fails both. The splice-time
    else-branch is the required shape, and the new test asserts the
    fallback appears in zero `updates` entries and zero
    `intuition_payload` events.
  - **D4a - fallback scope: INTUITION only.** The pulse applies on
    ANY no-payload outcome for the INTUITION pipeline (genuine
    failure included, not only timeout) - keeps the think-chain
    shape stable for the model, and the line is content-free so it
    cannot steer wrong. Recall gets NO generic note: cached-if-fresh,
    else nothing (the injection guard already enforces this).
  - Tight-followup edge, documented: a next turn sent before the
    late persist lands reads the old cache and debounces (round
    advanced by 1), so the late payload injects one turn later than
    "next turn". Accepted.
  - UI: a late `priming_end` can land after BEGIN dismissed the
    card - same tolerance the samskara race already ships
    (`priming.ts:699-710`). No browser change expected; verify.
- **D5 - Trigger dials (the shared-fuse disclosure).**
  `GATE_FIRE_THRESHOLD` 0.7 -> 0.85 (`pivot-gate.ts:54`);
  `STALE_FUSE_ROUNDS` 8 -> 12 (`priming-triggers.ts:35`). Mood and
  the 1-hour wall clock stay untouched. Two honesty notes the
  refinement surfaced:
  - The gate's code comment claims the 0.7 was "calibrated against
    real transcripts", but no calibration artifact exists in the
    repo - the plan's D7 deferred calibration to a live-QA step
    that left no record. The 0.85 retune is the same kind of
    structural judgment 0.7 was - the step-5 comment refresh must
    say "initial judgment, retuned after over-firing reports", not
    claim calibration.
  - `STALE_FUSE_ROUNDS` is a SHARED dial, not an intuition dial:
    context recall evaluates the same trigger (`priming.ts:654-656`),
    and follow-ups surfacing rides the recall gather, so a due
    follow-up is only asked at refresh boundaries
    (`docs/dev/followups.md` Gotcha at `:242-245`). 8 -> 12
    stretches the follow-ups ask cadence to match. Jeff accepts
    this as part of the dial.
- **D6 - Smoothing threshold.** `SMOOTHING_REWRITE_THRESHOLD` 1.5 ->
  1.3 (`clarity.ts:185`). The outgoing 1.5 was structural judgment,
  not distribution data (the clarity.ts comment says so itself), so
  the retune is legitimate on the same grounds. On the 0-3 rubric
  this keeps genuine smoothing (score <= 1) firing while borderline
  1.4-1.5 scores stop. `REWRITE_SCORE_THRESHOLD` (clarity) stays
  1.5 - Jeff only flagged smoothing. Per Jeff's report, chip scores
  have been accumulating unanalyzed (runtime data, unverified from
  the repo); if the 1.3 guess misfires, that log is where the
  correction comes from.

## PLAN

1. `src/lib/models/index.ts`: retarget `AGENT_MODELS.intuitionPerception`
   to mistral; DELETE the `deepseek-v4-flash-0731-fast` registry
   entry (D1b); rewrite the "second exception" comment block
   (`:565-574`) - perception and stages 2-3 now share the dense id,
   the consumed fallback sentence goes; trim mistral's entry comment
   to name both slots.
2. `src/lib/chat/types.ts:293-302`: rewrite the
   `intuitionPerceptionModelId` field doc (no longer "1M-window id";
   now "dense 256k id, head-trimmed").
3. `supabase/functions/venice/priming/intuition.ts`: keep the three
   `retryRateLimit` flags per D3 (drop them only if Jeff overrides);
   rewrite the `callOnce` docstring (`:61-99`); add the D1a
   head-trim in `buildTranscript` and EXPORT it for tests; update
   the header comment (stage 1 no longer "deepseek, 1M window").
4. `supabase/functions/venice/priming.ts`: add
   `PRIME_PIPELINE_TIMEOUT_MS` + the test-injection seam on
   `ServerPrimingOpts`; add the `edgeWaitUntil` registrar opt and
   thread it to the late-persist continuations (per-continuation:
   round-guarded write, own logger flush, double-persist guard when
   the pipeline wins the race); race the intuition and recall
   promises SEPARATELY against the deadline (no combined
   `Promise.all` wait); add the fallback-pulse constant +
   splice-time `else if` branch with the eligibility gate (D4a:
   intuition only, pipeline committed); log a `priming timeout`
   line (info) so the drawer shows when the bound fired.
5. `supabase/functions/venice/priming/pivot-gate.ts`: threshold 0.85;
   comment refresh - "initial judgment, retuned after over-firing
   reports" (no calibration claim); fix the stale "every 8 rounds"
   in the header (`:9`); fix the stale "the perception pipeline owns
   the 1M-window transcript read" in the caps comment (`:57-58`).
6. `supabase/functions/_shared/priming-triggers.ts`:
   `STALE_FUSE_ROUNDS = 12`.
7. `supabase/functions/_shared/clarity.ts`:
   `SMOOTHING_REWRITE_THRESHOLD = 1.3` + comment note (structural
   retune, watch the chip log).
8. Tests:
   - `tests/models.test.ts:261-268`: update the hard-pinned
     `intuitionPerception` expectation to mistral; rewrite the
     narrating comment (no more deepseek "second exception"); the
     registry-loop test survives via the mistral entry.
   - `supabase/functions/tests/priming-orchestration.test.ts`:
     deadline race per pipeline (slow stub resolves null, late
     persist lands via the registrar with the round guard,
     injectable short timeout), fallback splice (no cache / stale
     cache), gate-veto case (vetoed-stale cache injects, NO
     double-splice), fresh-cache-wins case, disabled-intuition case
     (no fallback pulse), fallback-leak guards (zero `updates` rows,
     zero `intuition_payload` events), double-persist guard.
   - Export + test `buildTranscript` (role stripping, head-trim
     bound, tail preference) - the pipeline internals otherwise
     have no seam.
   - `pivot-gate.test.ts` + `priming-triggers.test.ts`: symbolic
     today (they import the constants), auto-adapt; add the 0.85
     boundary and round-12 cases per the constants' new values.
   - `clarity.test.ts:82-83`: update the constant-equality pin to
     1.3; add `deriveFailedChecks` boundary cases (1.3 passes,
     1.2 fails; the existing 0.8/2.9 cases survive).
9. Docs:
   - `docs/dev/intuition.md`: fix the stale pipeline shape ("five
     drive agents react in parallel" `:4-5`, "seven model calls"
     `:24`, "seven-call pipeline" ~`:114` - all predate the drive
     collapse); CREATE the model paragraph (no mistral/deepseek
     text exists today); rewrite the latency notes for the 5s
     bound + fallback pulse.
   - `docs/dev/prompt-augmentation.md` (~`:160-168`): the
     failure-degradation section owns the exact degradation contract
     D4 changes - describe the deadline + fallback pulse.
   - `docs/qa/use-cases/priming-disconnect-survival.md`: the
     timeout-race coverage this plan changes - update what it pins.
   - `docs/user/intuition.md:56`: "about eight user rounds" -> the
     new cadence (user-facing, same-PR rule).
   - `docs/qa/use-cases/intuition-pipeline.md:15`:
     `STALE_FUSE_ROUNDS` (8) -> 12.
   - `docs/dev/context-recall.md:150` + `docs/dev/followups.md:244`:
     "(8 user-rounds)" -> 12, and the followups doc gets a line
     that the ask cadence stretched with the shared fuse.
   - `docs/dev/clarity.md:46` names "1.5 each" -> split the values.
   - Historical plan docs keep their old numbers (archival).

## RISKS

- **Cold-start first turn under 5s** ships the fallback pulse
  instead of a real perception when Venice is slow; the real one
  lands (via late persist) for turn 2 - or turn 3 if the next send
  beats the persist. Accepted (Jeff's trade).
- **D1's "mistral prefills faster" is inference, not measurement** -
  the recorded 15-30s regression was blamed on GLM reasoning
  overhead, and no per-model prefill comparison exists. The 5s
  deadline is the guaranteed fix; the model swap is a likely
  improvement riding it. If perception regresses in quality,
  deepseek is the recorded fallback direction (re-add the entry).
- **Mistral 256k window** on monster threads - covered by D1a.
- **The fallback pulse trains the model?** The line is content-free
  and matches the synthesis register; no steering risk.
- **Fewer refreshes (D5)** means staler caches between fires, and
  the shared fuse stretches follow-ups ask cadence (D5's
  disclosure). The age note on the think block
  (`intuition-payload.ts:174-177`) already dates stale reads.
- **Overload shape (with D3-keep):** a 429-heavy window burns retry
  sleeps inside the detached pipelines; user-visible latency stays
  bounded by the per-pipeline races. With D3-drop instead:
  consecutive unprimed turns (see D3).
- **Smoothing 1.3** lets borderline smoothing through; the tuning
  surface stays one constant, easy to walk back with the chip log.

## VERIFICATION

- `mise run functions-test` + `functions-check` (Deno island), full
  `mise run check` for the src/lib change.
- Local stack QA: long thread, confirm the pregame card dismisses
  within ~7s worst case; Logs drawer (intuition + context-recall
  sources) shows `priming timeout` + the late `intuition pipeline
  complete elapsedMs` when the bound fires (the late continuation's
  own flush is what makes this line visible); the turn after a
  timeout injects the late payload.
- Fallback-pulse QA: simulate a slow/hung Venice for the intuition
  sub-calls on the dev stack; confirm the generic think block
  splices, nothing persists (modal shows no phantom payload), and
  the next turn primes normally.
- Smoothing: force a borderline-scored turn (the B9 bait pattern)
  and confirm no rewrite at the new threshold.
