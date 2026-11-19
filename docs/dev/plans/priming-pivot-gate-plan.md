# Priming Pivot Gate Plan (B1)

Status: PLANNED 2026-11-19 (branch priming-pivot-gate, base a9ce4ae1
= landed venice-decisions). Research round done (priming pipeline
mapped end to end, constraints below); refinement rounds not
started. Line citations are research-verified and will be
re-verified by the refinement reviewer.

## SYNOPSIS

Add a decision-model semantic gate to the pre-round priming
trigger: one `clef-api` call per turn asks whether the user's
message pivots the topic or raises something the cached priming
payloads cannot inform. The gate can FIRE a refresh early (a new
`'pivot'` trigger reason) and VETO the deterministic round-fuse
refresh (the 8-user-round fuse) when the cached read still
informs. Cold start, mood-shift, and the wall-clock fuse are
untouched: the deterministic evaluator stays the floor and the
fallback; the gate only refines the one fuse that cannot see
semantics.

## BACKGROUND

The priming stage runs before a turn's first completion and is
fully serial with it: `getStreamingResponse.ts:591` awaits
`runServerPriming` before publishing BEGIN and starting round 0 -
time-to-first-token is the binding constraint, not the 380s wall
deadline (`getStreamingResponse.ts:150`).

Inside `runThinkChain` (`venice/priming.ts:613-809`): DB cache read
(`:640-641`), samskara fire raced at 1500ms (`:68`, `:682-690`),
then the deterministic trigger evaluation (`:700-705`) -
`evaluatePreRoundTrigger` (`_shared/priming-triggers.ts:78-107`)
is pure and free: cold start, same-round debounce, mood band or
column change (`'mood'`), 8-user-round fuse or 1-hour wall-clock
fuse (`'stale'`), else skip.

On a trigger, the refresh pipelines run fully awaited with NO
timeout (`:707-758`): intuition is 3 sequential LLM calls with the
perception stage reading the ENTIRE untrimmed transcript
(`priming/intuition.ts:140-353`); context recall adds an embed, 4
DB searches, and a smoothing call (`priming/context-recall.ts:164-263`).
The refresh fan-out is the single largest uncapped cost on the
pre-round critical path.

The gap: the fuses are blind to topic. A conversation can pivot
subject completely while the mood band holds and the round count
stays under 8 - the next turn rides a stale synthesis aimed at the
gone topic (mitigated only by the think-block age note,
`intuition-payload.ts:169-177`). Conversely, a slow conversation
pays the full fan-out every 8 rounds even when every round is the
same topic and the cache still informs perfectly.

The Decisions API (landed: `veniceDecision` in
`_shared/venice.ts`, `/decisions` route, `SupabaseService.decide`)
answers a noul question about a state in ~360ms with sublinear
batching; `clef-api` is the private-tier model the plan
`venice-decisions-plan.md` D1 pins for user content.

## DECISIONS (proposed - refinement may amend)

- **D1 - The gate refines, never replaces.** `evaluatePreRoundTrigger`
  keeps its contract and runs first. The gate's noul can (a) fire a
  refresh on a no-trigger turn (new reason `'pivot'`) and (b) veto a
  `'stale'` verdict caused by the ROUND fuse only. Cold start stays
  unconditional; the mood trigger stays unconditional; the
  wall-clock fuse stays absolute (it also governs injection
  suppression via the shared `STALE_FUSE_MS` -
  `priming-triggers.ts:34-41` - and lockstep is load-bearing).
- **D2 - The gate runs inside the samskara race window.** The gate
  inputs (user text, caches, mood) are all ready right after the
  cache read (`priming.ts:640-641`); the samskara race already
  occupies ~1500ms of concurrent work (`:682-690`). The gate call
  (measured ~360ms) runs concurrently and is consumed before the
  trigger evaluation needs it - adding ZERO serial latency when it
  fits the window, and at most its own overage when it does not.
- **D3 - Fail-open to the deterministic verdict.** Any gate failure
  (transport, non-OK, malformed answer, beta drift) falls back to
  `evaluatePreRoundTrigger`'s own result. Rationale: the existing
  posture treats a stale-but-recent prime as better than none
  (`priming.ts:727-756`) and cache-read failure already degrades to
  forced refresh (`:859-862`); the gate must never silently
  suppress refreshes when Venice is down.
