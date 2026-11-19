# Priming Pivot Gate Plan (B1)

Status: IMPLEMENTED + live-QA'd 2026-11-19 (branch priming-pivot-gate,
base a9ce4ae1; two fresh-context review rounds folded). Not yet
landed to main. QA matrix: cold turn refreshes ('cold'); same-topic
turn past the round fuse is VETOED (no refresh, payload untouched,
'pivot gate: trigger recomputed' in the logs); a real topic pivot
FIRES ('pivot', both pipelines, modal label "topic shifted", the
fresh perception re-aimed at the new subject); a gate timeout fails
open silently to the deterministic verdict (observed once - the
reason the consumption line logs at info).

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
  The round-fuse-only attribution needs no new scheduling logic:
  the evaluator returns bare `'stale'` for either fuse
  (`priming-triggers.ts:102-104`), and the wall-clock half is
  already answerable by the exported injection guard -
  `isPayloadFreshForInjection` (`priming-triggers.ts:118-123`).
  Veto eligibility = verdict `'stale'` AND the cache is still
  wall-clock fresh. The scheduling decision stays in one file.
- **D2 - The gate runs inside the samskara race's ceiling.**
  `SAMSKARA_PRIMING_TIMEOUT_MS` (`priming.ts:68`) is a CEILING, not
  occupied work - the fire's common case lands well under it
  (`:64-67`). The gate starts at the same point (inputs are all
  ready right after the cache read, `:640-641`) and races the SAME
  ceiling: `PRIME_GATE_TIMEOUT_MS` (1500, same value, separate
  constant cross-referencing the samskara one). At the trigger
  evaluation (`:700-705`) the gate verdict is awaited with the
  remaining window; on timeout or any failure the gate fails open
  (D3), and the fetch rides the orchestrator's abort signal
  (`veniceDecision` takes one) so a cancelled turn cancels the
  gate. The bound this buys: the gate can NEVER push the pre-round
  stage past the ceiling today's samskara race already allows.
  The common case on gate-eligible turns can still ADD up to the
  gate's own latency (~360ms) whenever the fire resolves first -
  the worst case is unchanged, the median is not free.
- **D2b - The gate has a skip predicate, per pipeline.** One
  decision call answers both pipelines' verdicts (they can
  legitimately differ - `priming.ts:693-695` - and one answer may
  fire one pipeline while the other's verdict vetoes). The gate
  runs ONLY when some enabled pipeline's verdict is consumable:
  skip when both pipelines are feature-disabled (no refresh can
  happen - the gate is pointless; in practice the client always
  sends both switches on non-skip turns, `Chat.svelte:4803/:4829`),
  on `'cold'` (the refresh is unconditional and there is no cached
  payload to digest), on `'mood'` (unconditional, D1), and on
  wall-clock-stale `'stale'` (veto not allowed there, D1). It
  runs exactly when an enabled pipeline's verdict is null-with-a-
  live-cache (fire opportunity) or round-fuse `'stale'` (veto
  opportunity) - and NEVER through the same-round debounce: a null
  verdict can also mean "already primed this round"
  (`priming-triggers.ts:88`), and firing through it would break
  the evaluator's own contract (`:86-87`); eligibility requires
  `cache.computed_at_round < round` explicitly.
- **D3 - Fail-open to the deterministic verdict.** Any gate failure
  (transport, non-OK, malformed answer, beta drift, the deadline)
  falls back to `evaluatePreRoundTrigger`'s own result. Rationale:
  the existing posture treats a stale-but-recent prime as better
  than none - the splice's age note + the injection guard
  (`priming.ts:779-784`, `priming-triggers.ts:118-123`) - and
  cache-read failure already degrades to forced refresh
  (`priming.ts:859-862`); the gate must never silently
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
- **M2 - Trigger integration.** For the gate to know its
  eligibility (D2b) BEFORE spending the call, the pure trigger
  evaluation hoists ABOVE the samskara race - it is pure, so
  evaluating early is behavior-identical, and hoisted, both
  verdicts are known at fire-start. `priming.ts` then starts the
  gate + the samskara fire together when the skip predicate
  passes, and the composition consumes the verdict inside the
  gate deadline; timeout/failure = the deterministic verdict
  stands. Composition, PER PIPELINE (a `'mood'` verdict is never
  relabeled into a fire): enabled pipeline's verdict null with a
  live cache and not debounced + probability >= threshold ->
  fire `'pivot'` for that pipeline; verdict `'stale'` + veto
  eligibility (D1) + probability < threshold -> skip that
  pipeline's refresh. Both pipelines' verdicts consume the same
  one gate answer (`priming.ts:693-695`).
