# Context recall

A topic-boundary recall pipeline that runs alongside intuition: at
the start of a thread, after a title shift, after a mood shift, or
after a long stretch without a refresh, the chat-loop fans out to
the existing memory-recall and conversation-recall agents in
parallel, stitches their first-person notes into one short
paragraph, and injects the result as a synthetic `<think>` assistant
turn that the conscious response sees as its own prior thought.

The motivation is the same as opening-recall ([./memory.md](./memory.md))
generalised to every topic boundary, plus a calibration drive that
broadens what each child agent considers worth surfacing - not just
"facts not already in-thread" but also "what the user already knows
about this topic, when that would change how the main model pitches
the answer." That second drive folds into the child prompts; the
context-recall pipeline is the orchestrator.

## Role in the app

Same shape of contract as intuition. The pipeline does NOT respond
to the user; it produces priming the conscious agent reads as its
own recollection. Two pipelines (intuition and context-recall) ride
the SAME trigger evaluator and write to SIBLING jsonb columns on
`threads`; their failure modes and refresh costs are independent.

Per turn, the chat-loop reads `threads.context_recall_payload` and
treats it like the intuition cache: reuse if current, refresh if a
trigger fires, and rebuild the synthetic `<think>` block from the
cache at request time.

When both pipelines fire on the same trigger evaluation (e.g.
cold-start on a fresh thread; mid-turn title shift after the model
renamed the thread), they run in parallel via `Promise.all`. Wall-
clock cost is `max(intuition, context_recall) + persist`, not
additive. The two child agents (memory-recall and conversation-
recall) inside `runContextRecallPipeline` likewise run in parallel.

## Triggers

Context recall reuses `evaluatePreRoundTrigger` and
`evaluateTitleTrigger` from `src/lib/intuition/triggers.ts` - the
same evaluator that schedules an intuition refresh schedules a
context-recall refresh. The evaluator's `cache` parameter is
declared as a structural `RoundCacheSnapshot` shape so both
`IntuitionPayload` and `ContextRecallPayload` flow through without
a cast at the call site.

All four trigger reasons fire context recall:

- **`cold`** - thread has no payload yet. Fires unconditionally so
  the feature lands on every thread by the first response.
- **`title`** - the model called `update_title` mid-turn. Topic
  shift is the strongest signal we have.
- **`mood`** - the user's valence band or confidence column changed
  since the last write. Mood is part of the predictive world model
  the samskara substrate maintains; treating it as a topic-adjacent
  signal keeps recall priming in step with the conscious agent's
  affective context.
- **`stale`** - `STALE_FUSE_ROUNDS` (8 user-rounds) have passed
  without a refresh. Catches slow-drifting topics that never tripped
  the title or mood paths.

The same-round debounce primitive (`computed_at_round`) is shared:
two triggers landing in the same round collapse to one run, so a
turn that already refreshed via the pre-round trigger won't refresh
again via the title trigger.

## Files

- `src/lib/context-recall/types.ts` - `ContextRecallPayload`,
  `coerceContextRecallPayload`, `pickFresherContextRecallPayload`.
  Schema-versioned (`v: 1`); a drift / unknown-version row reads as
  null and triggers a fresh refresh. An empty `note` is a VALID
  cached state representing "both children returned the empty
  signal this round" - cached so the same-round debounce holds.
- `src/lib/context-recall/pipeline.ts` -
  `runContextRecallPipeline`. Fans out `RecallAgent` and
  `ConversationRecallAgent` in parallel via `Promise.all`,
  stitches their notes via `stitchRecallNotes`, returns a
  cache-ready payload. Both children already collapse their own
  errors to `{kind: 'none'}`, so a child failure surfaces as the
  empty signal we stitch over.
- `src/lib/context-recall/cache.ts` - `readContextRecallCache` /
  `writeContextRecallCache` plus `withContextRecallInflight`, a
  tab-local registry that collapses two near-simultaneous triggers
  onto one Promise. Distinct from the intuition inflight registry -
  the two pipelines run independently.
- `src/lib/context-recall/ephemeral.ts` -
  `buildContextRecallThinkMessage`, the wire-shape projection from
  cached payload to ephemeral assistant message
  (`<think>{CONTEXT_RECALL_THINK_MARKER}\n{note}\n</think>`).
  Returns `null` for an empty-note payload so the caller can skip
  the injection rather than push an empty `<think>` block.
- `src/lib/context-recall/index.ts` - public re-exports. Chat-loop
  and Chat.svelte import only from here.

## Stitching

`stitchRecallNotes` is a pure function with four cases:

| memory | conversation | output |
|---|---|---|
| `none` | `none` | empty string (cached negative result) |
| `note` | `none` | memory note verbatim |
| `none` | `note` | conversation note verbatim |
| `note` | `note` | `${memory} From earlier conversations, ${conversation}` |

