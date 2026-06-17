# Context recall

A topic-boundary recall pipeline that runs alongside intuition: at
the start of a thread, after a title shift, after a mood shift, or
after a long stretch without a refresh, the chat-loop searches the
three persistent layers (memories, prior conversations, wiki),
assembles a works-cited index, and injects it as a synthetic
`<think>` assistant turn that the conscious response sees as its own
prior recollection.

The index is deterministic - raw search, no LLM. Matching memory
facts are inlined verbatim; related conversations and wiki articles
come in as a `title (id: ...)` list that the model opens on demand
with `conversation_get` / `wiki_get`. The same gather is exposed to
the main model as the umbrella `context` tool, which returns the
index structured rather than rendered.

## Why deterministic, not synthesized

An earlier design fanned out three headless recall sub-agents
(`RecallAgent`, `ConversationRecallAgent`, `WikiRecallAgent`) that
each read the thread, ran their own searches, and synthesized a
first-person note, which the pipeline stitched together. Two
problems drove the rewrite:

- **Hallucination.** The synthesis step paraphrased - and sometimes
  invented - facts the stores never held. Injecting that as the
  model's own recollection is the worst place for a confabulation.
- **Latency / cost.** Three headless tool-loops fired on every topic
  boundary, on the live turn's critical path.

Inlining memory facts verbatim removes the hallucination surface
(verbatim text cannot drift) and the per-layer searches replace three
model round-trips with three vector queries. Conversations and wiki
articles are large, so they ride as references rather than inline
content: the model pays the drill-down cost (`conversation_get` /
`wiki_get`) only when a lead looks worth pulling, instead of paying a
synthesis cost on every boundary.

The size-appropriate split is the design rule: small payloads
(memory facts) inline; large payloads (transcripts, article bodies)
by id.

## The three layers

Each layer answers a different question and lives in a different
table; nothing substitutes for any of the others.

| Layer | Table | What it carries | In the index |
|---|---|---|---|
| Memory | `memories` | Atomic facts and preferences ("Maya is the user's sister", "the user prefers tabs") | inline, verbatim (with a confidence tag on low-confidence rows) |
| Conversation | `threads` (titles + summaries) | What was worked through in prior threads | `title (id)` reference -> `conversation_get` |
| Wiki | `wiki_articles` | Encyclopedic prose ABOUT topics in the user's life (projects, people, places) | `title (id)` reference -> `wiki_get` |

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

When both pipelines fire on the same trigger evaluation they run in
parallel via `Promise.all`. Wall-clock cost is `max(intuition,
context_recall) + persist`, not additive. Inside the context-recall
pipeline the three layer searches likewise run in parallel via
`Promise.all` (see `gatherContextIndex`).

## Triggers

Context recall reuses `evaluatePreRoundTrigger` from
`src/lib/intuition/triggers.ts` - the same evaluator that schedules
an intuition refresh schedules a context-recall refresh. The
evaluator's `cache` parameter is declared as a structural
`RoundCacheSnapshot` shape so both `IntuitionPayload` and
`ContextRecallPayload` flow through without a cast at the call
site. The evaluation itself runs inside
`maybeRunContextRecallPipeline` (pipeline.ts) - the chat-loop's
entry point, which owns the feature gate, the trigger decision, and
the per-thread inflight dedup; the chat-loop supplies inputs and
sequencing only.

Three trigger reasons fire context recall (the `'title'` member of
the trigger union is legacy-only - see intuition.md for the history
of the dead mid-turn title trigger):

- **`cold`** - thread has no payload yet. Fires unconditionally so
  the feature lands on every thread by the first response.
- **`mood`** - the user's valence band or confidence column changed
  since the last write.
- **`stale`** - either staleness fuse tripped: `STALE_FUSE_ROUNDS`
  (8 user-rounds) without a refresh, OR `STALE_FUSE_MS` (1 hour)
  wall-clock since the cached payload was written. The wall-clock arm
  catches a conversation resumed after a pause, where the round
  counter barely advanced. See intuition.md for the full rationale -
  the evaluator is shared, so the fuse behaves identically here.

