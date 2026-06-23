# Prompt augmentation layer

Several features independently shape what the model sees on a single
chat turn. Individually each is documented with its own feature doc;
together they form a layer with no single owner - the **prompt
augmentation layer**. This doc is that layer's contract: who may inject
what, in what order, when it counts as fresh, how it degrades on
failure, and where it is observable. The code that enforces the
contract lives in `src/lib/chat-loop.ts` (`runChatLoop` -> the priming
block + `requestMessages` assembly); this doc is the spec that code
implements.

Read this before adding a new turn-time injector, changing the order of
the existing ones, or touching the freshness fuses - a regression here
is behavioral (the model answers differently), not a crash, so the
gate won't catch it.

## The wire shape of one turn

`runChatLoop` assembles a `VeniceMessage[]` in this exact order:

```text
1. system   baseline prompt  - identity, voice, tool catalog, + bias appendix
2. system   user-configured system prompts (Settings -> "you are a pirate")
3. ...       the conversation history (prior turns + the latest user message)
4. assistant <think>  context-recall note      | the priming chain, spliced
5. assistant <think>  samskara compound summary | onto the tail of the
6. assistant <think>  samskara situational fire | conversation, AFTER the
7. assistant <think>  intuition synthesis       | latest user message
8. system   per-turn metadata block (LAST on the wire)
```

Two distinct injection surfaces:

- **The baseline system prompt (row 1)** carries the slowly-changing,
  always-on context: the tool catalog and the bias-profile appendix.
  The tool catalog is assembled by `buildSystemPrompt()` in
  `src/lib/chat-prompt.ts` (browser); the bias-profile appendix is
  rendered and appended server-side by `applyBiasPriming`
  (`supabase/functions/venice/priming.ts`) before the first round,
  joined with the same blank-line separator so the wire bytes match.
- **The priming `<think>` chain (rows 4-7)** carries the volatile,
  per-turn context. These are synthetic `assistant` rows the model
  reads as its own immediately-prior thoughts, so they sit at the tail
  of the conversation, right before it generates. They are never
  persisted - they exist only in the in-memory `history` baton for this
  request.
- **The per-turn metadata block (row 8)** carries turn-volatile ambient
  state: wall-clock, the gated-toolbox on/off set, the thread
  attachments inventory, the emphasis-markdown nudge, and the title
  nudge. It rides LAST for prompt-cache economics (see Gotchas).

## The contributors

| Injector | Surface | Source | Cache | Freshness gate |
| --- | --- | --- | --- | --- |
| Bias profile | system appendix (row 1) | `applyBiasPriming` (`supabase/functions/venice/priming.ts`) | `bias_summary` row | read once per turn; tier + render-cap filtered |
| Context recall | `<think>` (row 4) | `maybeRunContextRecallPipeline` (`src/lib/context-recall`) | `threads.context_recall_payload` | `isPayloadFreshForInjection` (STALE_FUSE_MS) |
| Samskara compound | `<think>` (row 5) | `getCompoundSummary` (`src/lib/samskara`) | cached prose row | always-on; no fuse |
| Samskara fire | `<think>` (row 6) | `fireSamskaras` (`src/lib/samskara`) | computed per turn | raced against `SAMSKARA_PRIMING_TIMEOUT_MS` |
| Intuition | `<think>` (row 7) | `maybeRunIntuitionPipeline` (`src/lib/intuition`) | `threads.intuition_payload` | `isPayloadFreshForInjection` (STALE_FUSE_MS) |
| Tool catalog | system (row 1) | `buildSystemPrompt` / `buildToolList` (`src/lib/tools`) | n/a (derived from enabled toolboxes) | per-turn snapshot of `toolboxes_enabled` |
| Metadata block | system (row 8) | `buildMetadataSystemMessage` (`src/lib/chat-loop`) | n/a | rebuilt every turn |

## Ordering

The order in the table is the contract, and it is load-bearing:

- **Bias leads** because it is a structural claim about the user, not
  turn weather - it belongs with identity/voice in the cached baseline,
  not in the volatile tail.
- **The `<think>` chain is recency-ordered**: context recall (what the
  stores hold) first, the samskara layers (predictive priors) next,
  intuition (the most-synthesized read) last, closest to the model's
  generation point. There is no conflict-resolution step - the blocks
  are independent and the model integrates them; "precedence" is just
  proximity to the generation point.
- **Metadata trails** for cache economics, not reading order (Gotchas).

When you add an injector, decide which surface it belongs on by its
volatility: slowly-changing structural context -> baseline appendix;
per-turn synthesized context -> a `<think>` block at the appropriate
recency position; turn-volatile ambient state -> the metadata block.

## Freshness