- **M3 - `'pivot'` cross-runtime.** The union + coercers in BOTH
  runtimes - they are duplicated declarations, not shared imports
  (`intuition-payload.ts:11-12`), so nothing forces lockstep
  except tests: Deno side `priming/intuition-payload.ts:100-108` +
  `context-recall-payload.ts:139-147` (note: recall payloads are
  `v: 2`); browser side `src/lib/intuition/types.ts:79` (union) +
  `:207-215` (coercer) + `src/lib/context-recall/types.ts` (the
  type field `:97` AND the recall coercer's OWN literal trigger
  check `:182-190` - a plain if-chain with no exhaustiveness
  assert, so a missed edit compiles clean and silently drops
  `'pivot'` recall payloads on the realtime echo path
  (`stream-transport.ts:547`, `Chat.svelte:3280/:5082`,
  `Recall.svelte:74`)). Plus the two exhaustive UI switches with
  the new label - `src/lib/ui/intuition.ts:13-24`
  (`formatIntuitionTrigger`, label: "topic shifted") and
  `src/lib/ui/recall.ts:64-77` (`formatRecallTrigger`, same
  label) - rendered by the Intuition/Recall modals
  (`Intuition.svelte:193`, `RecallEntry.svelte:176`). The
  compiler forces the union switches; the recall if-chain and the
  label copy are decided here.
- **M4 - Tests.** Gate module unit tests (M1 shapes + verdicts +
  fail-open incl. the deadline + the debounce-skip); trigger
  composition tests (pivot fires, veto holds, cold/mood/wall-clock
  never vetoed, both-disabled skip); the coercer tests: Deno side
  extends `tests/priming-payloads.test.ts:8-9`; browser side:
  recall coercer coverage EXISTS - extend
  `tests/context-recall-types.test.ts`; the intuition browser
  coercer has NO vitest coverage today - its `'pivot'` acceptance
  test is net-new, and together they are the tripwire that catches
  a missed twin edit.
- **M5 - Docs.** `docs/dev/architecture.md` priming description,
  `docs/dev/intuition.md` + `docs/dev/context-recall.md`
  Interactions AND their literal payload-shape snippets carrying
  the trigger union (`intuition.md:212`, `context-recall.md:345`),
  `venice-decisions-plan.md` B1 pointer to this plan.
- **M6 - Live QA.** Local stack + a real pivoting conversation:
  pivot turn fires `'pivot'` (log line), same-topic turns ride the
  cache past round 8 without a refresh, wall-clock fuse still
  fires at 1h, gate failure (blocked key) falls back to the
  deterministic verdict. Latency: time-to-first-token with the
  gate vs without, sampled. The stack serving quirk applies:
  functions serve only from /Users/jeff.ober/dev/nak. If the QA
  session's model is Venice-hosted, screenshots follow the 64px
  minimum rule (viewport shots, never thin element clips).

## RISKS

- **clef-api beta drift** lands as upstream 400s; D3's fail-open
  makes the gate transparently absent - the deterministic behavior
  is the floor it degrades to.
- **False-negative pivots** (gate says "informs" on a real pivot):
  bounded by the unchanged fuses - the worst case is today's
  behavior. False-positives (extra refreshes): cost bounded by the
  threshold and the 1500ms ceiling (D2).
- **The veto's blast radius**: vetoing the round fuse extends cache
  ride time; the think-block age note + the unchanged 1h suppression
  bound the harm. This is the riskiest decision (D1b) - the
  refinement round should argue it specifically.
- **The gate deadline under partial outage**: a hung clef call is
  cut at `PRIME_GATE_TIMEOUT_MS` and the deterministic verdict
  stands - the TTFT budget is never the gate's hostage (D2).
- **Deploy-order skew**: an old coercer on either side rejecting
  `'pivot'` self-heals - server-side the payload regenerates as
  `'cold'` (one extra refresh); browser-side the echo is dropped
  until assets refresh (transient, cosmetic).

## VERIFICATION

- `mise run check` per commit, exit code read directly.
- Live QA per M6 against the local stack; the stack serving quirk
  (functions only serve from /Users/jeff.ober/dev/nak) applies -
  QA from that checkout.
- No `docs/user/` change: the gate is invisible scheduling; priming
  outcomes surface exactly as today.
