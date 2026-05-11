# Context recall

A topic-boundary recall pipeline that runs alongside intuition: at
the start of a thread, after a title shift, after a mood shift, or
after a long stretch without a refresh, the chat-loop fans out to
four recall agents in parallel (memory, conversation, wiki,
journal), stitches their first-person notes into one short
paragraph, and injects the result as a synthetic `<think>` assistant
turn that the conscious response sees as its own prior thought.

The same fan-out plus stitch is also exposed to the main model as
the umbrella `context` tool - the preferred first step when the
model wants broad persistent context about the user across every
layer. One round-trip in place of four sequential per-layer recall
calls. The per-layer recall tools (`memory_recall`,
`conversation_recall`, `wiki_recall`, `journal_recall`) and the
underlying search tools stay available as targeted drill-downs.

The motivation is the same as opening-recall ([./memory.md](./memory.md))
generalised to every topic boundary, plus a calibration drive that
broadens what each child agent considers worth surfacing - not just
"facts not already in-thread" but also "what the user already knows
about this topic, when that would change how the main model pitches
the answer." That second drive folds into the child prompts; the
context-recall pipeline is the orchestrator.

## The four layers

Each layer answers a different question and lives in a different
table; nothing substitutes for any of the others.

| Layer | Table | What it carries | Right surface when |
|---|---|---|---|
| Memory | `memories` | Atomic facts and preferences ("Maya is the user's sister", "the user prefers tabs") | The model needs standing facts that don't change turn to turn |
| Conversation | `threads` (titles + summaries) | What was worked through in prior threads ("we landed on async/await for the parser pipeline") | The model wants to pick up an arc the user has iterated on before |
| Wiki | `wiki_articles` | Encyclopedic prose ABOUT topics in the user's life (projects, people, places) | The model wants the synthesised "what is X in the user's life" view that spans many conversations |
| Journal | `journal_entries` | Dated reflective summaries plus user-written entries with mood / topics / people facets | The user is reflective, revisiting an emotional thread, processing again |

Memory carries the densest signal per row but the narrowest view;
the wiki carries the longest-form synthesis but only on topics the
user has invested in; conversation carries the topical arcs they
were worked out in; the journal carries the temporal / emotional
arc through time. The umbrella `context` tool collapses the four
into one tool result; the auto-injected `<think>` block does the
same on every topic boundary without the model having to ask.

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
additive. The four child agents (memory-recall, conversation-recall,
wiki-recall, journal-recall) inside `runContextRecallPipeline`
likewise run in parallel via `runRecallFanOut`.

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
  cached state representing "every child returned the empty signal
  this round" - cached so the same-round debounce holds.
- `src/lib/context-recall/pipeline.ts` -
  `runContextRecallPipeline` (the cached / triggered entry point)
  and `runRecallFanOut` (the parallel-agent helper it delegates to,
  also reused by the umbrella `context` tool in
  `src/lib/tools/context.ts`). Fans out `RecallAgent`,
  `ConversationRecallAgent`, `WikiRecallAgent`, and
  `JournalRecallAgent` in parallel via `Promise.all`, stitches their
  notes via `stitchRecallNotes`, returns a cache-ready payload.
  Every child already collapses its own errors to `{kind: 'none'}`,
  so a child failure surfaces as the empty signal we stitch over.
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

`stitchRecallNotes` is a pure function over the four-layer fan-out
result. Three rules cover the cross-product:

- **All four notes empty** -> empty string (cached negative result).
- **Exactly one non-empty note** -> that note verbatim, no hinge.
  The note's own first-person voice carries the framing on its own.