Per-turn `<think>` injectors do NOT recompute every turn - that would
burn an embed + LLM call on every chitchat message. Instead:

- **Context recall and intuition** cache their payload on the thread
  row with the round + mood snapshot they were computed against.
  `maybeRun*Pipeline` owns the fire decision (cold-start, mid-turn
  title shift, mood-band shift, stale fuse); between fires the cached
  payload is reused as-is. Injection is separately gated by
  `isPayloadFreshForInjection` (shares `STALE_FUSE_MS` with the refresh
  trigger so inject-vs-refresh stay in lockstep): a payload past the
  fuse is suppressed rather than injected, because a stale prime steers
  the model wrong - worse than no prime. The next triggering turn
  recomputes.
- **Samskara compound** is a cached prose row, always injected when
  present (it is a stable cross-turn summary, not turn-specific).
- **Samskara fire** is the one always-recomputed injector (top-k for
  THIS user text), which is why it is the one bounded by a timeout.

## Failure degradation

Every injector is best-effort and MUST NOT block or fail a turn:

- The samskara compound + fire run inside a `Promise.race` against
  `SAMSKARA_PRIMING_TIMEOUT_MS`; on timeout both resolve null and are
  skipped (the underlying fire keeps running so its cohort log still
  lands). A slow Venice never adds visible latency to the first token.
- `maybeRunIntuitionPipeline` / `maybeRunContextRecallPipeline` swallow
  their own errors and return null -> the block is skipped.
- `applyBiasPriming` swallows errors -> the appendix is omitted (and
  its snapshot + clear writes are detached and swallowed too).
- Cold-start threads produce null for every `<think>` block and the
  conditional `history.push` calls skip them entirely; a fresh thread's
  first turn ships with no priming chain at all.

The invariant: a priming failure degrades to "less context this turn,"
never to a broken or delayed turn.

## Observability

- **`onSubconsciousStart(op)` / `onSubconsciousEnd(op)`** - a liveness
  pair per pipeline (`'samskara' | 'intuition' | 'recall'`) the UI
  renders as per-pipeline throbbers. Every Start gets exactly one End
  regardless of outcome.
- **`onIntuitionUpdate` / `onContextRecallUpdate`** - fire once per
  cache refresh with the freshly-computed payload, so the UI patches
  the in-memory thread row without waiting for a refetch.
- **The debug wire dump** - `runChatLoop` logs the full assembled
  `requestMessages` array at debug level (`'venice request wire'`).
  When a turn answers the wrong thing because a stale or misfired prime
  steered it, this is where you see the exact `<think>` chain that
  shipped. One filter-drop away in the logs drawer.

## Interactions

- [`chat.md`](./chat.md) - the turn lifecycle this layer rides inside.
- [`intuition.md`](./intuition.md),
  [`context-recall.md`](./context-recall.md),
  [`samskara.md`](./samskara.md),
  [`bias-profile.md`](./bias-profile.md) - the contributor features;
  each owns its own pipeline, cache, and trigger policy.
- [`tools.md`](./tools.md) - the tool catalog + toolbox-state halves of
  the system prompt.
- The assembly + ordering live in `src/lib/chat-loop.ts`; the baseline
  prompt + catalog in `src/lib/chat-prompt.ts`.

## Gotchas

- **Metadata rides last for prompt-cache stability, not reading order.**
  Venice (like every OpenAI-compatible backend) can only reuse a cached
  prefix that is byte-identical from token 0. The metadata block
  carries a wall-clock timestamp that changes every turn; positioned
  ahead of the conversation it would push the first-differing byte to
  the top and re-encode the whole transcript every turn. Pinned after
  the conversation, the stable baseline + history form a cacheable
  prefix and only the small trailing block falls outside the cache.
  The timestamp is minute-granular so multiple tool rounds inside one
  minute keep even that block byte-stable. The `<think>` priming chain
  is volatile turn-to-turn regardless, so its position does not affect
  cache reuse.
- **The `<think>` blocks are never persisted.** They live only in the
  request's `history` baton. They are not eligible
  `lastAssistantTimestamp` anchors and never appear in the stored
  transcript - the model "remembers" them only within the turn that
  injected them.
- **A model whose chat template rejects an assistant-role tail** breaks
  the priming chain (it ends on an assistant `<think>` row). See the
  `chatTemplateRequiresUserTail` flag in `src/lib/models` - it injects
  an empty user row between the conversation and the metadata block for
  those models.
- **Freshness suppression is silent.** A payload past `STALE_FUSE_MS`
  is dropped, not injected - so "the model ignored its intuition" can
  mean "the intuition was stale and correctly suppressed," not a bug.
  The debug wire dump distinguishes the two.