The same-round debounce primitive (`computed_at_round`) is shared:
two triggers landing in the same round collapse to one run. The
chat-loop also applies an **injection guard** to the context-recall
`<think>` push: a payload older than `STALE_FUSE_MS` is suppressed
rather than spliced onto the wire, the backstop for when a refresh
errored, deduped, or the feature was off this turn (again shared with
intuition - see intuition.md).

## Query derivation

The pipeline has no explicit topic, so `gatherContextIndex` derives
the search query from the live thread via `deriveRecallQuery`: the
last user turn plus the assistant response immediately before it. The
prior assistant turn carries the context the user's latest message is
responding to, which sharpens retrieval on short follow-ups ("what
about the second option?") that would embed to noise on their own.
The query is anchored on the last USER turn, so any in-flight
assistant / tool tail the chat-loop persisted on its way into recall
is ignored. The query is capped at a character budget (keeping the
tail, where the user's message sits) so an unbounded assistant turn
doesn't blow the embedding model's window.

The umbrella `context` tool substitutes the caller's explicit `topic`
for the derived query; everything downstream is identical.

## Files

- `src/lib/context-recall/types.ts` - `ContextRecallPayload`,
  `coerceContextRecallPayload`, `pickFresherContextRecallPayload`.
  Schema-versioned (`v: 1`); a drift / unknown-version row reads as
  null and triggers a fresh refresh. An empty `note` is a VALID
  cached state representing "nothing matched this round" - cached so
  the same-round debounce holds.
- `src/lib/context-recall/gather.ts` - the deterministic retrieval +
  render core, shared by the pipeline and the `context` tool.
  `deriveRecallQuery` (query from messages), `gatherContextIndex`
  (the three parallel searches -> `ContextIndex`), `renderContextThink`
  (index -> the `<think>` body). Per-layer caps live here
  (`CONTEXT_MEMORY_LIMIT`, `CONTEXT_CONVERSATION_LIMIT`,
  `CONTEXT_WIKI_LIMIT`). Each layer degrades independently: a search
  that throws or returns nothing contributes an empty list.
- `src/lib/context-recall/pipeline.ts` -
  `runContextRecallPipeline`, the cached / triggered entry point. Runs
  `gatherContextIndex`, renders the note via `renderContextThink`,
  returns a cache-ready payload (with `note: ''` when every layer was
  empty).
- `src/lib/context-recall/cache.ts` - `readContextRecallCache` /
  `writeContextRecallCache` plus `withContextRecallInflight`, a
  tab-local registry that collapses two near-simultaneous triggers
  onto one Promise. Distinct from the intuition inflight registry.
- `src/lib/context-recall/ephemeral.ts` -
  `buildContextRecallThinkMessage`, the wire-shape projection from
  cached payload to ephemeral assistant message
  (`<think>{CONTEXT_RECALL_THINK_MARKER}\n{note}\n</think>`).
  Returns `null` for an empty-note payload so the caller can skip
  the injection rather than push an empty `<think>` block.
- `src/lib/context-recall/index.ts` - public re-exports. Chat-loop
  and Chat.svelte import only from here.

## The injected `<think>` body

`renderContextThink` assembles up to three sections, omitting any
empty layer (an all-empty index renders to the empty string):

- **Memories** - "I recall some related things about this topic:"
  followed by each fact verbatim as a bullet. A `hedged` / `shaky`
  confidence tag is appended inline so the model can hedge or verify
  rather than asserting; `corroborated` / untagged rows read as plain
  facts.
- **Conversations** - a line naming `conversation_get` plus a
  `- title (id: ...)` bullet per related thread.
- **Wiki** - a line naming `wiki_get` plus a `- title (id: ...)`
  bullet per related article.

The voice is first-person recollection plus an explicit offer to look
the referenced items up - the framing that makes the ids read as
actionable leads, not as content the model has already read.

## The two recall tiers

The deterministic gather is the **cheap survey tier**. The per-layer
recall tools (`memory_recall`, `conversation_recall`, `wiki_recall`)
remain LLM sub-agents - the **targeted drill-down tier**:

- `memory_recall` / `conversation_recall` / `wiki_recall` each fire a
  headless sub-agent (`RecallAgent`, `ConversationRecallAgent`,
  `WikiRecallAgent`) that reads the thread, runs its own search
  rounds, and returns a synthesized first-person note. These carry
  the two-channel calibration contract described below.
- The pipeline and the `context` tool do NOT use those agents. They
  use `gatherContextIndex` instead.

This divergence is deliberate: the automatic, every-boundary path is
cheap and verbatim; the model reaches for an agent only when it wants
one layer distilled rather than indexed. Don't "fix" the
inconsistency by routing the pipeline back through the agents - that
reintroduces the synthesis hallucination and the per-boundary cost
the rewrite removed.

### Calibration drive on the recall agents

The three recall-agent prompts (`src/lib/agents/recall/prompt.ts`,
`src/lib/agents/conversation_recall/prompt.ts`, and
`src/lib/agents/wiki_recall/prompt.ts`) carry a two-channel contract
(FACTS/DETAILS plus CALIBRATION about what the user already knows).
That contract governs the `*_recall` TOOLS, not the deterministic
pipeline - the index has no calibration channel (titles + counts are
its only proxy for depth). Calibration is NOT preference-bending:
surface what the user already knows when it would change how the main
model pitches the answer; do not list interests for their own sake.

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
  note: string,                                       // empty string when every layer was empty
  computed_at_round: number,
  computed_at_band: number | null,
  computed_at_column: 'confident' | 'tentative' | null,
  computed_at_at: number,
  trigger: 'title' | 'mood' | 'stale' | 'cold',
}
```

The `note` is the already-rendered `<think>` body, not the structured
index - the cache stores the cheap-to-replay string. Same
`pickFresher` discipline as intuition for the realtime echo race -
see `pickFresherContextRecallPayload`.

## Contracts

- **Cache is source of truth.** The ephemeral assistant message on
  the in-memory history is reconstructed from the cache at request
  time. Same posture as intuition.
- **Empty note is a real state, not a missing one.** A coercion
  that collapsed empty-note to null would defeat the same-round
  debounce. Tests pin this.
- **Round id is monotonic-per-thread.** Same as intuition. A
  regenerate-from-here flow that rolls user messages back is
  currently unhandled.
- **Two parallel pipelines, one trigger evaluator, one debounce.**
  The trigger logic is shared; the caches are not.

## The `context` umbrella tool

`src/lib/tools/context.ts` is the main-chat surface for an on-demand
gather. The chat-loop's reflexive pipeline handles topic-boundary
recall automatically; the umbrella tool is the explicit path for "I
need broad context on the user right now, regardless of whether a
topic boundary fired."

Implementation is thin: `contextTool.execute` calls
`gatherContextIndex` with the optional `topic` forwarded as the query,
and returns the `ContextIndex` structured (no `<think>` wrapper - a
tool result is not a synthetic turn):

```ts
{
  memories: [{ id, label, data, confidence_tag }],   // verbatim
  conversations: [{ id, title }],                     // -> conversation_get
  wiki: [{ id, title }],                              // -> wiki_get
}
```

Empty arrays mean nothing matched that layer. No caching at the tool
layer: the umbrella runs the searches fresh on every call.

The system prompt nudges the model to "consider calling `context`
first" when it needs broad persistent context - moderate framing, not
strong. Cheap conversational turns skip recall entirely.

## conversation_get

`src/lib/tools/conversation_get.ts` is the conversation-layer
counterpart to `wiki_get`: a primary-key fetch of one prior thread by
id, returning `{found, conversation: {id, title, summary, updated_at,
archived, truncated, messages}}`. It is what makes the conversation
ids in the index (and in `context` / `conversation_search` results)
actionable.

Unlike a wiki article (bounded by `MAX_WIKI_CONTENT_CHARS`), a thread
transcript is unbounded, so the transcript is windowed to the most
recent messages within a character budget; `truncated: true` flags
when older turns were dropped, and the always-present `summary`
covers the part that didn't fit. Only user and assistant turns with
real text survive - tool-call rows and empty assistant rows carry no
readable content. Registered in the always-on toolbox.

## Interactions

- **Chat ([./chat.md](./chat.md))** - the chat-loop is the only
  caller of `runContextRecallPipeline`. Both trigger sites (pre-round
  and mid-turn title) handle context-recall and intuition in the same
  `Promise.all` fan-out. The `contextRecallEnabled` boolean on
  `ChatLoopOptions` is how the caller wires the feature on.
- **Intuition ([./intuition.md](./intuition.md))** - shares the
  trigger evaluator. Independent caches, always co-fired via
  `Promise.all` to keep wall-clock cost bounded by the slower of the
  two.
- **Memory ([./memory.md](./memory.md))** - the pipeline reads the
  memory layer via `searchMemoriesSemantic` and inlines hits verbatim
  with `classifyMemoryConfidence` tags. The `memory_recall` TOOL still
  wraps `RecallAgent` for the distilled read.
- **Conversation recall ([./conversation-recall.md](./conversation-recall.md))** -
  the pipeline reads the conversation layer via `searchThreads`
  (current thread excluded) and the model drills in with
  `conversation_get`. The `conversation_recall` TOOL still wraps
  `ConversationRecallAgent`.
- **Wiki ([./wiki.md](./wiki.md))** - the pipeline reads the wiki
  layer via `searchWikiArticlesSemantic` (sole-source-from-this-thread
  articles excluded, same hygiene as `wiki_search` in recall mode) and
  the model drills in with `wiki_get`. The `wiki_recall` TOOL still
  wraps `WikiRecallAgent`.
- **Tools ([./tools.md](./tools.md))** - the umbrella `context`, the
  three per-layer `*_recall` tools, the `*_search` tools, and the new
  `conversation_get` are all in the always-on toolbox. The system
  prompt's recall block frames the auto-injection as an INDEX (leads,
  not content) and points the model at `conversation_get` / `wiki_get`
  for drill-down.
- **Logging ([./logging.md](./logging.md))** - uses
  `createLogger('context-recall')`; the pipeline's complete log line
  carries per-layer hit counts (`memoryCount`, `conversationCount`,
  `wikiCount`) so a debug eye can see which layers carried signal. The
  umbrella tool logs under `createLogger('context-tool')`.

## Gotchas

- **Empty-note injection short-circuits.** When every layer is empty
  the pipeline writes a payload with `note: ''` (cached negative
  result), but `buildContextRecallThinkMessage` returns `null` so the
  chat-loop doesn't push an empty `<think>` block. Tests pin this.
- **The two pipelines have independent inflight registries.** A
  context-recall refresh in flight does NOT block an intuition
  refresh on the same thread (or vice versa).
- **Priming is built once per turn, pre-round.** There is no
  mid-turn replacement of the `<think>` blocks - the old mid-turn
  title trigger that re-spliced them died when tool dispatch moved
  server-side (see intuition.md). Both blocks are assembled once at
  the start of the turn from the post-refresh cache, and the
  injection guard (above) drops either if its payload is older than
  `STALE_FUSE_MS`.
- **Conversation/wiki ids are leads, not content.** The system
  prompt spells out that the model must `conversation_get` / `wiki_get`
  before relying on a referenced thread or article - otherwise it
  confabulates contents from the title alone.
- **The survey tier and drill-down tier diverge on purpose.** The
  pipeline / `context` tool are deterministic; the `*_recall` tools
  are LLM agents. See "The two recall tiers" above.