- **D4 - The gate state is a digest, never the transcript.** State:
  the user message text, the cached payload digest (the perception
  line beginning `Classification: <category>` (`intuition.ts:128-131`),
  the synthesis head, the recall note head, payload ages), and the
  mood snapshot. Size: low thousands of tokens, far under clef-api's
  32k. The raw transcript is never sent (it is unbounded; perception's
  1M-window job stays perception's).
- **D5 - Model `clef-api`, private tier** (decisions-plan D1
  carries over: the user's own words are in the state).
- **D6 - `'pivot'` is a cross-runtime shape change.** The trigger
  reason rides persisted payloads and both coercers reject unknown
  values (`intuition-payload.ts:100-108`, `context-recall-payload.ts:139-147`);
  the Deno twin and browser twin both learn the new member. The
  existing `'title'` legacy member is the precedent for absorbing a
  new reason (`priming-triggers.ts:21-25`).
- **D7 - The fire threshold is a named constant, calibrated before
  landing.** The gate's noul fires at >= GATE_FIRE_THRESHOLD
  (initial 0.7, in one place next to the gate). The Decisions guide
  is explicit that probabilities vary between requests; the live-QA
  step evaluates real transcripts before the constant is trusted,
  and the constant is the only knob.
- **D8 - No new user-facing setting.** The gate refines server-side
  scheduling of an existing automatic feature; the pipelines'
  existing feature switches keep gating the refreshes themselves.

## PLAN

- **M1 - The gate module.** `venice/priming/pivot-gate.ts`: build
  the decision request (state digest + the noul question), call
  `veniceDecision` with `clef-api`, coerce the answer to
  `{ pivotProbability } | null` (null = unusable -> fail-open per
  D3). Pure, fetch-injectable, Deno-tested: request shaping, answer
  coercion, and the decide/veto verdict as pure functions.
- **M2 - Trigger integration.** `priming.ts` runs the gate
  concurrently with the samskara race window (D2); the trigger
  evaluation consumes the gate verdict: fire `'pivot'` on a
  no-trigger turn above threshold; veto a round-fuse `'stale'`
  below it. The evaluator itself stays pure - the gate composes
  AROUND it (evaluate deterministic verdict first, then gate).
- **M3 - `'pivot'` cross-runtime.** `IntuitionTrigger` union +
  both coercers + the browser twin constants; the payload `v`
  stays 1 if coercers just accept the new member (they reject
  unknown members, so this is an additive union change in both
  runtimes).
- **M4 - Tests.** Gate module unit tests (M1 shapes + verdicts +
  fail-open); trigger composition tests (pivot fires, veto holds,
  cold/mood/wall-clock never vetoed); coercer acceptance of
  `'pivot'` in both runtimes.
- **M5 - Docs.** `docs/dev/architecture.md` priming description,
  `docs/dev/intuition.md` + context-recall doc Interactions, the
  corpus scanner gotcha untouched, `venice-decisions-plan.md` B1
  pointer to this plan.
- **M6 - Live QA.** Local stack + a real pivoting conversation:
  pivot turn fires `'pivot'` (log line), same-topic turns ride the
  cache past round 8 without a refresh, wall-clock fuse still
  fires at 1h, gate failure (blocked key) falls back to the
  deterministic verdict. Latency: time-to-first-token with the
  gate vs without, sampled.

## RISKS

- **clef-api beta drift** lands as upstream 400s; D3's fail-open
  makes the gate transparently absent - the deterministic behavior
  is the floor it degrades to.
- **False-negative pivots** (gate says "informs" on a real pivot):
  bounded by the unchanged fuses - the worst case is today's
  behavior. False-positives (extra refreshes): cost bounded by the
  threshold and the 1500ms overlap window.
- **The veto's blast radius**: vetoing the round fuse extends cache
  ride time; the think-block age note + the unchanged 1h suppression
  bound the harm. This is the riskiest decision (D1b) - the
  refinement round should argue it specifically.

## VERIFICATION

- `mise run check` per commit, exit code read directly.
- Live QA per M6 against the local stack; the stack serving quirk
  (functions only serve from /Users/jeff.ober/dev/nak) applies -
  QA from that checkout.
- No `docs/user/` change: the gate is invisible scheduling; priming
  outcomes surface exactly as today.
