# Intuition

A subconscious layer that runs alongside the main conversation: a
perception agent reads the transcript, five drive agents react in
parallel, and a synthesis agent collapses the reactions into a
single first-person internal monologue that gets injected ahead of
the next completion as `<think>`-tagged content.

Adapted from fnord's
[`lib/ai/agent/intuition.ex`](https://github.com/sysread/fnord/blob/main/lib/ai/agent/intuition.ex);
nak retunes the drives for a personal-assistant register (vs.
fnord's coding focus) and adds caching + trigger-based scheduling
so the seven model calls don't run every turn.

## Role in the app

The intuition layer is the conscious agent's prior. It does NOT
respond to the user; it produces an internal-monologue prompt that
seeds the conscious agent's response strategy.

Per turn the chat loop reads the cached payload from
`threads.intuition_payload`. If the cache is current and no trigger
fires, the existing payload is reused as-is. If a trigger does
fire, the pipeline runs synchronously, writes the new payload to
the cache, and the synthesis is wrapped in a `<think>` block on a
synthetic assistant message that is appended to the in-memory
history right after the user's turn. The next streamChat call sees
the `<think>` block as if it were the assistant's own prior
thought.

One trigger site: **pre-round** (start of `runChatLoop`). On cold
cache (no payload yet on this thread) it fires unconditionally with
reason `cold`. Otherwise it compares the cached payload's mood
snapshot against the current mood and refreshes if the valence band
index or the confidence column changed. The staleness fuse refreshes
after `STALE_FUSE_ROUNDS` user rounds without one.

There used to be a second, mid-turn trigger (refresh after a
successful `update_title` tool result, splicing the replacement
payload over the pre-round ephemeral message). It died when tool
dispatch moved server-side - the browser no longer sees
`update_title` results mid-turn, so there is nothing to hook. The
`'title'` member of `IntuitionTrigger` survives only because
payloads persisted before the migration still carry it (the
coercion in `types.ts` keeps accepting it). If a topic-shift
trigger ever comes back, it has to ride a server-side signal (the
stream channel's tool events), not the browser history array.

A round id is the count of user messages in `history`. Tool-using
turns inflate the chat-loop's own `round` counter but do not
change the user-round id - one user message, one round id,
regardless of how many tool calls fire during the response.

Cold start: an earlier revision skipped the pre-round trigger on
cold cache and waited for `update_title` mid-turn to populate.
That was brittle - any thread where the model didn't rename
(manually-titled threads, threads from before the feature
shipped, or a turn that didn't trip the rename heuristic) stayed
invisible to the user forever. Pre-round now fires on cold
cache; the cost is ~3 fast-model roundtrips of latency on turn
1, paid in exchange for the feature reliably landing on every
thread by the first response.

## Files

- `src/lib/intuition/prompts.ts` - the perception, synthesis, and
  five drive prompts plus `DriveName` / `DRIVE_NAMES` /
  `DRIVE_PROMPTS`. The drives form a tension ring: Attunement vs
  Candor (warmth vs truth), Curiosity vs Pragmatism (depth vs
  utility), Standing vs Pragmatism (effort-up vs effort-down).
  Standing is intentionally retained from fnord as an effort-
  amplifier hooked into LLMs' competence-signaling attractor;
  removing it drops the "lean in" pressure across the ring.
- `src/lib/intuition/types.ts` - the canonical `IntuitionPayload`
  shape, `coerceIntuitionPayload` (defensive jsonb reader),
  `STALE_FUSE_ROUNDS`, and `countUserRounds` (the round-id
  counter). Schema-versioned (`v: 1`); a drift / unknown-version
  row reads as null and triggers a fresh refresh.
- `src/lib/intuition/pipeline.ts` - `runIntuitionPipeline`. Each
  stage hits Venice's non-streaming `completeChat` and reads the
  single text response, the same pattern the samskara and summary
  agents use. Per-drive failures are tolerated (the drive is
  omitted from `payload.drives` and synthesis runs against the
  rest); perception or synthesis failure aborts the run and
  returns null so the caller leaves the prior cache in place.
- `src/lib/intuition/cache.ts` - `readIntuitionCache` /
  `writeIntuitionCache` plus `withIntuitionInflight`, a tab-local
  registry that collapses two near-simultaneous triggers onto
  one Promise.
- `src/lib/intuition/triggers.ts` - `evaluatePreRoundTrigger`,
  built on the `computed_at_round` debounce primitive: a trigger
  that lands in the same round as the last cache write no-ops.
- `src/lib/intuition/ephemeral.ts` -
  `buildIntuitionThinkMessage`, the wire-shape projection from
  cached payload to ephemeral assistant message
  (`<think>{INTUITION_THINK_MARKER}\n{synthesis}\n</think>`).
  The HTML-comment marker is inside the `<think>` block so the
  LLM ignores it; the UI uses it (or could; not currently
  rendered) to identify synthetic intuition turns when listing
  message blocks.
- `src/lib/intuition/index.ts` - public re-exports. Chat-loop and
  Chat.svelte import only from here.
- `src/components/IntuitionPill.svelte` - brain icon that opens
  the modal. Absolutely positioned inside `.messages-wrap`,
  stacked at the top of a vertical column with
  `SamskaraToasts.svelte` (middle) and the `.scroll-to-bottom`
  arrow (bottom) - all three pinned to the bottom-right of the
  messages pane. Suppressed when the active thread has no cached
  payload.
- `src/screens/Intuition.svelte` - the diagnostics modal. Reads
  the active thread's payload, renders synthesis + perception +
  the five drives + a footer with the trigger reason and
  computed-at timestamp.

## Entry points

- **Pipeline runtime**: `runChatLoop` in `src/lib/chat-loop.ts`.
  The pre-round trigger lives directly after the opening-recall
  `<think>` push.
- **UI mount**: `Chat.svelte`. The Pill mounts inside
  `.messages-wrap` above `SamskaraToasts` and the
  `.scroll-to-bottom` arrow; the modal mounts in the
  modal-overlay block. The transcript itself shows no per-round
  indicator - the brain pill at the bottom-right of the
  messages pane is the only surface, and it opens the same
  diagnostics modal regardless of which round the cached
  payload was computed for.
- **Chat-loop options**: `intuitionModelId` (omit to disable
  the feature on this turn) and `intuitionMood` (the
  `{ band, column }` pair from `bandIndexFor` / `columnFor`).
  Older callers / tests that don't pass these run the chat
  loop without the intuition layer at all - the cache is left
  untouched and no ephemeral message is injected.

## Data model

One jsonb column on `threads`:

```sql
alter table public.threads
  add column if not exists intuition_payload jsonb;
```

Shape (see `IntuitionPayload` in
`src/lib/intuition/types.ts`):

```ts
{
  v: 1,
  perception: string,                                 // begins with "Classification: <category>"
  drives: { attunement?: string, candor?: string, ... }, // failed drives are omitted
  synthesis: string,
  computed_at_round: number,                          // user-message count at write
  computed_at_band: number | null,                    // 0..4 in MOOD_TABLE order
  computed_at_column: 'confident' | 'tentative' | null,
  computed_at_at: number,                             // ms since epoch
  trigger: 'title' | 'mood' | 'stale' | 'cold',  // 'title' legacy-only (pre-migration payloads)
}
```

There is no historical record. The cache holds the most recent
payload only; older payloads are overwritten. Anyone wanting an
audit trail would have to add a `intuition_history` table; we
deliberately did not because the current payload is what the
model sees and the diagnostics modal already exposes it on
demand.

## Contracts

- **Cache is source of truth.** The ephemeral assistant message
  on the in-memory history is reconstructed from the cache at
  request time. The diagnostics modal reads from the same cache.
  Two projections, one source - they cannot drift.
- **No persistence of the ephemeral message.** The synthesis
  text never lands in `messages`. The cache survives reload;
  the in-memory `<think>` block does not (it's rebuilt on the
  next chat-loop invocation if the cache is still valid).
- **Round id is monotonic-per-thread.** Each user message
  bumps it by 1. The chat-loop never decrements; a regenerate-
  from-here flow that rolls user messages back is currently
  unhandled (the cache would still claim a higher round id
  than the live transcript). Acceptable today because
  regeneration is rare on threads where intuition has had time
  to populate; revisit if it becomes friction.
- **Trigger debounce primitive is `computed_at_round`.** Same-
  round writes no-op the trigger. This is the only duplicate-run
  prevention; do not introduce a parallel debounce.

## Interactions

- **Chat ([./chat.md](./chat.md))** - the chat-loop is the only
  caller of `runIntuitionPipeline`. The trigger site lives
  inside `runChatLoop`; the `intuitionModelId` and
  `intuitionMood` options on `ChatLoopOptions` are how the
  caller wires the feature on. The synthesis lands as a
  `<think>` block on a synthetic assistant message in the
  in-memory `history` array, mirroring the existing opening-
  recall ephemeral pattern.
- **Samskara ([./samskara.md](./samskara.md))** - the mood
  trigger reads `moodState.current` (the same rune the mood
  pill uses) and projects it through `bandIndexFor` /
  `columnFor` from `src/lib/samskara/events.ts` to produce the
  `{ band, column }` pair. The intuition layer does NOT subscribe
  to `SAMSKARA_MINT_EVENT` directly - it just compares the
  current mood snapshot at turn-entry against the cache's
  snapshot.
- **Context recall ([./context-recall.md](./context-recall.md))** -
  parallel pipeline that rides the SAME trigger evaluator and
  fires alongside intuition on every cold-start / mood /
  stale fire. The two pipelines run in `Promise.all` so wall-clock
  cost is bounded by the slower of the two; their caches and
  inflight registries are sibling-but-separate. The shared
  `RoundCacheSnapshot` type in `triggers.ts` is what lets the
  evaluator read either cache without a cast.
- **Bias profile ([./bias-profile.md](./bias-profile.md))** -
  sibling cross-conversation pattern, no data flow. Intuition
  fires per-thread on trigger events and produces a `<think>`
  block; bias profile fires across conversations in the
  background and produces a system-prompt section. Both
  surface as bottom-right pills (bias stacks above intuition)
  and open into their own diagnostics modal.
- **Logging ([./logging.md](./logging.md))** - the pipeline
  uses `createLogger('intuition')`. The `FNORD_DEBUG_INTUITION`
  env var from the source module is intentionally NOT carried
  over - nak's logger drawer has built-in level filters and a
  source-tag search, which fills the same role.
- **Routing ([../user/intuition.md](../user/intuition.md))** -
  the `'intuition'` modal value is added to the `Modal` union
  in `src/lib/routing.svelte.ts`. The Pill calls
  `navigate({ modal: 'intuition' })`.

## Gotchas

- **Drive base prompt contains "phantasia".** The perception
  prompt also references "phantasia" / "hupolepsis" (the
  observer-vs-judgement Greek pair). When mocking Venice in
  tests, do not key on `phantasia` to identify the perception
  call - it matches drive prompts too. Use
  `objective *perception*` (unique to the perception prompt)
  and `# Your Drive: <Name>` for individual drives.
- **Pipeline is non-streaming.** Each stage hits Venice's
  one-shot `completeChat` and reads the single text response.
  The user visually sees the latency as a longer pause before
  the conscious response starts streaming - 7 calls on the fast
  tier collapse to ~3 sequential roundtrips because the 5
  drives run in parallel.
- **Refresh failures leave the prior cache in place.**
  Perception or synthesis failure returns null from the
  pipeline; we deliberately do NOT clear the cache on
  failure. Better to ship a slightly stale read than to
  drop into cold-start mid-conversation.
- **One drive failure is fine; all five failing aborts.** The
  synthesis prompt is robust to uneven input but vacuous
  against an empty drive set. The pipeline returns null in
  the all-fail case rather than synthesizing nothing.
- **The ephemeral message replaces, not appends, on title
  trigger.** The pre-round trigger may have already pushed an
  ephemeral message at index `intuitionMessageIdx`. When the
  title trigger lands a fresh payload, we splice the new
  message into the same index rather than push another one -
  otherwise the model sees two `<think>` blocks competing
  for influence on the same response.
- **The marker is inside the `<think>` block.** Putting the
  marker outside (at the assistant message's content level)
  would show up in any UI that renders raw assistant content.
  Inside the `<think>` block, the LLM treats it as scratch
  noise (HTML comments inside thought blocks are common) and
  the UI never renders the block as text in the first place.
- **No turn id column on `messages`.** Round id is derived
  from `count(user messages in history)`, which works as long
  as the message order is stable. If a future feature
  reorders messages (a soft-delete that re-numbers rounds, a
  branch/fork model), `computed_at_round` semantics need
  re-examining.