- **Two or more non-empty notes** -> walked in layer order (memory,
  conversation, wiki, journal). The first non-empty is emitted
  verbatim (the anchor); each subsequent non-empty gets its layer
  hinge prepended:

  | Layer | Hinge |
  |---|---|
  | memory | (none; anchor) |
  | conversation | `From earlier conversations,` |
  | wiki | `From the wiki,` |
  | journal | `From the journal,` |

  The hinges are short on purpose: memory anchors on standing facts
  ("I remember the user prefers X"), conversation on prior threads
  ("last time this came up, we landed on Y"), wiki on the
  encyclopedic articles ("we have a detailed entry on Z"), and
  journal on dated reflective entries ("the user worked through W
  in April"). Without distinct hinges the four notes read as one
  undifferentiated recollection; with them, the consuming model can
  tell which kind of context each clause carries.

The walk order is fixed: memory leads when present because it is
the densest layer of standing facts; the rest follow with their
hinges. If memory is empty and conversation is the first non-empty,
conversation goes verbatim (no hinge) and the remaining layers
follow with theirs - the unprefixed slot is always the first
non-empty in layer order.

An LLM-based assimilator could replace the stitch when real outputs
overlap or contradict in ways the heuristic can't resolve. We
deliberately don't pay for that round-trip until the case shows up;
the stitch handles the happy paths cleanly.

## Calibration drive on the children

All four child prompts (`src/lib/agents/recall/prompt.ts`,
`src/lib/agents/conversation_recall/prompt.ts`,
`src/lib/agents/wiki_recall/prompt.ts`, and
`src/lib/agents/journal_recall/prompt.ts`) carry a two-channel
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
  note: string,                                       // empty string when every child returned the empty signal
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

## The `context` umbrella tool

`src/lib/tools/context.ts` is the main-chat surface for an on-demand
fan-out across the same four agents. The chat-loop's reflexive
pipeline handles topic-boundary recall automatically; the umbrella
tool is the explicit path for "I need broad context on the user
right now, regardless of whether a topic boundary fired."

Implementation is thin: `contextTool.execute` calls `runRecallFanOut`
with the optional `topic` argument forwarded, then runs the same
`stitchRecallNotes` the pipeline uses. Return shape mirrors the
per-layer recall tools so the main model handles all five
uniformly:

- `{kind: 'note', note: '<stitched paragraph>'}` when at least one
  layer carried signal.
- `{kind: 'none', reason: '<layer1: ...; layer2: ...; ...>'}` when
  every layer returned the empty signal. The synthesised reason
  concatenates each per-layer reason so a "context keeps emitting
  empty" diagnostic can see which surfaces are silent and why.

No caching at the tool layer: the umbrella runs the four agents
fresh on every call. If the model wants the cached projection it
already has it - it's auto-injected as the `<think>` block at
topic boundaries. The umbrella tool exists for the case where the
model wants fresh recall with a sharper topic hint than the
pipeline's "infer from the live conversation" default.

The system prompt nudges the model to "consider calling `context`
first" when it needs broad persistent context - moderate framing,
not strong. Cheap conversational turns skip recall entirely. The
per-layer recall tools and the search tools stay available as
drill-downs after the umbrella, or as first-line picks when the
model already knows which layer it wants.

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
  four children. The agent's prompt was broadened with the
  calibration channel; behaviour for explicit `memory_recall` tool
  calls (the LLM-callable surface) is unchanged - the broadening
  lives in the prompt, which both paths share.
- **Conversation recall ([./conversation-recall.md](./conversation-recall.md))** -
  same story for `ConversationRecallAgent`.
- **Wiki ([./wiki.md](./wiki.md))** - the pipeline (and the
  umbrella `context` tool) reach `WikiRecallAgent`, which uses a
  read-only `wiki_search` toolbox. The autonomous wiki agent and
  wiki-librarian keep article mutation owned by background work;
  recall is reader-only.
- **Journal ([./journal.md](./journal.md))** - same shape:
  `JournalRecallAgent` uses a read-only `journal_search` toolbox.
  The background journaling worker stays in charge of writing /
  regenerating entries.
- **Tools ([./tools.md](./tools.md))** - the four per-layer recall
  tools (`memory_recall`, `conversation_recall`, `wiki_recall`,
  `journal_recall`) and the umbrella `context` tool are all
  registered in the always-on toolbox. The system prompt's recall
  cadence block was rewritten: topic-boundary recall is described
  as "handled for you automatically", the umbrella `context` tool
  is framed as the preferred first step for broad lookups, and the
  per-layer recall + search tools are framed as drill-downs.
- **Logging ([./logging.md](./logging.md))** - uses
  `createLogger('context-recall')`. Pipeline start and complete
  log lines mirror the intuition pipeline's, with `memoryKind`,
  `conversationKind`, `wikiKind`, and `journalKind` ('note' /
  'none') so a debug eye can see which sides carried signal on a
  given run. The umbrella tool logs under
  `createLogger('context-tool')` with the same four kinds plus
  total elapsed time.

## Gotchas

- **Empty-note injection short-circuits.** When every child
  returns the empty signal, the pipeline writes a payload with
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