The hinge phrase is short on purpose: the memory child anchors on
standing facts ("I remember the user prefers X") and the
conversation child anchors on prior threads ("Last time this came
up, we landed on Y"). Without a hinge the concatenation reads as
one undifferentiated recollection; with the hinge, the model can
tell which kind of context each clause is.

An LLM-based assimilator could replace the stitch when real outputs
overlap or contradict in ways the heuristic can't resolve. We
deliberately don't pay for that round-trip until the case shows up;
the stitch handles the four happy paths cleanly.

## Calibration drive on the children

Both child prompts (`src/lib/agents/recall/prompt.ts` and
`src/lib/agents/conversation_recall/prompt.ts`) carry a two-channel
contract:

1. **FACTS / DETAILS** the main model needs but doesn't already
   have in-thread. The bar is HIGH - parroting in-thread context is
   worse than emitting the empty signal.
2. **CALIBRATION** about what the user already knows about the
   topic. The bar is "would it change how the main model frames
   the answer?" - depth, expertise, prior iterations on the same
   material. Calibration is NOT preference-bending; we are not
   tailoring facts to user taste, we are telling the main model
   "the user is past the intro on X, skip the basics."

When both channels have signal, the child blends them in one
paragraph - one short sentence on each channel - in the same
first-person voice. When neither channel has signal, the child
emits the empty signal.

The two-bar split exists to keep the conservatism on FACTS intact
while opening a calibrated lane for context that would otherwise
get discounted as off-topic. Folding both into one prompt with one
"be conservative" framing would either degrade the facts path or
suppress calibration entirely.

## Data model

One jsonb column on `threads`:

```sql
alter table public.threads
  add column if not exists context_recall_payload jsonb;
```

Shape (see `ContextRecallPayload` in
`src/lib/context-recall/types.ts`):

```ts
{
  v: 1,
  note: string,                                       // empty string when both children returned the empty signal
  computed_at_round: number,
  computed_at_band: number | null,
  computed_at_column: 'confident' | 'tentative' | null,
  computed_at_at: number,
  trigger: 'title' | 'mood' | 'stale' | 'cold',
}
```

Same `pickFresher` discipline as intuition for the realtime echo
race - see `pickFresherContextRecallPayload`.

## Contracts

- **Cache is source of truth.** The ephemeral assistant message on
  the in-memory history is reconstructed from the cache at request
  time. Same posture as intuition.
- **Empty note is a real state, not a missing one.** A coercion
  that collapsed empty-note to null would defeat the same-round
  debounce - the trigger evaluator would re-fire on every
  subsequent trigger evaluation in the same turn. Tests pin this.
- **Round id is monotonic-per-thread.** Same as intuition. A
  regenerate-from-here flow that rolls user messages back is
  currently unhandled.
- **Two parallel pipelines, one trigger evaluator, one debounce.**
  The trigger logic is shared; the caches are not. Each pipeline
  has its own `inflight` registry, its own jsonb column, its own
  handler callback. A future surface that wants to ride the same
  trigger machinery (a third "subconscious priming" pipeline) just
  reads `RoundCacheSnapshot` and writes its own column.

## Interactions

- **Chat ([./chat.md](./chat.md))** - the chat-loop is the only
  caller of `runContextRecallPipeline`. Both trigger sites (pre-
  round and mid-turn title) handle context-recall and intuition in
  the same `Promise.all` fan-out. The `contextRecallEnabled`
  boolean on `ChatLoopOptions` is how the caller wires the feature
  on; older callers / tests that don't pass it run the chat loop
  without context recall (the cache is left untouched).
- **Intuition ([./intuition.md](./intuition.md))** - shares the
  trigger evaluator. Independent caches, independent failure modes,
  but always co-fired via `Promise.all` to keep wall-clock cost
  bounded by the slower of the two.
- **Memory ([./memory.md](./memory.md))** - the pipeline reuses
  `RecallAgent` from `src/lib/agents/recall/agent.ts` as one of its
  two children. The agent's prompt was broadened with the
  calibration channel; behaviour for explicit
  `memory_recall` tool calls (the LLM-callable surface) is
  unchanged - the broadening lives in the prompt, which both paths
  share.
- **Conversation recall ([./conversation-recall.md](./conversation-recall.md))** -
  same story for `ConversationRecallAgent`.
- **Tools ([./tools.md](./tools.md))** - the `memory_recall` and
  `conversation_recall` tools are still available to the LLM as
  escape hatches. The system prompt's recall cadence block was
  softened: topic-boundary recall is now described as "handled
  for you automatically" and the tools as "explicit lookup"
  surfaces, so the model only reaches for them when the user
  asks for a specific thread / memory by name.
- **Logging ([./logging.md](./logging.md))** - uses
  `createLogger('context-recall')`. Pipeline start and complete
  log lines mirror the intuition pipeline's, with `memoryKind` and
  `conversationKind` ('note' / 'none') so a debug eye can see
  which side carried signal on a given run.

## Gotchas

- **Empty-note injection short-circuits.** When the children both
  return the empty signal, the pipeline writes a payload with
  `note: ''` (cached negative result), but
  `buildContextRecallThinkMessage` returns `null` so the chat-loop
  doesn't push an empty `<think>` block. Tests pin this - empty
  injection would burn tokens for no information.
- **The two pipelines have independent inflight registries.** A
  context-recall refresh in flight does NOT block an intuition
  refresh on the same thread (or vice versa). Two near-
  simultaneous triggers on context-recall alone DO collapse via the
  context-recall registry.
- **The trigger evaluator's `cache` parameter is structural.**
  Both `IntuitionPayload` and `ContextRecallPayload` satisfy
  `RoundCacheSnapshot`. If you add a third subconscious-priming
  cache, give it the same `computed_at_round` /
  `computed_at_band` / `computed_at_column` fields and it'll flow
  through the same evaluator without a cast.
- **The mid-turn title trigger replaces both blocks.** Same
  rationale as intuition: a stale `<think>` block computed against
  the pre-rename perception fights the fresh one for influence.
  Each surface owns its own slot index
  (`intuitionMessageIdx`, `contextRecallMessageIdx`); the refresh
  splices into the same index, or appends if the slot was empty
  before.
- **Calibration is NOT preference-bending.** The child prompts
  spell this out: surface what the user already knows when it
  would change how the main model pitches the answer; do NOT list
  interests for their own sake. Treating "the user likes X" as a
  reason to weight X in the answer is the sycophancy trap.
