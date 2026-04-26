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
clusters, classifying reactions, decaying stale or disconfirmed
samskaras, regenerating the compound summary - runs in a
dedicated background worker between user messages. The worker
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
  (rune-free). Defines `SAMSKARA_MINT_EVENT`,
  `valenceToEmoji`, and `notifySamskaraMint` for the
  worker-manager handoff. Separate from the Svelte component so
  the manager can import without pulling Svelte runtime into
  the worker bundle.
- `src/components/SamskaraToasts.svelte` - the persistent
  mood-pill UI. Listens for `SAMSKARA_MINT_EVENT` on `window`,
  renders the latest mint's emoji as a fixed pill in the
  top-right corner, and stays visible until the next mint (or a
  thread switch) so the user can connect the glyph to whatever
  it reacted to. Click opens the Samskara diagnostics modal.
  Mounted once in `Chat.svelte`.
- `src/lib/embeddings/sources/samskara-substrate.ts` - registered
  with the embeddings worker as a third source alongside
  memories and threads. Polls `samskara_substrate where
  situation_embedding is null and situation is not null`, embeds
  via Venice, saves under a guard. Mirrors the memories source
  exactly.
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
  mint-tier1, mint-tier2 [stubbed], reaction-classify, decay,
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
  claim/save, decay, co-firing-based dedup collapse, and the
  three compound-regen coordinators. A private
  `_samskara_merge_pair(winner, loser, user)` helper backs the
  dedup RPC; underscore-prefixed to signal internal-only. Follows
  the project's idempotent-apply conventions (`if not exists`,
  drop-then-create for policies and functions).

## Entry points

- **`runChatLoop` round-1 entry** - in `src/lib/chat-loop.ts`,
  before the first round's `requestMessages` is assembled, the
  loop races `getCompoundSummary(supabase)` and
  `fireSamskaras(supabase, venice, threadId, userText, signal)`
  in parallel under a `SAMSKARA_PRIMING_TIMEOUT_MS` (1500ms)
  cap. The resulting appendix is passed into
  `buildSystemPrompt({ promptAppendix })` so every round this
  turn sees the same compound + fire signal (one cohort id per
  user turn, not per round). Underlying Promises keep running
  on timeout; the worst case is one cohort logged but never
  reaction-classified, which the worker's resolution-window
  drops naturally.
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
- **Embeddings worker cycle** - the existing worker's
  round-robin picks up the `samskara-substrate` source
  automatically. No samskara-specific entry point on that side;
  the source adapter implements the same `EmbeddingSource`
  contract memories and threads do.
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
  embeddings worker fills it from the enriched `situation`
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
2 is minted from cohort-fire patterns of tier-1 samskaras
(currently a stub, see Gotchas). Cap is `tier in (1, 2)` - no
tier 3.

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
  provenance; tier-2 samskaras would carry `'samskara'`
  provenance pointing at their tier-1 children (schema ready;
  the tier-2 mint phase itself is stubbed).

### `samskara_fires`

One row per samskara fired per turn. Drives reaction
reinforcement and cohort detection.

- `id`, `user_id`, `samskara_id` (FK on cascade), `thread_id`,
  `cohort_id uuid not null`, `fired_at`, `score real not null`,
  `was_confirmed boolean`.
- `cohort_id` is shared across the set of samskaras fired
  together on the same turn, generated client-side when the
  chat loop assembles the fire. Lets the reaction classifier
  and (eventually) the tier-2 mint phase operate on the cohort
  as a unit.
- `score` is the ranking score at fire time, kept for
  analytics.
- `was_confirmed` starts NULL, set to true/false by the
  reaction classifier on the next user turn. Older unresolved
  fires age out via decay rather than being force-classified by
  stale signal.
- Partial index on `(user_id, thread_id, fired_at desc) where
  was_confirmed is null` targets the reaction-classify poll.

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
embeddings worker's claim -> process -> save shape. Phase
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
  background dedup phase runs each rotation (see below); the
  diagnostics modal exposes it as a "Consolidate" button for
  on-demand triggering. Idempotent.
- **Mint-tier2** - stubbed for v1. Returns `'empty-phase'` so
  the rotation drains past it cheaply. Schema and provenance
  `kind='samskara'` support it; real cohort patterns need to
  exist first before the implementation is useful to test.
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
score = (1 - cosine_distance)
      * sqrt(max(health * confidence, 0))
      * (1 + 0.1 * ln(1 + confirm_count + disconfirm_count))
```

The first term is cosine similarity. The sqrt term softens
both the confidence and health axes so a strong-but-distant
samskara can't crush a weak-but-relevant one. The ln term is a
sample-size bonus: two samskaras with identical confidence but
different sample sizes (4/5 vs 80/100 confirms) rank by sample
size when cosine and health are close. Caps at ~1.46x for
N=100; a brand-new samskara at N=0 still ranks normally so it
can fire and accumulate signal.

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
  source in the existing embeddings worker alongside memories
  and threads. Pure embed work; no LLM calls on that path. The
  worker's round-robin handles it automatically. See
  `./embeddings.md`.
- **Memory** - distinct system. Memories are facts the
  user/assistant chose to commit; samskaras are emergent
  predictive bias the model formed on its own. No data flows
  between them. The reflection agent reads thread transcripts
  and writes memories; the samskara assimilator reads
  individual exchanges and writes substrate. Separate workers
  with separate leases. See `./memory.md`.
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
  later. The fire RPC ranks by `cosine * sqrt(health *
  confidence) * (1 + 0.1 * ln(1 + N))` so weak-but-relevant
  samskaras break through. The token budget in `formatPriming`
  is what bounds the long tail, not a SQL filter.
- **Two injection mechanisms, both always-on.** The compound
  prose summary captures stable bias across every turn; the
  per-turn cosine fire surfaces situational bias. Either one
  alone is wrong. Future contributors will be tempted to
  consolidate them; resist.
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
- **Tier-2 mint is a stub.** `runMintTier2Phase` currently
  returns `'empty-phase'`; the phase is in the rotation so the
  wiring exists, but no real cohort-of-cohorts minting
  happens. Schema and provenance `kind='samskara'` already
  support it. The `tier in (1, 2)` check on `samskaras` is
  load-bearing; lifting it to tier-3+ should be a deliberate
  design change, not an oversight.
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
- **Samskara is almost-opaque to the user.** The only UI
  surface is the top-right toast stack showing one valence-
  mapped emoji per mint. No prediction text leaks; showing it
  would invite the user to reason about their own bias model
  and collapses the "absorption over disclaimer" framing. Deep
  visibility remains log-only (every fire with score/cohort,
  every mint, every reaction decision, every decay event) -
  the toasts are a glance cue, not a debugging surface. Keep
  the logs dense and stable.

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
