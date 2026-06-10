# Samskara

The chat model's progressively-built predictive model of the
user. Per-round observations (substrate) compound through a
background formation worker into emergent predictive claims
(samskaras); those samskaras fire by cosine similarity on every
turn and a compound prose summary of the strongest ones rides in
every system prompt as always-on calibration. The intent is the
opposite of "born yesterday" - every conversation carries some
calibrated bias from prior conversations with the same user,
without having to cram the entire history into a context window.

## Role in the app

A samskara is a one-line predictive claim ("in situations like
X, this user tends to Y") with an embedding so it can be fired
by cosine similarity to the user's current message. There is no
fixed affect/trait vocab; samskaras are free-form text and their
structure is emergent through clustering, not declared by an
enum.

Per turn the chat loop does two cheap reads: it pulls the cached
compound prose summary and it fires a wide cosine query against
the samskaras table. Both run inside a `Promise.race` against a
1500ms cap so a slow Venice or RPC hiccup can't delay the user's
first token. The combined block is appended to the system prompt
for that round only; the rest of the loop is unchanged.

Everything else - assimilating substrate into structured fields,
embedding it, labelling pairs, minting tier-1 samskaras from
clusters, minting tier-2 compounds from recurring co-fire
constellations of tier-1 samskaras, classifying reactions,
decaying stale or disconfirmed samskaras, regenerating the
compound summary - runs in a dedicated background worker between
user messages. The worker
uses the project's fast-model tier for all LLM calls. Async-
friendly: nak chat is SMS-shaped (the user can wander off for an
hour and come back), so formation has time to catch up between
turns without blocking anything.

Mints surface to the user through a minimal UI: a subtle top-
right toast stack shows a single valence-mapped emoji per new
samskara and self-dismisses after a few seconds. No prediction
text leaks to the user (showing the raw claim would collapse the
"absorption over disclaimer" framing the design landed on); the
toast is just a glance cue that the bias model is forming.

## Files

- `src/lib/samskara/index.ts` - the chat-loop-facing public
  surface. Owns `fireSamskaras`, `getCompoundSummary`,
  `recordSubstrateStub`, re-exports `formatPriming` and the
  tunable constants. Every samskara-side failure path is
  swallowed here so a samskara failure never blocks a chat turn.
- `src/lib/samskara/format.ts` - pure formatter for the priming
  block. Renders the compound summary as a leading paragraph
  and the fired samskaras as bullets below, token-budget capped
  via `PRIMING_CHAR_BUDGET`. Weakest-but-relevant fires fall
  back to an abbreviated form before being dropped, so the long
  tail stays visible when budget tightens.
- `src/lib/samskara/types.ts` - shared `FireResult` /
  `FiredSamskara` / `PrimingInput` types and the tunable
  constants (`K_BASE`, `PRIMING_CHAR_BUDGET`,
  `STALE_CEILING_HOURS`). Kept separate from `./index.ts` so
  consumers of the types don't drag the Supabase/Venice imports
  along.
- `src/lib/samskara/events.ts` - main-thread event bridge
  (rune-free). Defines `SAMSKARA_MINT_EVENT`, `valenceToEmoji`,
  `valenceToMoodLabel`, `notifySamskaraMint`, the `MOOD_TABLE`
  lookup that drives the mood pill, and the `cellFor` /
  `bandIndexFor` / `columnFor` coordinate helpers used by the
  mood legend's "you are here" dot. Mint-event detail carries
  `{ tier, valence, confidence }`; the lookup splits each of five
  valence bands into a confident column (confidence >=
  `CONFIDENCE_CUT`, default 0.5) and a tentative column (below
  the cut). Separate from the Svelte component so the manager can
  import without pulling Svelte runtime into the worker bundle.
  `SamskaraMoodLegend.svelte` (the Summary & mood sub-view of the
  Samskara tab) renders the same `MOOD_TABLE` as a fold-away legend so
  the user-visible documentation can never drift from the live mapping.
- `src/lib/samskara/mood.svelte.ts` - shared current-mood state
  (`moodState`) read by both `SamskaraToasts.svelte` and
  `SamskaraMoodLegend.svelte`. Holds the raw `{ valence, confidence, tier
  } | null` triple. The pill is the sole writer (updates on mint
  events and on the seed-from-history path; clears on thread
  switch); the legend is a passive observer that uses it to plot
  the "you are here" dot on the legend table. Lifting the triple
  out of the pill keeps the dot perfectly aligned with the pill
  the user clicked to open the tab - no separate fetch, no
  listener race. Lives in its own .svelte.ts module rather than
  `events.ts` because `events.ts` is shared with the worker
  bundle, which cannot import Svelte runes.
- `src/components/SamskaraToasts.svelte` - the persistent
  mood-pill UI. Listens for `SAMSKARA_MINT_EVENT` on `window`,
  renders the latest mint's emoji as a pill in the bottom-right
  of the messages pane (between the IntuitionPill above and the
  scroll-to-bottom arrow below), and stays visible until the
  next mint (or a thread switch) so the user can connect the
  glyph to whatever it reacted to. Whenever a thread is active (`route.cid` set)
  the pill is visible. On thread open it seeds asynchronously
  from `samskaraGetLatestFireMood(cid)` (the most recent stored
  fire's joined valence + tier + confidence), so reopened
  conversations surface the model's last read instead of waiting
  for a fresh mint. While the seed query is in flight, and on
  threads that have never fired or where the query fails, the
  pill renders U+1F4A4 SLEEPING SYMBOL (💤) as a "nothing to
  report" placeholder. A monotonic generation counter guards the
  seed fetch against thread-switch races. The pill is only
  suppressed on the brand-new-chat screen where `route.cid` is
  null. Click opens the Samskara diagnostics tab on its Summary &
  mood sub-view regardless of state. Mounted once in `Chat.svelte`. Composition
  only: every mood-shape transition (dedup-on-same-band,
  placeholder factory, seed-vs-mint race resolution) lives in the
  primitives module next door.
- `src/lib/ui/samskara-toasts.ts` - pure UI-behavior primitives
  for the mood pill. `defaultMood()` factory + the `DEFAULT_EMOJI`
  / `DEFAULT_LABEL` constants for the 💤 placeholder;
  `nextMoodFromMint(prev, detail)` returns the next visual shape
  or null to signal the dedup skip (incoming mint lands in the
  same emoji/label/tier as what's showing); `nextMoodFromSeed(prev,
  seed)` returns the upgraded shape or null when a real mint won
  the within-thread race against a slow seed query. Unit-tested
  directly at `tests/samskara-toasts.test.ts` with plain vitest.
- `src/components/CohortPanel.svelte` - the per-cohort diagnostic
  card mounted inline under each user message in the transcript.
  Composition-only: prop wiring, the `raw` and `expandedClusters`
  runes, `$derived` declarations that thread props through the
  primitives, and the markup. Every decision the panel makes is
  delegated to the primitives module next door.
- `src/lib/ui/cohort-panel.ts` - pure UI-behavior primitives for
  the panel. `sortFiresByScore`, `clusterFires` (with the
  negative-fallback-seq rule for unassigned fires that keeps the
  each-block keys distinct), `resolutionLabel` /
  `resolutionStatusClass` for the three-state confirmation flag,
  `assimilationStatus` / `substrateStatusClass` for the substrate
  lifecycle, and the `formatRelative` (injectable `now`) and
  `formatValence` formatters. Unit-tested directly at
  `tests/cohort-panel.test.ts` with plain vitest - no mount, no
  harness.
- `supabase/functions/_shared/embed-input.ts` - the
  `samskara-substrate` entry in `EMBED_SOURCES` registers substrate
  as a third source the server-side embeddings backfill drains
  alongside memories and threads. The cron-driven backfill claims
  `samskara_substrate where situation_embedding is null and situation
  is not null` (via `samskara_claim_next_substrate_embed`), embeds via
  Venice, and saves under a guard. Mirrors the memories source entry.
- `src/lib/agents/samskara/agent.ts` - `SamskaraAgent`, a single
  class whose methods correspond to the worker phases:
  `assimilate`, `relate`, `mint`, `classifyReaction`,
  `summarizeCompound`. Each method makes one fast-model Venice
  call, parses a JSON envelope the prompt names explicitly, and
  returns a typed result (or null on parse failure). Rate-limit
  errors re-throw so the cycle driver can map them to the long
  back-off.
- `src/lib/agents/samskara/prompts.ts` - the five agent prompts
  (`ASSIMILATOR_PROMPT`, `RELATOR_PROMPT`, `MINTER_PROMPT`,
  `REACTION_PROMPT`, `COMPOUND_SUMMARY_PROMPT`). Each is terse
  on purpose; the fast-model tier has a smaller context window
  and we'd rather pay tokens for inputs than instructions.
- `src/lib/agents/samskara/loop.ts` - the testable cycle driver.
  `runOneCycle(ctx)` acquires the lease if needed, then
  advances exactly one phase per cycle. The outer worker
  rotates through `PHASES` (assimilate, pair-relate,
  mint-tier1, mint-tier2, reaction-classify, decay,
  dedup, compound-regen) and treats an all-empty rotation as
  the idle signal.
- `src/lib/agents/samskara/worker.ts` - the Web Worker entry
  point. Builds its own Supabase + Venice clients from the
  `start` message (class instances don't structured-clone),
  instantiates the agent, and drives `runOneCycle` until abort.
  Forwards `mint` payloads back through `postMessage` so the
  manager can re-emit them on the main thread.
- `src/lib/agents/samskara/manager.ts` - main-thread supervisor,
  same shape as `EmbeddingManager` / `ReflectionManager` /
  `SummaryManager`. Owns the `navigator.locks.request(
  'nak:samskara-worker')` Web Lock, the per-device `holderId`,
  and the auth-change forwarding. Translates inbound `mint`
  worker messages into `SAMSKARA_MINT_EVENT` CustomEvents on
  `window`.
- `supabase/schema.sql` (samskara section) - six tables with
  RLS, the `worker_kind='samskara'` lease partition, and the
  RPC surface covering fire, cohort log, reaction apply,
  substrate record, assimilate claim/save, substrate-embed
  claim/save, decay, co-firing-based dedup collapse,
  `samskara_tier2_candidate(...)` (the co-fire-group detector the
  mint-tier2 phase reads - the inverse of dedup; see the Tier-2
  detection formula below), `samskara_nearest_by_prediction(embed,
  k, tier)` whose optional tier filter the tier-2 dedup guard
  passes `2`, the three compound-regen coordinators, and the
  diagnostics-only
  `samskara_cluster_thread_fires(thread, threshold)` that
  greedy-clusters a thread's fires by cosine similarity on
  their samskaras' prediction embeddings (per-cohort, in score
  order; default threshold 0.7 sits in BGE-M3's "topically
  similar" band, with a slider in the modal for live tuning -
  higher reads as "near-duplicate sentence", lower reads as
  "loosely related"). A private
  `_samskara_merge_pair(winner, loser, user)` helper backs the
  dedup RPC; underscore-prefixed to signal internal-only. Follows
  the project's idempotent-apply conventions (`if not exists`,
  drop-then-create for policies and functions).

## Entry points

- **`runChatLoop` round-1 entry** - in `src/lib/chat-loop.ts`,
  before the first round's `requestMessages` is assembled, the
  loop races `getCompoundSummary(supabase)` and
  `fireSamskaras(supabase, venice, threadId, currentUserRound,
  userText, signal)` in parallel under a
  `SAMSKARA_PRIMING_TIMEOUT_MS` (1500ms) cap. `currentUserRound`
  is hoisted up to fire time from `countUserRounds(history)` so
  each cohort row carries the user-message index it anchors to.
  The resulting appendix is passed into `buildSystemPrompt({
  promptAppendix })` so every round this turn sees the same
  compound + fire signal (one cohort id per user turn, not per
  round). Underlying Promises keep running on timeout; the
  worst case is one cohort logged but never reaction-classified,
  which the worker's resolution-window drops naturally.
- **Inline `CohortPanel` in `Chat.svelte`** - on thread load,
  `Chat.svelte` calls `samskaraListFiresForThread`,
  `samskaraListSubstrateForThread`, and
  `samskaraClusterThreadFires` once. Fires group by
  `user_round`, substrate joins on `user_message_id`. Each user
  message in the transcript gets a pulse-icon toggle in its
  action row; click it to expand a `CohortPanel` anchored to
  that turn. End-of-turn the loader is invoked again so the
  just-fired cohort appears under its triggering message
  without a manual refresh. The Samskara diagnostics modal no
  longer carries per-message detail - cohort fires + substrate
  for one round are exclusively the inline panel's domain.
- **`runChatLoop` end of turn** - after the terminal assistant
  row persists, the loop calls
  `recordSubstrateStub(supabase, threadId, userMessageId,
  assistantMessageId)` as a fire-and-forget write. The
  assimilator phase enriches the stub later; this call does no
  LLM work.
- **`samskaraManager.start(opts)`** - called from `activate()`
  in `state.svelte.ts` alongside the other worker managers.
  Acquires the `nak:samskara-worker` Web Lock, posts the
  worker a `start` message carrying the per-device holderId
  and the fast-model id, and subscribes to main-thread auth
  changes so the worker can re-pin rotated tokens.
  `samskaraManager.stop()` in `lock()` tears it down.
- **Embeddings backfill** - the server-side backfill's round-robin
  picks up the `samskara-substrate` source automatically. No
  samskara-specific entry point on that side; the `EMBED_SOURCES`
  registry entry shapes the same claim/build/save flow memories and
  threads do.
- **`SAMSKARA_MINT_EVENT` listener** - the `SamskaraToasts`
  component mounted inside `Chat.svelte` listens on `window`
  for `CustomEvent<SamskaraMintEventDetail>` and renders a
  valence-mapped emoji pill.

## Data model

Six tables. All RLS-scoped to `auth.uid() = user_id`, all
created with `if not exists`, all RLS policies
drop-then-recreated per the project's idempotency convention
(see `supabase/schema.sql`'s header comment).

### `samskara_substrate`

Per-round episodic observations. Written as a thin stub at
chat time; enriched in the background.

- `id uuid primary key default gen_random_uuid()`.
- `user_id uuid` (FK to `auth.users`).
- `thread_id uuid` (FK to `threads` on cascade).
- `user_message_id uuid not null` and `assistant_message_id
  uuid` (nullable when the assistant turn errored or was
  aborted). The anchors the assimilator reads.
- `situation text`, `outcome text`, `valence real` - filled by
  the assimilator agent. Null at chat-loop write-time. Valence
  is a continuous scalar in roughly [-1, 1] capturing emotional
  charge; zero is neutral.
- `situation_embedding vector(2048)` - null until the
  embeddings backfill fills it from the enriched `situation`
  text. Padded from 1024-dim Venice native via
  `padEmbeddingForStorage` (see `src/lib/models.ts`).
- Claim columns for each pending phase: `(embedding_claim_holder,
  embedding_claim_expires)` for the substrate-embed source and
  `(assimilate_claim_holder, assimilate_claim_expires)` for the
  assimilator phase. Two phases write to this row at different
  times so they need independent claims.
- Partial indexes on `(user_id, created_at) where situation is
  null` and `(user_id, created_at) where situation_embedding is
  null and situation is not null` keep the workers' poll
  queries cheap as the substrate table grows.

### `samskara_associations`

Pair-labels between substrate rows, written by the relator
phase.

- `id`, `user_id`, `a_id`, `b_id` (FKs into substrate on
  cascade).
- `articulated_relation text not null` - the relator agent's
  short label.
- `relation_embedding vector(2048)` - reserved for label-level
  clustering; nullable so the relator phase can write the row
  immediately and an embedder catches up later (same
  separation as substrate's situation vs situation_embedding
  split).
- `kind text check in ('pattern', 'contrast', 'prerequisite',
  'consequence')` - the relator's taxonomy. The fifth scratch
  category `'orthogonal'` is filtered at agent boundary and
  never written.
- `reinforcement integer default 1` - bumped by `on conflict
  (user_id, a_id, b_id, articulated_relation) do update`, so
  re-encountering the same pair with the same label lifts
  reinforcement instead of duplicating.
- `last_reinforced_at`, `created_at` timestamps.

### `samskaras`

The unit. Tier 1 is minted from substrate-cluster mints; tier
2 is minted from recurring co-fire constellations of tier-1
samskaras (the mint-tier2 phase, see Contracts). Cap is `tier in
(1, 2)` - no tier 3.

- `id`, `user_id`, `tier int check in (1, 2)`.
- `prediction text not null` - the minter agent's one-or-two-
  line claim. This is what the chat-time fire query runs
  against, via `prediction_embedding`.
- `prediction_embedding vector(2048) not null`.
- `inner_voice text` - optional silent self-talk fragment;
  rendered in the priming block when present, truncated past
  80 chars.
- `valence real` - aggregated from substrate or child-samskara
  provenance. Same scalar as on substrate.
- `confidence real default 0.5` - updated via the additive-
  Laplace formula in `samskara_apply_reaction`.
- `health real default 1.0` - decays over time and on
  disconfirm; clamped to [0, 1]. **NO threshold filter at fire
  time** - see Gotchas.
- `fire_count`, `confirm_count`, `disconfirm_count`,
  `last_fired_at`, `created_at`, `updated_at`.
- Indexes on `(user_id, tier)` and `(user_id, health desc,
  confidence desc)`.

### `samskara_provenance`

Audit trail for what each samskara was minted from. Kept even
if the underlying substrate or association is deleted (no FK on
`ref_id`); debugging beats normalisation.

- `samskara_id` (FK on cascade), `user_id`, `kind text check in
  ('substrate', 'association', 'samskara')`, `ref_id uuid`,
  `weight real default 1.0`.
- Primary key `(samskara_id, kind, ref_id)`.
- Tier-1 samskaras carry `'substrate'` and `'association'`
  provenance; tier-2 samskaras carry `'samskara'` provenance
  pointing at their tier-1 children, with `weight` set to each
  child's in-group co-fire count.

### `samskara_fires`

One row per samskara fired per turn. Drives reaction
reinforcement and cohort detection.

- `id`, `user_id`, `samskara_id` (FK on cascade), `thread_id`,
  `cohort_id uuid not null`, `user_round integer`, `fired_at`,
  `score real not null`, `was_confirmed boolean`.
- `cohort_id` is shared across the set of samskaras fired
  together on the same turn, generated client-side when the
  chat loop assembles the fire. Lets the reaction classifier
  and the tier-2 mint phase's co-fire self-join operate on the
  cohort as a unit.
- `user_round` is the 1-based index of the user message that
  triggered this cohort, counted by `countUserRounds(history)`
  in the chat loop at fire time. The inline `CohortPanel` in
  the chat transcript walks user messages in transcript order
  and joins on this column. Nullable for legacy rows; a
  one-time backfill ranks each (user_id, thread_id) cohort by
  min(fired_at) and assigns sequential integers, which is exact
  when every user message produced a fire and off-by-N for
  threads with cold-start gaps.
- `score` is the ranking score at fire time, kept for
  analytics.
- `was_confirmed` starts NULL, set to true/false by the
  reaction classifier on the next user turn. Older unresolved
  fires age out via decay rather than being force-classified by
  stale signal.
- Partial index on `(user_id, thread_id, fired_at desc) where
  was_confirmed is null` targets the reaction-classify poll.
- Partial index on `(user_id, thread_id, user_round) where
  user_round is not null` targets the inline CohortPanel
  lookup ("which cohort fired at user-round N in this thread").

### `samskara_compound_summary`

Cached prose, one row per user. The always-on block that rides
at the top of every system prompt.

- `user_id uuid primary key`, `summary text`,
  `samskara_count_at_regen int`, `last_regen_at timestamptz`,
  `regen_claim_holder text`, `regen_claim_expires timestamptz`.
- Per-row claim so multiple devices coordinate regeneration
  instead of duplicating the fast-model call.

### Lease

`worker_leases` row with `worker_kind='samskara'`. New
partition, holds independently of `'embedding'`, `'reflection'`,
and `'summary'`; one device can hold all four leases
simultaneously. Same TTL and heartbeat numbers as the other
workers (45s / 20s).

## Contracts

### Chat-loop side (synchronous, no LLM)

- `getCompoundSummary(supabase): Promise<string | null>` -
  reads the cache row. Returns null on cold start (no row yet
  or `summary` is null/empty) and when `last_regen_at` is older
  than `STALE_CEILING_HOURS` (24h). Network errors are
  swallowed and surface as null so a transient offline moment
  doesn't propagate into the chat-loop's error path.
- `fireSamskaras(supabase, venice, threadId, userText,
  signal?): Promise<FireResult | null>` - embeds `userText` via
  Venice, pads the query, runs `samskara_fire_top_k`, and
  persists a `samskara_fires` row per hit via
  `samskara_record_fires`. `cohort_id` is generated client-side
  (crypto.randomUUID with a Math.random fallback). Returns null
  on empty corpus, empty input, embedding failure, or RPC
  failure; errors are logged at `console.debug` so a chat turn
  is never blocked.
- `recordSubstrateStub(supabase, threadId, userMessageId,
  assistantMessageId | null): Promise<void>` - one INSERT via
  `samskara_record_substrate`. `situation` / `outcome` /
  `valence` / `situation_embedding` all null; the worker fills
  them. Errors swallowed; fire-and-forget.
- `formatPriming({ compoundSummary, fire }): string` - pure.
  Renders the appendix block with the compound paragraph first
  and the fire bullets below, sorted by score descending. Keeps
  the top three fires in full form and abbreviates the rest
  when total length exceeds `PRIMING_CHAR_BUDGET` (2400 chars);
  drops the weakest entries one by one if abbreviation alone
  doesn't fit.
- `topKForCorpusSize(n, kBase): number` - computes
  `max(1, ceil(kBase * log10(n + 10)))`. The fire call passes
  `topKForCorpusSize(100, K_BASE) * 2 = 22` as a generous upper
  bound; the formatter does the budget trim.

### Worker side (async, fast-model agent calls)

Each phase is a one-row-at-a-time cycle that mirrors the
embeddings backfill's claim -> process -> save shape. Phase
rotation via `PHASES`: each cycle of the outer worker advances
exactly one phase; an all-empty rotation triggers the idle
sleep (60s).

- **Assimilate** - `SamskaraAgent.assimilate(userMsg,
  assistantMsg, signal) -> {situation, outcome, valence} |
  null`. Reads the raw exchange, returns structured substrate
  fields. Claim RPC `samskara_claim_next_assimilate`; save RPC
  `samskara_save_assimilation_if_claimed`.
- **Pair-relate** - `SamskaraAgent.relate(a, b, signal) ->
  {kind, label} | null`. The phase reads recent embedded
  substrate, seeds on the most recent row, finds its closest
  embedded neighbour by cosine in JS, and calls the relator
  agent. v1 uses that naive "seed = most recent" approach; one
  pair per cycle keeps LLM call rate bounded. Orthogonal
  verdicts skip the write. Associations are upserted via a
  direct `client.from('samskara_associations').upsert(...)`
  with `onConflict` on the unique key, not an RPC.
- **Mint-tier1** - `SamskaraAgent.mint({sample_labels,
  sample_situations, reinforcement}, signal) -> {confirm,
  prediction, inner_voice, valence, confidence} | null`. v1
  treats the most recent few embedded substrate rows as a
  cluster and asks the minter whether they support a
  prediction. The agent's `confirm: false` path is a weak
  first-line filter (it refuses clusters it thinks are too
  thin) but it can only see the five-row sample, never the
  existing samskara corpus, so on its own it produces near-
  duplicate twins of older claims as the sample drifts. A
  second dedup guard runs after the prediction is embedded:
  `samskara_nearest_by_prediction` returns the closest
  existing samskara by cosine on `prediction_embedding`; when
  the similarity exceeds `MINT_DEDUP_COSINE` (0.85), the loop
  calls `samskara_reinforce_existing` - appending substrate
  provenance and nudging health up by `MINT_DEDUP_HEALTH_BUMP`
  (0.02, capped at 1.0) - instead of inserting a twin. Only
  genuinely novel predictions fall through to the insert path.
  The minter prompt explicitly invites negative predictions
  ("user tends to NOT do Y") and assistant-behaviour
  predictions ("user expects the assistant to ask before
  suggesting code") alongside the standard positive shape.
  Successful mints fire an `onMint` callback into the worker
  loop context; the worker forwards to the manager via
  `postMessage`, and the manager re-emits as
  `SAMSKARA_MINT_EVENT` for the toast UI to pick up. Dedup-
  reinforcement does NOT fire `onMint` (no new samskara
  landed), though it does log at info-level so the Logs drawer
  shows "dedup-reinforced existing" breadcrumbs.

  A third tool - `samskara_collapse_by_cofiring(...)` - handles
  ongoing redundancy consolidation. It's the same RPC the
  background dedup phase runs each rotation (see below). A manual
  "Consolidate" button existed as build-time scaffolding in the
  now-retired diagnostics modal; it was intentionally not migrated to
  the Samskara tab (the worker runs the dedup automatically), so the
  RPC currently has no UI trigger. Idempotent.
- **Mint-tier2** - `SamskaraAgent.mintTier2(children, signal) ->
  {confirm, prediction, inner_voice, valence, confidence} | null`.
  Detects one recurring co-fire constellation of tier-1 samskaras
  via `samskara_tier2_candidate` (a co-fire group, not a substrate
  cluster), hands the child predictions to the minter agent, and -
  if the agent confirms - inserts a `tier=2` row whose provenance
  points at the children with `kind='samskara'`. Two dedup guards:
  the candidate RPC skips groups an existing tier-2 already covers by
  child-set overlap (same children), and after the compound is
  embedded the loop checks the nearest existing tier-2 by cosine
  (`samskara_nearest_by_prediction` with `p_tier=2`), reinforcing it
  via `samskara_reinforce_existing` when cosine >= `MINT_DEDUP_COSINE`
  (0.85) instead of minting a twin (the different-children-same-claim
  case). Throttled at 5 minutes - longer than mint-tier1's 60s
  because compound patterns form slowly and the detection self-join
  is the heaviest query in the worker. Successful mints fire `onMint`
  with `tier: 2`; the mood pill renders them through the same
  valence->emoji path as tier-1, so there is no UI special-case.
- **Reaction-classify** -
  `SamskaraAgent.classifyReaction(cohort, assistantMsg,
  nextUserMsg, signal) -> {confirm[], disconfirm[], neutral[]}
  | null`. Reads the most recent unresolved cohort whose
  follow-up user message has landed (fires aged 1-10 minutes
  ago, older fires age out via decay), the assistant's reply,
  and the next user message; partitions the cohort into three
  buckets and applies via `samskara_apply_reaction`. Neutrals
  get `fired_at` nudged 15 minutes back so the unresolved-poll
  skips them on subsequent passes.
- **Decay** - `samskara_decay()` RPC, no LLM. Three paths; see
  the Decay formula below.
- **Dedup** - `samskara_collapse_by_cofiring(...)` RPC, no LLM.
  Two-pass: a primary co-firing-based pass merges tier-1 pairs
  that reliably activate in the same cohort (Hebbian
  redundancy), and a population-count safety cap falls through
  to pure embedding-cosine greedy merge when the pool still
  exceeds target. Each pass preserves the older row as winner,
  retargets fires + provenance, folds counters, deletes the
  loser. Per-call capped at 20 merges so one RPC never runs
  unboundedly; repeated rotations drain any backlog.
  See the Dedup formula below for parameters and rationale.
- **Compound-regen** - three-step dance. First
  `samskara_should_regen_compound()` returns a decision payload
  (cheap). If `should_regen`, try to claim via
  `samskara_claim_compound_regen(holderId, 180s)`. If claimed,
  read the top `max(8, ceil(5 * log10(N + 10)))` samskaras
  ranked by `(health desc, confidence desc)`, call
  `SamskaraAgent.summarizeCompound`, and save via
  `samskara_save_compound_summary_if_claimed`. The 180s claim
  TTL means a failed regen unblocks the slot within 3 minutes
  rather than parking other devices for 20.

### Fire ranking formula

`samskara_fire_top_k` ranks by three multiplicands:

```text
score = power(max(1 - cosine_distance, 0), 1.3)
      * sqrt(max(health * confidence, 0))
      * (1 + 0.1 * ln(1 + confirm_count + disconfirm_count))
```

The first term is cosine similarity raised to a mild power
(1.3). Linear cosine let well-tested off-topic samskaras
(cos=0.20, sqrt term ~1.0) outrank mid-quality on-topic ones
(cos=0.55, sqrt term ~0.5) because the multiplicative
health/confidence/N terms could close the gap; powering the
cosine factor cuts a 0.20 match by ~45% and a 0.70 match by
only ~9%, so the long tail stays present (no SQL threshold)
but topical samskaras stop crashing into unrelated turns. The
greatest(..., 0) clamp guards against the (rare) negative
cosine case where power() would otherwise raise on a
fractional exponent. The 1.3 exponent is the conservative end
of the dial; if it under-corrects in practice, 1.5 is the next
step up.

The sqrt term softens both the confidence and health axes so a
strong-but-distant samskara can't crush a weak-but-relevant
one. The ln term is a sample-size bonus: two samskaras with
identical confidence but different sample sizes (4/5 vs 80/100
confirms) rank by sample size when cosine and health are
close. Caps at ~1.46x for N=100; a brand-new samskara at N=0
still ranks normally so it can fire and accumulate signal.

### Reinforcement formula

Bayesian-ish, inside `samskara_apply_reaction`:

```text
on confirm (per cohort member):
  confirm_count += max(1 / sqrt(cohort_N), 0.01)
  confidence = (confirm_count + 2) / (confirm_count + disconfirm_count + 3)
on disconfirm (per cohort member):
  disconfirm_count += max(1 / sqrt(cohort_N), 0.01)
  confidence = (confirm_count + 1) / (confirm_count + disconfirm_count + 3)
```

Cohort weight is `1 / sqrt(N)` with a 0.01 floor and two-decimal
rounding. A 5-strong cohort all confirming contributes
`5 * 0.45 ~ 2.24` total confirm-count, not 5. Large cohorts
reinforce meaningfully but can't dominate single-fire signal.

### Decay formula

Three paths per `samskara_decay()` pass. Health is clamped to
[0, 1].

```text
stale-fire decay:
  health -= 0.02 where last_fired_at is null
                    or last_fired_at < now() - interval '60 days'
disconfirm decay:
  health -= 0.10 where disconfirm_count > confirm_count
                    and disconfirm_count + confirm_count >= 3
locked-in-without-feedback decay:
  health -= 0.03 where fire_count > 10
                    and (confirm_count + disconfirm_count) < 0.2 * fire_count
```

The third path catches the "stereotype hardening" pathology
where a samskara fires constantly but never gets explicit
confirm or disconfirm (neutrals only). The existing two paths
never touch it; this gentle nudge crowds it out without
artificially perturbing user-facing behaviour.

### Dedup formula

Two passes per `samskara_collapse_by_cofiring()` call.

**Primary pass: behavioural redundancy.** A tier-1 pair (A, B)
merges when all three hold:

```text
cofires(A, B) >= p_min_cofires            -- default 3
cofires(A, B) / min(fires_A, fires_B)
                >= p_min_cofire_ratio     -- default 0.5
cosine(embed_A, embed_B)
                >= p_cosine_floor         -- default 0.70
```

Co-fires are counted by self-joining `samskara_fires` on
`cohort_id`. The ratio normalization matters: two samskaras that
*always* fire together when either fires are duplicates; two that
often co-fire but also fire independently are adjacent-but-
distinct. The cosine floor is a sanity check against situational
overlap (e.g. "tech tester" and "barley science" both firing on a
debug-panel-about-baking turn without being the same habit). Pairs
are merged in descending (ratio, cosine) order so the strongest
redundancies consolidate first.

**Safety cap: population overflow.** If the tier-1 count still
exceeds `p_target_count` (default 150) after the primary pass,
fall through to pure embedding-cosine greedy merge in ascending
cosine-distance order, refusing to merge pairs with cosine below
`p_cap_cosine_floor` (default 0.60). This guards against a
diverse-but-overflowing pool where no pair meets the co-firing
bar but the count is still growing without bound.

**Per-call cap.** `p_max_collapses` (default 20) bounds work per
invocation. The background dedup phase calls the RPC each
rotation; a genuinely over-populated pool drains across many
cycles rather than one giant transaction. The manual "Collapse
redundant" button in the diagnostics modal is the same RPC; click
repeatedly to drain further.

**Winner selection.** Always the older row, matching the
mint-tier1 dedup-reinforce semantics. Fires, provenance, and
counters fold into the winner via the private
`_samskara_merge_pair(winner, loser, user)` helper; the loser is
deleted.

Spirit note: co-firing as the primary signal maps onto Hebbian
binding - habits that reliably co-activate consolidate into one
habit, regardless of how similar their descriptions sound. Text
embedding becomes a sanity floor, not the primary gate.

### Tier-2 detection formula

`samskara_tier2_candidate` returns at most one co-fire
constellation per call. The eligible edge set is the tier-1
co-fire self-join, filtered:

```text
eligible(A, B) when:
  cofires(A, B) >= p_min_cofires             -- default 4
  p_cosine_lo <= cosine(embed_A, embed_B)    -- default 0.30
  cosine(embed_A, embed_B) < p_cosine_hi     -- default 0.68 (< dedup floor 0.70)
```

The half-open top end is the whole point: tier-2 only ever
groups pairs whose embedding similarity sits *below* dedup's
merge floor, so it claims the "related but distinct" band dedup
deliberately leaves alone (see the dedup-coupling Gotcha). The
group is the strongest eligible edge plus every node sharing an
eligible edge with BOTH seed members (not either - co-firing
with one seed member is adjacent, not part of the constellation),
strongest combined co-fire first, capped at `p_max_group_size`
(default 6). A group smaller than `p_min_group_size` (default 3)
is rejected - a 2-member group is a dedup candidate, not a
compound. Finally the coverage skip: if any existing tier-2's
child-set overlaps the candidate by Jaccard >= `p_overlap_skip`
(default 0.60), return empty. A cheap precondition (at least 8
tier-1 samskaras with `fire_count > 0`) gates the whole thing
before the expensive self-join runs.

Per-member `cofire_weight` (summed co-fire count of that
member's in-group edges) rides back on the result and becomes
the provenance `weight`.

### Compound-regen trigger

```text
should_regen =
  last_regen_at is null and samskara_count > 0
  or (now() - last_regen_at) > 6 hours
  or (samskara_count - samskara_count_at_regen)
       >= greatest(3, ceil(5 * log10(samskara_count + 10)))
```

Hybrid time + event with log10 dampening on the event-count
side so a chatty user doesn't thrash regeneration as the corpus
grows. The log10 shows up again on the input-cap side when the
summarizer reads samskaras to feed the agent.

## Interactions with other features

- **Chat** - the chat loop is the only synchronous reader of
  samskara state. `runChatLoop` reads compound + fire at
  round-1 entry (under a 1500ms race) and writes a substrate
  stub at end-of-turn. The `buildSystemPrompt` change adds
  `promptAppendix` to its options struct; samskara is currently
  the only caller. `Chat.svelte` mounts the single
  `<SamskaraToasts />` component that listens for mint events.
  See `./chat.md`.
- **Embeddings** - `samskara-substrate` registers as a third
  source in the embeddings backfill alongside memories
  and threads. Pure embed work; no LLM calls on that path. The
  backfill's round-robin handles it automatically. See
  `./embeddings.md`.
- **Memory** - distinct system. Memories are facts the
  user/assistant chose to commit; samskaras are emergent
  predictive bias the model formed on its own. No data flows
  between them. The reflection agent reads thread transcripts
  and writes memories; the samskara assimilator reads
  individual exchanges and writes substrate. Separate workers
  with separate leases. See `./memory.md`.
- **Bias profile** - sibling background worker, no data flow.
  Bias profile aggregates cognitive-bias observations across
  conversations into a per-turn system-prompt section;
  samskara aggregates emergent predictive claims into the
  compound summary `<think>` block. Both ride in every turn
  but in different parts of the prompt - bias at the end of
  the baseline system prompt, samskara as a `<think>` block
  after the user turn - so they don't conflict. Both use the
  LeaseCoordinator pattern with separate `worker_kind`
  partitions. See `./bias-profile.md`.
- **Reflection / summary workers** - peer workers, separate
  `worker_kind` values, separate leases. Samskara assimilation
  looks at one exchange at a time and writes substrate;
  reflection looks at settled threads end-to-end and writes
  memories; summary produces thread-level prose. Three
  different granularities, three different stores.
- **Tools** - none. Samskara is intentionally not exposed as a
  tool (no `samskara_search`, no `samskara_invalidate`). It's
  an autonomic system; if the user wants to forget something,
  the recourse is a manual Supabase edit. Keeping it off the
  tool surface keeps the model from reasoning about its own
  bias as a thing it can game.
- **Settings** - no samskara controls in v1 (no enable/disable,
  no thresholds, no vocab knobs). The system is on or it's
  removed; no middle ground.
- **Auth-session** - same as every worker. The samskara worker
  requires a live session; `lock()` releases the lease.
- **Logging** - the formation worker emits `log` and
  `progress` messages on every cycle; `SamskaraManager` routes
  them through `console.*`, which flows into the in-app log
  drawer. Deep visibility into what the worker is doing lives
  there, not in any UI chrome.

## Gotchas

- **No health threshold at fire time.** The instinct is to
  filter out samskaras with `health < X` from the fire query;
  that defeats the design. Three near-dead samskaras co-firing
  is exactly the signal we want to surface, because cohort
  reinforcement can pull them back from the brink and the
  formation worker can mint a tier-2 compound from the cohort
  later. The fire RPC ranks by `cosine^1.3 * sqrt(health *
  confidence) * (1 + 0.1 * ln(1 + N))` so weak-but-relevant
  samskaras break through (the 1.3 power on the cosine factor
  is a relevance nudge, not a threshold - matches still rank
  smoothly down toward zero). The token budget in
  `formatPriming` is what bounds the long tail, not a SQL
  filter.
- **Two injection mechanisms, both always-on.** The compound
  prose summary captures stable bias across every turn; the
  per-turn cosine fire surfaces situational bias. Either one
  alone is wrong. Future contributors will be tempted to
  consolidate them; resist.
- **`samskara_fires` is unique on (user, cohort, samskara).**
  The constraint exists because `_samskara_merge_pair` retargets
  loser-fires onto the winner, and if the winner already had a
  fire in the same cohort, a naive UPDATE creates a duplicate
  row with a different score (the original loser's cosine to the
  query). The merge helper drops colliding loser-fires before
  retargeting; the constraint is belt-and-braces. The diagnostics
  modal's clustered-by-theme view assumes one fire per (cohort,
  samskara) — duplicates show up there as identical-looking
  expanded siblings under one cluster. If you ever see that
  symptom return, look at the merge helper, not the cluster
  RPC.
- **Priming is raced, not awaited without a timeout.** The
  chat-loop wraps the `Promise.all` of compound + fire in a
  `Promise.race` against `SAMSKARA_PRIMING_TIMEOUT_MS`
  (1500ms). The underlying Promises keep running on timeout so
  `samskara_record_fires` can still land - but the appendix for
  that round goes empty. A cohort logged but never primed will
  never be reaction-classified (the assistant wasn't actually
  shaped by it); such cohorts age out via the resolution
  window. Not an error; intentional.
- **Samskara helpers never fail a chat turn.** All three
  chat-loop entry points (`getCompoundSummary`,
  `fireSamskaras`, `recordSubstrateStub`) wrap their Supabase
  and Venice calls in try-catch and return null/void on
  failure. This is load-bearing: supabase-js re-throws raw
  fetch TypeErrors on network blips rather than returning them
  in the `{ error }` envelope, and without the swallow a
  transient offline moment would paint "Failed to fetch" into
  the error bar.
- **`shape_signature`-style dedup is intentionally absent.**
  Scratch uses a sign-quantized SHA-256 of the embedding to
  dedupe attachments across projects; nak is single-user PWA
  with no cross-project surface, so the gymnastics serve no
  purpose. Dedup is the minter agent's job via its
  `confirm: false` escape hatch.
- **Cohort fires get sqrt-N reinforcement, not full +1 each.**
  A 5-strong cohort all confirming contributes ~2.24 total
  confirm-count, not 5. Prevents large cohorts from dominating
  single-fire signal; revisit the formula if cohort dynamics
  misbehave.
- **Compound-regen has log10 dampening in two places** - on
  the event-count threshold of the regen trigger, and on the
  samskara-inclusion cap feeding the summary. Both use
  `log10(N + 10)` so a fresh user with N=0 still lands on a
  sensible value.
- **Postgres `log(x)` is base-10, not natural log.** Cross-
  checking `samskara_should_regen_compound` against the
  worker's `Math.log10` is confusing if you're used to JS/C
  where `log` means natural. Natural log in Postgres is
  `ln(x)`; `log(x)` is `log10(x)`; `log(b, x)` is arbitrary
  base. The inline comment on the threshold formula names this
  explicitly so a reviewer doesn't mis-flag it as inconsistent
  with the TS side.
- **Reaction classification reads the user's NEXT message.**
  Fires happen on turn T's user input; classification runs on
  turn T+1's user input (responding to the assistant's turn-T
  reply). 10-minute resolution window - fires older than that
  age out via decay rather than being force-classified by
  stale signal.
- **`samskara_record_fires` thread-ownership guard is silent-
  skip.** The RPC verifies the supplied `thread_id` belongs to
  `auth.uid()` before inserting fire rows (RLS hides reads but
  doesn't constrain the insert once `user_id` is trusted). On
  a mismatch it returns early without raising, matching the
  pattern of `mark_thread_reflected_if_claimed` and
  `save_thread_summary_if_claimed`. A bug calling this with
  the wrong thread_id therefore does nothing, rather than
  surfacing a Postgrest exception through the chat loop.
- **Rate-limit propagates through the agent contract.**
  `SamskaraAgent` methods re-throw `VeniceError` with
  `kind='rate_limit'` rather than swallowing to null, so the
  loop's try-catch in `runOneCycle` can map them to the
  `'rate-limited'` cycle result (60s back-off). Other Venice
  failures still return null and fall to the short error
  back-off (15s). Without this distinction the long back-off
  path would be unreachable.
- **Tier-2 detection and dedup read the same co-fire self-join
  and must not overlap.** `samskara_tier2_candidate` and
  `samskara_collapse_by_cofiring` both self-join `samskara_fires`
  on `cohort_id`, but they are opposites: dedup MERGES pairs that
  are the same claim (high co-fire AND embedding cosine >= its
  `p_cosine_floor` 0.70, loser deleted); tier-2 GROUPS claims that
  co-activate but stay distinct (high co-fire, cosine strictly
  below that floor, parent added). The tier-2 cosine band
  `[p_cosine_lo, p_cosine_hi)` defaults to `[0.30, 0.68)` - its
  top end sits below dedup's floor on purpose. If you raise
  `p_cosine_hi` to or past 0.70 the two phases fight over the same
  pairs (dedup deleting what tier-2 just grouped); the symptom is
  tier-2 rows that keep vanishing a cycle after they mint. Keep
  the band below the floor.
- **Tier-2 re-mint storm without the coverage skip.** Once a
  tier-2 covers a constellation, that group still co-fires every
  cycle, so detection would re-surface it forever. Two guards stop
  the loop: `samskara_tier2_candidate`'s Jaccard `p_overlap_skip`
  (skip a group an existing tier-2's child-set already covers) and
  the mint phase's tier-scoped embedding dedup (reinforce the
  nearest existing tier-2 instead of inserting when cosine >=
  `MINT_DEDUP_COSINE`). The first catches the same-children case,
  the second a different child set the agent synthesized into the
  same claim. Neither is optional.
- **Tier-2 rides the unchanged hot path; orphans are fine.**
  `samskara_fire_top_k`, `samskara_apply_reaction`, and
  `samskara_decay` have no tier filter, so a tier-2 fires, gets
  confirmed/disconfirmed, and decays exactly like a tier-1 the
  moment it exists - no chat-loop or UI change was needed to ship
  it. Because provenance has no FK on `ref_id`, a tier-2 whose
  children dedup later merges or deletes simply keeps standing on
  its own embedding and fire history. That is intended - a
  compound that earned its confidence does not need its
  scaffolding. The `tier in (1, 2)` check on `samskaras` is
  load-bearing; lifting it to tier-3+ (a compound-of-compounds
  noise amplifier) should be a deliberate design change, not an
  oversight.
- **Pair-relate uses a naive seed-most-recent approach.**
  One pair per cycle: seed on the most recent embedded
  substrate row, pick its closest neighbour by cosine in JS,
  call the relator once. Good enough at substrate-corpus
  scale; expect to replace with a smarter multi-pair sampler
  once the corpus grows past a few hundred rows per user.
- **Writes that bypass the RPC boundary.** Pair-relate's
  association upsert and tier-1 mint's samskara insert +
  provenance upsert use the raw Supabase client rather than an
  RPC. RLS still enforces row access, but future policy that
  wants to encapsulate those writes (soft-uniqueness, merge
  jobs) should wrap them in RPCs first.
- **`samskara_compound_summary.summary` is NULL on cold start
  and can be NULL after a stale-ceiling trip.** The chat-loop
  reader (`getCompoundSummary`) handles both by returning null,
  and the formatter renders no calibration section when null.
  Don't add a "(no summary yet)" placeholder - that's a tell
  the user would reason about.
- **Eventual consistency is the contract.** The user can send
  a message before the assimilator has caught up, before
  reaction classification has run, before the next regen has
  fired. None of this is an error: the chat loop reads
  whatever's currently in the database and proceeds. If the
  formation worker is hours behind, the model just operates on
  staler bias.
- **The CONVERSATION is opaque; the operator is not.** The
  "almost-opaque to the user" principle protects two things: the
  in-chat experience (no prediction text leaks inline - the only
  chat-surface cue is the bottom-right mood pill, one valence-mapped
  emoji per mint) and the model itself (no samskara tool, so it can't
  reason about or game its own bias). Both targets are about the
  conversation. They do NOT forbid a deliberately-opened, read-only
  operator surface - that's the same category as the Logs drawer. nak
  is single-user; the person who opens such a surface is the operator
  inspecting their own system, not a chat subject being shown their
  bias model mid-conversation. So prediction text appears in the
  cohort dropdown and the Samskara diagnostics tab (below) - both
  operator surfaces - while the chat stays mood-pill-only. When you
  touch this, keep the line crisp: nothing in
  an operator surface may bleed prediction text into the chat
  transcript or hand the model a way to read its own corpus.

## Observability tab

A first-class drawer tab (sibling to chats/memories/wiki/recipes,
`drawer=samskara`) is the operator's read-only window into the
pipeline. It replaced the old `route.modal='samskara'` diagnostics
modal entirely. Three sub-views:

- **Corpus** - browse/search/filter/sort the samskara corpus, with a
  tier filter and a "hide similar" cosine slider (the corpus analog of
  the cohort dropdown's cluster slider). Selecting a row shows its
  detail + provenance; for a tier-2 the provenance is its tier-1
  children. Backed by `listSamskarasPage`,
  `searchSamskarasByEmbedding` / `searchSamskarasByText`,
  `samskara_cluster_corpus`, and `samskara_provenance_detail`.
  Pieces: `src/screens/Samskaras.svelte`,
  `src/components/SamskaraBrowseList.svelte`,
  `src/lib/samskara-browse-store.svelte.ts`,
  `src/lib/ui/samskara-browse.ts`.
- **Health** - silent-failure detection computed live (no stored
  history): backlog depths, fires aged out unresolved, worker-lease
  liveness, compound-summary staleness, orphan fires / stuck claims,
  and windowed mint/fire/resolution rates. Backed by
  `samskara_health_snapshot`, `samskara_rates`, the `worker_leases`
  read, and the severity thresholds in `src/lib/ui/samskara-browse.ts`
  (named constants, tune against observed behaviour). Piece:
  `src/components/SamskaraHealthPanel.svelte`.

- **Summary & mood** - the always-on compound summary block plus the
  `(valence x confidence) -> emoji` mood legend, moved verbatim out of
  the retired modal. The bottom-right mood pill deep-links straight
  here (via the shared `samskaraView.sub` state in the browse store) so
  "what did that emoji mean" still has a home. Pieces:
  `src/components/SamskaraMoodLegend.svelte` + the compound fetch in
  `Samskaras.svelte`.

Read-only by design - no delete/pin/edit. Curation would re-open the
"operator games the bias model" question; if it's ever wanted it's a
deliberate separate decision. The modal's manual "Consolidate" and
"Copy snapshot" buttons were build-time scaffolding from the original
samskara work - never intended as permanent operator features - so they
were intentionally not migrated. Dedup runs automatically in the
worker's dedup phase every rotation regardless.

Search ranks by plain cosine (`samskara_search_by_prediction`), NOT
the `samskara_fire_top_k` formula - browse wants closest-to-query, not
most-likely-to-fire, so health/confidence are deliberately left out of
the ranking.

## Where to go next

- `./chat.md` - the seam where samskara plugs into the per-turn
  flow.
- `./embeddings.md` - the worker pattern the substrate source
  mirrors.
- `./memory.md` - the closest sibling system; useful for
  understanding why samskara is structured differently
  (emergent vs declared, opaque vs user-facing, autonomic vs
  tool-driven).
- `./logging.md` - where the worker's `log` messages surface
  for debugging.
- `./architecture.md` - the worker model in context.
