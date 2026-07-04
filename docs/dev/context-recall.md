# Context recall

A topic-boundary recall pipeline that runs alongside intuition: at
the start of a thread, after a title shift, after a mood shift, or
after a long stretch without a refresh, the priming stage searches the
three persistent layers (memories, prior conversations, wiki),
compresses the hits into a first-person recollection with `^N^`
citations, and injects it as a synthetic `<think>` assistant turn that
the conscious response sees as its own prior recollection.

> **Where it runs:** the pipeline runs server-side, as part of the
> priming stage of `getStreamingResponse`
> (`supabase/functions/venice/priming/context-recall.ts`, orchestrated
> by `runServerPriming` in `priming.ts`), reusing the function-side
> memory/wiki search cores; it survives a browser disconnect mid-turn.
> The three vector-search RPCs already accept `p_user_id`, which the
> service-role client passes explicitly. The browser keeps the payload
> type + coercer (`src/lib/context-recall/types.ts`) and the Recall
> modal, rendering off the `priming_start/end` + `context_recall_payload`
> events the function publishes (see
> [`prompt-augmentation.md`](./prompt-augmentation.md) -> Observability).

Retrieval is deterministic - raw vector search, no LLM - so the source
facts can't drift at the point of retrieval. The memory, conversation,
and wiki hits are gathered with their ids; the smoothing pass weaves
them into the recollection and cites each by id (`^N^`), and the model
opens any lead on demand with `memory_get` / `conversation_get` /
`wiki_get`. The same gather is exposed to the main model as the
umbrella `context` tool, which returns the index structured rather than
rendered.

## Why deterministic retrieval, cited synthesis

An earlier design fanned out three headless recall sub-agents
(`RecallAgent`, `ConversationRecallAgent`, `WikiRecallAgent`) that each
read the thread, ran their OWN searches, and synthesized a first-person
note. That synthesis hallucinated - it paraphrased, and sometimes
invented, facts the stores never held - and fired three tool-loops on
every boundary, on the live turn's critical path.

The pipeline keeps that lesson but splits the two concerns:

- **Retrieval is deterministic.** The three layer searches are raw
  vector queries (no LLM), so the source facts can't drift at the point
  of retrieval, and the cost is three vector queries rather than three
  agent loops.
- **The render is one cited synthesis.** A single smoothing pass
  (`context-recall-smoothing.ts`) compresses the gathered index into the
  injected recollection - past-anchored, relevance-bridged - and cites
  every claim by id (`^N^`). Because retrieval already produced
  known-good rows that survive in the store and via `*_get` drill-down,
  a synthesis drift is recoverable rather than an unfalsifiable
  confabulation: the citation points back at the real row. That is the
  line separating this from the reverted design - synthesis OVER a
  verified retrieval, every claim traceable, not synthesis AS retrieval.

Conversations and wiki articles are large, so they ride as id
references the model opens on demand (`conversation_get` / `wiki_get`);
memories are small but also cited by id (`memory_get`), so a recalled
specific can be checked against the verbatim row before the main model
asserts it.

## Keeping the store clean

Read-time smoothing launders encoding-time poison (a memory body that
says "this conversation" / "(June 2026, this session)") by anchoring on
the row's real `created_at` and ignoring write-time framing. That
laundering only sanitises the INJECTED note, though - the raw row stays
reachable through the always-on drill-down tools (`memory_search` /
`memory_get`), so a model that opens a poisoned row directly can still
surface its encoding-time framing in the reply. That is why the two
background reshape paths below matter: they clean the row at the source
rather than papering over it at every read. Two background paths reduce
that laundering burden over time so the stored rows get cleaner at the
source:

- **The reflection writer** (`agents/reflection.ts`) is instructed to
  write memories TIMELESS - no "this session", no write-date narration,
  no first-person AI self-logging - so new rows arrive clean.
- **The memory librarians** (rem + deep-sleep) carry `memory_reshape`, a
  framing-only rewrite (no fact or confidence change), and reshape any
  poisoned row they visit on their cadence. See
  [`memory.md`](./memory.md).

## The three layers

Each layer answers a different question and lives in a different
table; nothing substitutes for any of the others.

| Layer | Table | What it carries | In the index |
|---|---|---|---|
| Memory | `memories` | Atomic facts and preferences ("Maya is the user's sister", "the user prefers tabs") | gathered with id, body, real `created_at`, and confidence tag; woven into the recollection and cited by id (`memory_get` to verify) |
| Conversation | `threads` (titles + summaries) | What was worked through in prior threads | `title (id)` reference -> `conversation_get` |
| Wiki | `wiki_articles` | Encyclopedic prose ABOUT topics in the user's life (projects, people, places) | `title (id)` reference -> `wiki_get` |

A fourth arm rides the same gather: **follow-ups** (`followups` -
the assistant's own pending questions, surfaced semantically AND
date-due, rendered uncited under an explicit outcome-unknown
register). It is documented in [`followups.md`](./followups.md)
rather than here - the arm reuses this pipeline's triggers, cache,
and failure contract, and adds two behaviors of its own (the
proactive due pull with its anti-nag ledger, and the "due
follow-ups force a non-empty note" exception to the empty-gather
short-circuit).

## Role in the app

Same shape of contract as intuition. The pipeline does NOT respond
to the user; it produces priming the conscious agent reads as its
own recollection. Two pipelines (intuition and context-recall) ride
the SAME trigger evaluator and write to SIBLING jsonb columns on
`threads`; their failure modes and refresh costs are independent.

Per turn, the priming stage reads `threads.context_recall_payload` and
treats it like the intuition cache: reuse if current, refresh if a
trigger fires, and rebuild the synthetic `<think>` block from the
cache at request time.

When both pipelines fire on the same trigger evaluation they run in
parallel via `Promise.all`. Wall-clock cost is `max(intuition,
context_recall) + persist`, not additive. Inside the context-recall
pipeline the three layer searches likewise run in parallel via
`Promise.allSettled` (see `gatherContextIndex` in
`supabase/functions/venice/priming/context-recall.ts`).

## Triggers

Context recall reuses `evaluatePreRoundTrigger` from
`supabase/functions/_shared/priming-triggers.ts` - the same evaluator
that schedules an intuition refresh schedules a context-recall
refresh. The evaluator's `cache` parameter is declared as a structural
`RoundCacheSnapshot` shape so both `IntuitionPayload` and
`ContextRecallPayload` flow through without a cast at the call
site. The evaluation runs inside `runServerPriming`
(`venice/priming.ts`), which owns the feature gate, the trigger
decision, and per-thread sequencing; `runContextRecallPipeline`
(`venice/priming/context-recall.ts`) is just the gather + stitch body
it calls when a trigger fires.

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
priming stage also applies an **injection guard** to the context-recall
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
assistant / tool tail in the history handed to the priming stage is
ignored. The query is capped at a character budget (keeping the
tail, where the user's message sits) so an unbounded assistant turn
doesn't blow the embedding model's window.

The umbrella `context` tool substitutes the caller's explicit `topic`
for the derived query; everything downstream is identical.

## Files

- `supabase/functions/venice/priming/context-recall-payload.ts` - the
  server-side `ContextRecallPayload` shape, `coerceContextRecallPayload`,
  and `buildContextRecallThinkMessage` + `CONTEXT_RECALL_THINK_MARKER`.
  The wire-shape projection returns `null` for an empty-note payload so
  the caller can skip the injection rather than push an empty `<think>`
  block. The payload type + coercer shape are shared with the surviving
  browser `src/lib/context-recall/types.ts` (below); both runtimes coerce
  the same persisted shape. Schema-versioned (`v: 2` - `note` plus a
  `citations[]` array; a drift / unknown / older-version row reads as
  null and triggers a fresh refresh). An empty `note` is a VALID cached
  state representing "nothing relevant surfaced this round" - cached so
  the same-round debounce holds.
- `src/lib/context-recall/types.ts` - the surviving browser copy of
  `ContextRecallPayload`, `ContextRecallCitation`,
  `coerceContextRecallPayload`, `pickFresherContextRecallPayload`. Read
  by the realtime-echo decoder and the Recall diagnostics modal.
- `supabase/functions/venice/priming/context-recall.ts` - the
  deterministic retrieval core. `deriveRecallQuery` (query from
  messages), `gatherContextIndex` (the three parallel searches ->
  `ContextIndex`, memories now carrying `id` + `created_at`), and
  `runContextRecallPipeline`, the triggered entry point the orchestrator
  calls (gather, then hand off to the smoothing pass, returning a
  cache-ready payload with `note: ''` when nothing surfaced). Per-layer
  caps live here (`CONTEXT_MEMORY_LIMIT`, `CONTEXT_CONVERSATION_LIMIT`,
  `CONTEXT_WIKI_LIMIT`). Each layer degrades independently via
  `Promise.allSettled`. The umbrella `context` tool's own gather lives
  separately in `venice/agents/context.ts`.
- `supabase/functions/venice/priming/context-recall-smoothing.ts` - the
  recall-time smoothing pass (replaces the old string-concat render).
  `smoothContextRecall` runs one `deepseek-v4-flash` completion over the
  gathered index + current exchange and returns `{ note, citations }`;
  the source-numbering / source-block-render / citation-projection /
  `^N^`-extraction helpers are pure and unit-tested via the `__test`
  export.

## The injected `<think>` body

The body is produced by the smoothing pass
(`context-recall-smoothing.ts`), not assembled by string concat. One
`deepseek-v4-flash` completion (reasoning disabled, like `web_search`)
reads the gathered index plus the current exchange and emits a short
first-person recollection that:

- **Anchors in the past** on each memory's real `created_at`, and
  launders any encoding-time "this conversation" / "(June 2026)"
  framing baked into the memory body (re-anchoring on the real date) so
  the model can't read a recalled fact as a current-chat event.
- **Bridges to the current turn** - every recalled thing states how it
  connects to what the user just said, which keeps the model answering
  the message rather than the recollection.
- **Preserves specifics** (numbers, names, decisions, metrics, dates)
  accurately without quoting, hedges inference, and flags `hedged` /
  `shaky` memories as low-confidence.
- **Cites by id** - `^N^` superscripts keyed to the payload's
  `citations[]`, which the model drills into with `memory_get` /
  `conversation_get` / `wiki_get` and which the Recall modal renders as
  clickable source links.

An all-empty gather (or a smoothing pass that judges nothing relevant)
yields an empty note, which the caller caches as the negative result
and does not inject.

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

This divergence is deliberate. The automatic, every-boundary path
gathers deterministically and runs ONE cited smoothing pass over all
three layers at once; the per-layer agents each run their own searches
and distil a single layer in isolation - heavier (three loops) and,
because the synthesis IS the retrieval there, with no citation back to a
verified row. The model reaches for an agent only when it wants one
layer deeply distilled. Don't "fix" the apparent inconsistency by
routing the pipeline through those agents: that trades the shared
deterministic gather and the traceable synthesis-over-verified-retrieval
for the cost and the unfalsifiable confabulation the rewrite removed.

### Calibration drive on the recall agents

The three recall-agent prompts
(`supabase/functions/venice/agents/memory_recall.ts`,
`supabase/functions/venice/agents/conversation_recall.ts`, and
`supabase/functions/venice/agents/wiki_recall.ts`) carry a two-channel contract
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
  v: 2,
  note: string,                                       // smoothed recollection with ^N^ markers; '' when nothing surfaced
  citations: ContextRecallCitation[],                 // { index, kind: 'memory'|'conversation'|'wiki', id, label }
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

`src/lib/tools/context.schema.ts` is the main-chat surface for an on-demand
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

`src/lib/tools/conversation_get.schema.ts` is the conversation-layer
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

- **Chat ([./chat.md](./chat.md))** - `runServerPriming` is the only
  caller of `runContextRecallPipeline`, fanning context-recall and
  intuition out in one `Promise.all` at the single pre-round trigger
  site. The `contextRecallEnabled` boolean rides from the browser in
  `streamCtx.priming` to wire the feature on.
- **Intuition ([./intuition.md](./intuition.md))** - shares the
  trigger evaluator. Independent caches, always co-fired via
  `Promise.all` to keep wall-clock cost bounded by the slower of the
  two.
- **Memory ([./memory.md](./memory.md))** - the pipeline reads the
  memory layer via `searchMemoriesSemantic` (carrying `id` +
  `created_at` + `classifyMemoryConfidence` tags into the smoothing
  pass). The smoothing pass cites memories by id; the model drills in
  with the new `memory_get` tool. The `memory_recall` TOOL still wraps
  `RecallAgent` for the distilled read.
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
- **Follow-ups ([./followups.md](./followups.md))** - the fourth
  gather arm (`gatherFollowups`) and the follow-up rules in the
  smoothing prompt. The `context` umbrella tool returns the open set
  as a fourth array. Follow-up surfacing is gated by this feature's
  toggle - disabling context recall disables the proactive asks too.
- **Tools ([./tools.md](./tools.md))** - the umbrella `context`, the
  three per-layer `*_recall` tools, the `*_search` tools, and the
  `memory_get` / `conversation_get` / `wiki_get` drill-down trio are all
  in the always-on toolbox. The smoothing pass cites sources by id and
  the model drills into any of the three with the matching `*_get`.
- **Recall modal / citations UI** - the Recall diagnostics modal
  (`src/screens/Recall.svelte` + the per-entry
  `src/components/RecallEntry.svelte`) renders each injected note and its
  `citations[]` as a `CitationsPanel` slide-down; `^N^` superscripts open
  the panel and each row links to the source's in-app route
  (`?memory=` / `?cid=` / `?wiki_article_id=`). `src/lib/ui/citations.ts`
  owns the citation->display and href->nav mapping, shared with the
  web-search citations path (`AssistantBody`).
- **Logging ([./logging.md](./logging.md))** - uses
  `createLogger('context-recall')`; the pipeline's complete log line
  carries per-layer hit counts (`memoryCount`, `conversationCount`,
  `wikiCount`) so a debug eye can see which layers carried signal. The
  umbrella tool logs under `createLogger('context-tool')`.

## Gotchas

- **Empty-note injection short-circuits.** When every layer is empty
  the pipeline writes a payload with `note: ''` (cached negative
  result), but `buildContextRecallThinkMessage` returns `null` so the
  priming stage doesn't push an empty `<think>` block. Tests pin this.
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
