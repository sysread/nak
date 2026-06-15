# Samskara

The chat model's progressively-built predictive model of the
user. Per-round observations (substrate) compound through a
server-side formation pipeline into emergent predictive claims
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
compound summary - runs server-side. The formation pipeline
lives in the venice edge function
(`supabase/functions/venice/agents/samskara.ts`), driven by the
completed-turn tail and an hourly cron sweep; decay rides its
own pg_cron job. Every LLM phase uses the hardcoded
`SAMSKARA_MODEL` (mistral-small). No tab needs to stay open.
Async-friendly: nak chat is SMS-shaped (the user can wander off
for an hour and come back), so formation has time to catch up
between turns without blocking anything.

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
  the cut). Kept rune-free on purpose - plain TS that components
  and non-Svelte modules can both import.
  `SamskaraMoodLegend.svelte` (mounted in the conversation-mood modal,
  `SamskaraMood.svelte`) renders the same `MOOD_TABLE` as a fold-away
  legend so the user-visible documentation can never drift from the live
  mapping.
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
  `events.ts` because `events.ts` stays rune-free plain TS and
  the shared mood triple needs `$state`.
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
  null. Click opens the conversation-mood modal (`SamskaraMood.svelte`)
  regardless of state - the mood is per-conversation, so it is a modal,
  not part of the corpus-global tab. Mounted once in `Chat.svelte`. Composition
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
- `supabase/functions/venice/agents/samskara.ts` - the formation
  pipeline. The six agent prompts (`ASSIMILATOR_PROMPT`,
  `RELATOR_PROMPT`, `MINTER_PROMPT`, `TIER2_MINTER_PROMPT`,
  `REACTION_PROMPT`, `COMPOUND_SUMMARY_PROMPT` - terse on
  purpose: the fast tier pays tokens for inputs, not
  instructions), one non-streaming `toolComplete` call per
  phase, the math helpers (`cosine`, `buildTopicalCluster`,
  `parseVector`) and tuning constants, and the two exported
  drivers: `samskaraOnTurnTail(admin, userId)` for the
  completed-turn tail and `runSamskaraSweepTick(admin)` for the
  hourly cron sweep (see Entry points). Prompts and constants
  are pinned by the Deno suite at
  `supabase/functions/tests/samskara.test.ts` via the `__test`
  namespace export.
- `supabase/schema.sql` (samskara section) - six tables with
  RLS and the RPC surface covering fire, cohort log, reaction
  apply, substrate record, assimilate claim/save, substrate-embed
  claim/save, the cron-driven decay sweep, co-firing-based
  dedup collapse,
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
  dedup RPC; underscore-prefixed to signal internal-only. The
  formation RPCs all carry a b-strict trailing `p_user_id uuid
  default null` parameter (`coalesce(p_user_id, auth.uid())`) so
  the edge drivers' service-role client can scope them
  explicitly while RLS-scoped callers keep working unchanged.
  Two service_role-only `security definer` functions back the
  sweep: `samskara_claim_next_assimilate_for_sweep` (cross-user
  queue claim returning `user_id`) and `samskara_sweep_users`
  (users with substrate/fire activity inside a lookback window).
  `nak_trigger_samskara_sweep()` + the `nak-samskara-sweep`
  pg_cron job (`23 * * * *`) drive the sweep route, and
  `samskaras` is a member of the `supabase_realtime` publication
  so mint INSERTs reach the browser (the toast signal). Follows
  the project's idempotent-apply conventions (`if not exists`,
  drop-then-create for policies and functions).

## Entry points

- **`runChatLoop` round-1 entry** - in `src/lib/chat-loop.ts`,
  before the first round's `requestMessages` is assembled, the
  loop races `getCompoundSummary(supabase)` and
  `fireSamskaras(supabase, threadId, currentUserRound,
  userText, signal)` in parallel under a
  `SAMSKARA_PRIMING_TIMEOUT_MS` (1500ms) cap. `currentUserRound`
  is hoisted up to fire time from `countUserRounds(history)` so
  each cohort row carries the user-message index it anchors to.
  The resulting appendix is passed into `buildSystemPrompt({
  promptAppendix })` so every round this turn sees the same
  compound + fire signal (one cohort id per user turn, not per
  round). Underlying Promises keep running on timeout; the
  worst case is one cohort logged but never reaction-classified,
  which the classifier's resolution window drops naturally.
- **Inline `CohortPanel` in `Chat.svelte`** - on thread load,
  `Chat.svelte` calls `samskaraListFiresForThread`,
  `samskaraListSubstrateForThread`, and
  `samskaraClusterThreadFires` once. Fires group by
  `user_round`, substrate joins on `user_message_id`. Each user
  message in the transcript gets a pulse-icon toggle in its
  action row; click it to expand a `CohortPanel` anchored to
  that turn. End-of-turn the loader is invoked again so the
  just-fired cohort appears under its triggering message
  without a manual refresh. Cohort fires + substrate for one
  round are exclusively the inline panel's domain - neither the
  Samskara tab nor the mood modal carries per-message detail.
- **`runChatLoop` end of turn** - after the terminal assistant
  row persists, the loop calls
  `recordSubstrateStub(supabase, threadId, userMessageId,
  assistantMessageId)` as a fire-and-forget write. The
  assimilator phase enriches the stub later; this call does no
  LLM work.
- **`samskaraOnTurnTail(admin, userId)`** - fired from
  `getStreamingResponse`'s `EdgeRuntime.waitUntil` tail on
  completed turns, sequenced curation -> samskara -> reflection.
  Samskara runs before reflection because reflection can span
  minutes and samskara carries the fleet's only hard timing
  window (the reaction-classify resolution window). Runs
  reaction-classify first, then a capped assimilate drain, then
  one pair-relate probe, then one mint-tier1 probe.
- **`runSamskaraSweepTick(admin)`** - the hourly
  `nak-samskara-sweep` pg_cron job (`23 * * * *`) pg_net-POSTs
  `/venice/samskara-sweep` (a `sweepHandler` route, service-role
  gated). Drains the cross-user assimilate queue, then runs the
  per-user maintenance probes (pair-relate, mint-tier1,
  mint-tier2, dedup, compound-regen) for every user with recent
  samskara activity. The catch-up driver, and the only driver
  for the heavy timing-insensitive phases.
- **Embeddings backfill** - the server-side backfill's round-robin
  picks up the `samskara-substrate` source automatically. No
  samskara-specific entry point on that side; the `EMBED_SOURCES`
  registry entry shapes the same claim/build/save flow memories and
  threads do.
- **Mint relay** - the INSERT into `samskaras` is itself the
  toast notification. `Chat.svelte` subscribes to user-filtered
  postgres_changes INSERTs via
  `SupabaseService.subscribeToSamskaraInserts` and routes the new
  row's `(tier, valence, confidence)` into `notifySamskaraMint`,
  which dispatches `SAMSKARA_MINT_EVENT` on `window`; the
  `SamskaraToasts` component mounted inside `Chat.svelte` listens
  for it and renders the valence-mapped emoji pill. INSERT-only
  by design: dedup-reinforce hits update an existing row and
  therefore stay silent.

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
  null and situation is not null` keep the claim queries cheap
  as the substrate table grows.

### `samskara_associations`

Pair-labels between substrate rows, written by the relator
phase.

- `id`, `user_id`, `a_id`, `b_id` (FKs into substrate on
  cascade).
- `articulated_relation text not null` - the relator agent's
  short label.
- `kind text check in ('pattern', 'contrast', 'prerequisite',
  'consequence')` - the relator's taxonomy. The fifth scratch
  category `'orthogonal'` is not an association; orthogonal
  verdicts are recorded in `samskara_pair_declines` so the
  probe never re-asks the pair.
- `reinforcement integer default 1` - bumped by the
  `samskara_associate` RPC's conflict clause when the same
  pair+label is written again. Re-encounters are rare by design
  (the probe skips adjudicated pairs), so in practice this only
  increments when the turn-tail and sweep drivers race the same
  fresh pair.
- `minted_at timestamptz` - consumption stamp for the
  association-mint probe (see Mint phases). NULL until the edge
  has been fed to the tier-1 minter; set on mint, dedup-hit, OR
  decline alike. A stamped edge leaves the candidate pool
  permanently (substrate is immutable, so its evidence can't
  change); fresh corroboration re-opens a pattern as NEW
  unstamped edges. Per-edge, never per-hub.
- `last_reinforced_at`, `created_at` timestamps.

(The old `relation_embedding vector(2048)` column - reserved for
label-level clustering and never populated or read - was dropped
when association-mint landed. Re-add via one guarded ALTER if
label-clustering is ever built; see the association-mint plan.)

All accept-writes go through `samskara_associate` (security
definer, service_role-only): PostgREST upserts can only SET
conflict columns to payload values, so the reinforcement
increment has to live in SQL. The consumption stamp is a plain
service-role `UPDATE ... set minted_at` from the probe.

### `samskara_pair_declines`

Permanent ledger of relator "orthogonal" verdicts, keyed
`(user_id, a_id, b_id)` with the pair in canonical order
(`a_id < b_id`, same convention as associations). Substrate
rows are immutable once assimilated, so a verdict is permanent -
no TTL, no re-asks. The pair-relate probe unions this table
with `samskara_associations` to build the adjudicated set it
skips during candidate selection; once every pair in the window
is adjudicated, the probe returns without a Venice call.
Select-only RLS for the owner; writes come exclusively from the
service-role client.

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
- `fire_count int`; `confirm_count real`, `disconfirm_count
  real` (fractional by design - reactions add `1/sqrt(cohort_N)`,
  which an int column would truncate to 0; see Gotchas);
  `last_fired_at`, `created_at`, `updated_at`.
- Indexes on `(user_id, tier)` and `(user_id, health desc,
  confidence desc)`.

### `samskara_provenance`

Audit trail for what each samskara was minted FROM - its
formation cluster, not its later reinforcement history. Kept
even if the underlying substrate or association is deleted (no
FK on `ref_id`); debugging beats normalisation.

- `samskara_id` (FK on cascade), `user_id`, `kind text check in
  ('substrate', 'association', 'samskara')`, `ref_id uuid`,
  `weight real default 1.0`.
- Primary key `(samskara_id, kind, ref_id)`.
- Tier-1 samskaras carry `'substrate'` provenance always, plus
  `'association'` provenance when minted from the association
  graph (the association-mint path - those rows carry BOTH kinds,
  the only mixed-provenance case, `weight` = the edge's
  reinforcement snapshot at consumption time). Tier-2 samskaras
  carry `'samskara'` provenance pointing at their tier-1
  children, `weight` = each child's in-group co-fire count.
- Records the mint-time topical cluster only. Dedup-reinforce
  (`samskara_reinforce_existing`) deliberately does NOT append
  provenance: appending the recency batch on every re-observation
  grew the list without bound (200+ rows, mostly temporally-
  adjacent bystanders) and buried the formation evidence. A
  merge (`_samskara_merge_pair`) still copies the loser's
  provenance to the winner - that's a second samskara's genuine
  formation evidence, not a re-observation.

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

## Contracts

### Chat-loop side (synchronous, no LLM)

- `getCompoundSummary(supabase): Promise<string | null>` -
  reads the cache row. Returns null on cold start (no row yet
  or `summary` is null/empty) and when `last_regen_at` is older
  than `STALE_CEILING_HOURS` (24h). Network errors are
  swallowed and surface as null so a transient offline moment
  doesn't propagate into the chat-loop's error path.
- `fireSamskaras(supabase, threadId, userRound, userText,
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
  `valence` / `situation_embedding` all null; the formation
  pipeline fills them. Errors swallowed; fire-and-forget.
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

### Formation side (edge function, fast-model agent calls)

Each phase is a one-row-at-a-time probe that mirrors the
embeddings backfill's claim -> process -> save shape. Two
drivers run the phases, split by timing sensitivity:

- **Turn tail** (`samskaraOnTurnTail`) - reaction-classify
  first (the only hard timing window in the loop), then an
  assimilate drain capped at `TAIL_ASSIMILATE_CAP` (3) so the
  chain never delays reflection behind it, then one pair-relate
  probe, then one mint-tier1 probe (the in-session toast
  surface).
- **Hourly sweep** (`runSamskaraSweepTick`) - a cross-user
  assimilate drain capped at `SWEEP_ASSIMILATE_CAP` (10) via
  the definer claim `samskara_claim_next_assimilate_for_sweep`,
  then for every user with recent activity
  (`samskara_sweep_users`, a 2h window of substrate or fires)
  the pair-relate, mint-tier1, mint-tier2, dedup, and
  compound-regen probes.

Mint-tier2, dedup, and compound-regen are cron-only: the tier-2
detection self-join is the heaviest query in the feature, dedup
is population maintenance, and the compound summary tolerates a
day of staleness in the priming block. Reaction-classify is
tail-only: classification needs the next user message, which
implies a turn, which implies the tail already ran at the right
moment - an hourly tick misses the 1-10 minute resolution window
by construction.

There are no per-phase throttles. One trigger runs one rotation,
so the trigger cadence (turn or tick) IS the rate limit -
nothing rotates continuously. A Venice rate-limit re-throws out
of any phase and abandons the rest of the rotation (the next
turn or tick retries with fresh budget); any other phase failure
logs and yields to the next phase.

- **Assimilate** - `agentAssimilate(apiKey, userMsg,
  assistantMsg) -> {situation, outcome, valence} | null`. Reads
  the raw exchange, returns structured substrate fields. Claim
  RPC `samskara_claim_next_assimilate` (per-user, tail) or
  `samskara_claim_next_assimilate_for_sweep` (cross-user,
  sweep); save RPC `samskara_save_assimilation_if_claimed`. Cap
  hits are logged, never silently truncated - the next trigger
  continues the drain.
- **Pair-relate** - `agentRelate(apiKey, a, b) -> {kind, label}
  | null`. The phase reads recent embedded substrate, seeds on
  the most recent row, finds its closest embedded neighbour by
  cosine in JS, and calls the relator agent. v1 uses that naive
  "seed = most recent" approach; one pair per probe keeps the
  LLM call rate bounded. Orthogonal verdicts skip the write.
  Associations are upserted via a direct
  `admin.from('samskara_associations').upsert(...)` with
  `onConflict` on the unique key and an explicit `user_id`
  (the column default is `auth.uid()`, NULL under the service
  role), not an RPC. The JS-cosine here depends on the module's
  `parseVector` turning PostgREST's pgvector text form into a
  real array; see the embeddings gotcha below.
- **Mint-tier1** - `agentMint(apiKey, MINTER_PROMPT,
  {sample_labels, sample_situations, reinforcement}) ->
  {prediction, inner_voice, valence, confidence} | null` (null
  covers both parse failure and an explicit `confirm: false`
  refusal). The
  phase fetches the recent embedded substrate window, then
  builds a **topical cluster**: it seeds on the most recent row
  and keeps only the later rows whose situation embedding is
  within `MINT_CLUSTER_COSINE_FLOOR` (0.6) of the seed, capped
  at `MINT_CLUSTER_MAX` (5). It mints only when the coherent
  cluster reaches `MINT_CLUSTER_MIN` (3); a topic-hopping window
  collapses to a sub-threshold cluster and is skipped rather
  than fused into a cross-topic prediction. The same cluster is
  what the minter sees AND what gets recorded as provenance, so
  provenance names the rows that actually share the claim's
  topic. The agent's `confirm: false` path is a weak first-line
  filter (it refuses clusters it thinks are too thin) but it
  can only see the sample, never the existing samskara corpus,
  so on its own it produces near-duplicate twins of older
  claims as the sample drifts. A second dedup guard runs after
  the prediction is embedded: `samskara_nearest_by_prediction`
  returns the closest existing samskara by cosine on
  `prediction_embedding`; when the similarity exceeds
  `MINT_DEDUP_COSINE` (0.85), the loop calls
  `samskara_reinforce_existing` - nudging health up by
  `MINT_DEDUP_HEALTH_BUMP` (0.02, capped at 1.0), and NOT
  touching provenance - instead of inserting a twin. Only
  genuinely novel predictions fall through to the insert path.
  The minter prompt explicitly invites negative predictions
  ("user tends to NOT do Y") and assistant-behaviour
  predictions ("user expects the assistant to ask before
  suggesting code") alongside the standard positive shape.
  The insert goes through the admin client with an explicit
  `user_id` (the column default is `auth.uid()`, NULL under the
  service role). The INSERT itself is the toast signal: it rides
  the `supabase_realtime` publication to `Chat.svelte`'s
  subscription, which re-emits `SAMSKARA_MINT_EVENT` for the
  mood pill. Dedup-reinforcement inserts nothing and therefore
  toasts nothing - the intended semantics - though it logs so
  the Logs drawer shows "dedup-reinforced existing" breadcrumbs.

  A third tool - `samskara_collapse_by_cofiring(...)` - handles
  ongoing redundancy consolidation. It's the same RPC the
  sweep's dedup probe runs each tick (see below); it has no
  manual UI trigger - dedup runs autonomically. Idempotent.
- **Mint-tier1-assoc** (`mintTier1FromAssociationsProbe`, SWEEP
  ONLY) - mints from the association graph instead of the recency
  window, so cross-session recurrence that no recency window can
  co-locate still reaches the minter. `samskara_association_cluster`
  picks the hub (the substrate row with the most summed
  reinforcement over its UNCONSUMED edges, >= 2 distinct partners)
  and returns ONE representative (highest-reinforcement) edge per
  the hub's top (`MINT_CLUSTER_MAX - 1`) partners. The RPC collapses
  to one edge per (hub, partner) BEFORE ranking, because
  pair-relate's label-in-the-unique-key means a hot pair accrues
  dozens of near-duplicate-labeled edges - without the collapse
  those flood `sample_labels` and skew hub selection toward the
  most-relabeled pair, not the best-connected observation (QA caught
  one hub with 28 edges across 2 partners). `buildAssociationCluster`
  folds those into the minter payload - hub + distinct-partner
  situations as `sample_situations`, the edge labels in the
  otherwise-empty `sample_labels` slot, summed reinforcement as
  the strength hint. Same `agentMint`, embed, and dedup guard as
  Mint-tier1, then provenance = member substrate rows (`weight`
  1.0) PLUS the consumed edges as `'association'` (`weight` =
  reinforcement). **Self-quenching:** every minter verdict - mint,
  dedup-hit, OR decline - stamps the fed edges `minted_at` so a
  stable graph spends one call then goes quiet; only a non-verdict
  (transport/parse/embed failure or a failed insert) leaves them
  unstamped to retry. `agentMint`'s return splits three ways
  (`MintResult | 'declined' | null`) precisely so this probe can
  stamp a clean decline but never stamp a failure. Absent from the
  turn tail on purpose: cross-session consolidation isn't
  latency-sensitive, and keeping it sweep-only holds per-turn
  Venice spend flat.
- **Mint-tier2** - `agentMint(apiKey, TIER2_MINTER_PROMPT,
  {children}) -> {prediction, inner_voice, valence, confidence}
  | null` (same parse, different prompt - the input is finished
  tier-1 claims, not raw situations).
  Detects one recurring co-fire constellation of tier-1 samskaras
  via `samskara_tier2_candidate` (a co-fire group, not a substrate
  cluster), hands the child predictions to the minter agent, and -
  if the agent confirms - inserts a `tier=2` row whose provenance
  points at the children with `kind='samskara'`. Two dedup guards:
  the candidate RPC skips groups an existing tier-2 already covers by
  child-set overlap (same children), and after the compound is
  embedded the loop checks the nearest existing tier-2 by cosine
  (`samskara_nearest_by_prediction` with `p_tier=2`), reinforcing it
  via `samskara_reinforce_existing` (health bump only, no provenance)
  when cosine >= `MINT_DEDUP_COSINE` (0.85) instead of minting a twin
  (the different-children-same-claim case). Cron-only: compound
  patterns form over days and the detection self-join is the
  heaviest query in the feature, so the probe runs once per
  active user per hourly tick, never on the tail. A tier-2
  insert reaches the mood pill through the same realtime relay
  and valence->emoji path as tier-1, so there is no UI
  special-case.
- **Reaction-classify** - `agentClassifyReaction(apiKey, cohort,
  assistantMsg, nextUserMsg) -> {confirm[], disconfirm[],
  neutral[]} | null`. Tail-only. Reads the oldest unresolved
  cohort inside the resolution window (fires aged 1-10 minutes;
  older fires age out via decay), the assistant's reply, and the
  next user message; partitions the cohort into three buckets
  and applies via `samskara_apply_reaction`. There is no neutral
  boolean state: a neutral leaves `was_confirmed` NULL and gets
  `fired_at` backdated 15 minutes, pushing the row out of the
  window so the unresolved poll skips it on subsequent passes.
- **Dedup** - `samskara_collapse_by_cofiring(...)` RPC, no LLM.
  Cron-only.
  Two-pass: a primary co-firing-based pass merges tier-1 pairs
  that reliably activate in the same cohort (Hebbian
  redundancy), and a population-count safety cap falls through
  to pure embedding-cosine greedy merge when the pool still
  exceeds target. Each pass preserves the older row as winner,
  retargets fires + provenance, folds counters, deletes the
  loser. Per-call capped at 20 merges so one RPC never runs
  unboundedly; repeated ticks drain any backlog.
  See the Dedup formula below for parameters and rationale.
- **Compound-regen** - cron-only; three-step dance. First
  `samskara_should_regen_compound()` returns a decision payload
  (cheap). If `should_regen`, try to claim via
  `samskara_claim_compound_regen(holderId, 180s)`. If claimed,
  read the top `max(8, ceil(5 * log10(N + 10)))` samskaras
  ranked by `(health desc, confidence desc)` (a direct
  admin-client table read - no RPC exists for it), call
  `agentSummarizeCompound`, and save via
  `samskara_save_compound_summary_if_claimed`. The 180s claim
  TTL means a failed regen unblocks the slot within 3 minutes
  rather than parking the next tick for 20.

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

Bayesian-ish, inside `samskara_apply_reaction`. `inc` is the
per-reaction increment `max(round(1/sqrt(cohort_N), 2), 0.01)`:

```text
on confirm (per cohort member):
  confirm_count += inc
  confidence = (confirm_count + 2) / (confirm_count + disconfirm_count + 3)
on disconfirm (per cohort member):
  disconfirm_count += inc
  confidence = (confirm_count + 1) / (confirm_count + disconfirm_count + 3)
```

Both `confirm_count` and `disconfirm_count` are **`real`**, not
integer. The increment is sub-unit (`1/sqrt(N)` ~ 0.2-0.6), so an
integer column truncated every reaction to 0 - which froze
confidence at its Laplace prior and made the decay rule below fire
on every samskara. The counts feed both confidence and decay, so
fractional storage is load-bearing, not cosmetic. The confidence
expressions read the POST-increment counts (the SQL adds `inc`
explicitly) so confidence doesn't lag one reaction behind.

Cohort weight is `1 / sqrt(N)` with a 0.01 floor and two-decimal
rounding. A 5-strong cohort all confirming contributes
`5 * 0.45 ~ 2.24` total confirm-count, not 5. Large cohorts
reinforce meaningfully but can't dominate single-fire signal.

### Decay formula

Three paths per `samskara_decay_sweep()` pass. Health is clamped
to [0, 1].

```text
stale-fire decay:
  health -= 0.02 where coalesce(last_fired_at, created_at)
                         < now() - interval '60 days'
disconfirm decay:
  health -= 0.10 where disconfirm_count > confirm_count
                    and disconfirm_count + confirm_count >= 1.0
locked-in-without-feedback decay:
  health -= 0.03 where fire_count > 10
                    and (confirm_count + disconfirm_count) < 0.5
```

The third path catches the "stereotype hardening" pathology
where a samskara fires constantly but never gets explicit
confirm or disconfirm (neutrals only). The existing two paths
never touch it; this gentle nudge crowds it out without
artificially perturbing user-facing behaviour.

The stale-fire path coalesces `last_fired_at` to `created_at`
so a never-yet-fired samskara is judged by its AGE, not punished
for the gap before its first fire. A bare `last_fired_at is
null` clause docked every newborn 0.02/pass until it first fired
(live data: health tracked the mint-to-first-fire delay in exact
0.02 steps), and under frequent decay a niche claim could reach
health 0 before ever firing - then it sits below the fire score
floor and never fires again, a stillbirth spiral. Coalescing
gives newborns the full 60-day window to establish while still
pruning claims that genuinely never fire.

Both feedback thresholds are ABSOLUTE accumulated weight, not
raw counts or a fraction of fire_count. They were originally
written against an integer-count, full-`+1`-per-reaction world
(`>= 3` and `< 0.2 * fire_count`). With sqrt-weighted real
increments and only ~20% of cohorts ever resolving, feedback
accumulates at a small fraction of fire_count, so `0.2 *
fire_count` was unreachable and `0.5` / `1.0` are the
recalibrated "barely any signal" / "~three reactions of net
disconfirm" bars. Overpopulation pruning is the collapse RPC's
job, not decay's, so these bars can be lenient.

Cadence matters as much as the thresholds: the decay rates are a
per-PASS nudge calibrated for a ~30-minute interval. Run more
often, they compound - an unthrottled per-rotation pass once
drove the whole corpus to health 0 at -0.03/pass, and any
client-lifecycle-scoped throttle resets on reload or tab switch,
so the cadence has to be owned by a wall clock. The pass
therefore runs **server-side as the `nak-samskara-decay` pg_cron
job** (`13,43 * * * *`, pure SQL, no pg_net - same shape as the
stream janitor). `samskara_decay_sweep()` is
`security definer` with no `auth.uid()` filter - cron has no user
session, and every predicate is row-local, so one cross-user pass
is exactly the union of the per-user passes. Decay is not part of
the formation rotation; the cron job is its only driver.

**RETIRED - superseded by self-calibrating health.** The wall-clock
decay formula above no longer runs. Health is now a *derived,
relevance-gated posterior*: the next-day evaluation sweep
(`nak-samskara-evaluation-sweep`, the `samskara_evaluation.ts` agent)
judges each samskara against the conversation it actually fired in
(`held` / `contradicted` / `not-engaged`), and `samskara_apply_evaluation`
recomputes `health` = `confidence` = a recency-discounted hit rate
shrunk toward `p0`, the population's aggregate hit rate
(`samskara_population_p0`). A prediction only moves when it is genuinely
tested; an untested or evidence-less one sits at `p0` (the baseline),
not at 0 - so `health` and `confidence` merged into one verdict-derived
score. The `nak-samskara-decay` cron is unscheduled; the new
`nak-samskara-reap` cron (`samskara_reap_dead`, minute :13) clears only
repeatedly-contradicted, long-quiet rows. The `samskara_decay_sweep` /
`samskara_apply_reaction` functions and the live reaction-classify
probe are left defined-but-dead pending a cleanup pass. Design of
record + the model's math:
[`plans/samskara-decay-relevance-gated-plan.md`](plans/samskara-decay-relevance-gated-plan.md).

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
invocation. The hourly sweep's dedup probe calls the RPC once
per active user per tick; a genuinely over-populated pool drains
across ticks rather than one giant transaction.

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

- **Chat** - two seams. Browser side, the chat loop is the only
  synchronous reader of samskara state: `runChatLoop` reads
  compound + fire at round-1 entry (under a 1500ms race) and
  writes a substrate stub at end-of-turn; the
  `buildSystemPrompt` change adds `promptAppendix` to its
  options struct, and samskara is currently the only caller.
  Function side, `getStreamingResponse`'s waitUntil tail drives
  `samskaraOnTurnTail` on every completed turn, sequenced
  curation -> samskara -> reflection. `Chat.svelte` mounts the
  single `<SamskaraToasts />` component and owns the
  `subscribeToSamskaraInserts` realtime subscription that turns
  mint INSERTs into `SAMSKARA_MINT_EVENT`. See `./chat.md`.
- **Embeddings** - `samskara-substrate` registers as a source
  in the server-side embed backfill (`_shared/embed-input.ts`)
  alongside memories and threads. Pure embed work; no LLM calls
  on that path. The backfill's round-robin (cron, every 5
  minutes) handles it automatically - mint latency inherits
  this lag, since a substrate row can't cluster until its
  situation embedding lands. See `./embeddings.md`.
- **Memory** - distinct system. Memories are facts the
  user/assistant chose to commit; samskaras are emergent
  predictive bias the model formed on its own. No data flows
  between them. The reflection agent reads thread transcripts
  and writes memories; the samskara assimilator reads
  individual exchanges and writes substrate. Both ride the same
  waitUntil tail, samskara first (reflection can span minutes
  and samskara carries the fleet's only hard timing window).
  See `./memory.md`.
- **Bias profile** - sibling server-side pipeline, no data flow.
  Bias profile aggregates cognitive-bias observations across
  conversations into a per-turn system-prompt section;
  samskara aggregates emergent predictive claims into the
  compound summary `<think>` block. Both ride in every turn
  but in different parts of the prompt - bias at the end of
  the baseline system prompt, samskara as a `<think>` block
  after the user turn - so they don't conflict. Both run in the
  venice function with per-row claims as the mutual exclusion;
  bias is cron-only while samskara is dual-driver. See
  `./bias-profile.md`.
- **Reflection / summaries** - peer fleets in the venice
  function. Samskara assimilation looks at one exchange at a
  time and writes substrate; reflection looks at settled
  threads end-to-end and writes memories; the summary curation
  unit produces thread-level prose. Three different
  granularities, three different stores.
- **Tools** - none. Samskara is intentionally not exposed as a
  tool (no `samskara_search`, no `samskara_invalidate`). It's
  an autonomic system; if the user wants to forget something,
  the recourse is a manual Supabase edit. Keeping it off the
  tool surface keeps the model from reasoning about its own
  bias as a thing it can game.
- **Settings** - no samskara controls in v1 (no enable/disable,
  no thresholds, no vocab knobs). The system is on or it's
  removed; no middle ground.
- **Auth-session** - the chat-scoped half (fire, stub,
  compound read, the diagnostics surfaces) requires a live
  session like any browser feature. The formation pipeline runs
  under the service role and has no session dependency at all -
  formation continues with every tab closed.
- **Logging** - the formation drivers log through
  `createEdgeLogger(userId, 'samskara')`, which mirrors to the
  function log and broadcasts to the user's `logs:<userId>`
  Realtime topic; the browser's `subscribeToUserLogs` lands the
  entries in the in-app Logs drawer. The `samskara` source tag
  is deliberately shared with the browser chat-loop helpers
  (`src/lib/samskara/`), so both halves group under one drawer
  filter. Deep visibility into what the pipeline is doing lives
  there, not in any UI chrome. See `./logging.md`.

## Gotchas

- **No health threshold at fire time, but a score floor on the
  cohort.** The instinct is to filter out samskaras with
  `health < X` from the fire query; that defeats the design.
  Three near-dead samskaras co-firing is exactly the signal we
  want to surface, because cohort reinforcement can pull them
  back from the brink and the formation pipeline can mint a
  tier-2 compound from the cohort later. The fire RPC ranks by
  `cosine^1.3 * sqrt(health * confidence) * (1 + 0.1 * ln(1 +
  N))` so weak-but-relevant samskaras break through (the 1.3
  power on the cosine factor is a relevance nudge, not a
  threshold - matches still rank smoothly down toward zero). The
  token budget in `formatPriming` is what bounds the long tail,
  not a SQL filter. The one filter that DOES apply is client-side
  in `fireSamskaras`: rows scoring below `FIRE_SCORE_FLOOR`
  (0.01) are dropped before the cohort is logged. That's a floor
  on SCORE, not health - it only removes effectively-retired rows
  whose health decayed to ~0 (score ~0), which contribute nothing
  to priming yet would otherwise bloat cohorts to ~20 members,
  inflate fire_count, dilute each reaction's `1/sqrt(N)` weight,
  and poison co-fire dedup / tier-2 detection with spurious
  Hebbian binding. Live-but-weak matches (the long tail) all sit
  above it.
- **pgvector reads back as a string, not an array.** PostgREST
  has no type mapping for `vector`/`halfvec`, so a selected
  embedding column arrives as its bracketed text literal
  (`"[0.1,...]"`). Any JS-side cosine that treats it as an
  array multiplies characters into NaN. This silently broke
  pair-relate for weeks (zero associations - every similarity was
  NaN, no pair cleared the threshold). `recentEmbeddedSubstrate`
  in the edge module runs every row through `parseVector`; any
  new code path that reads an embedding column for JS-side math
  must do the same. RPCs that do the cosine in SQL (the fire,
  search, nearest, and cluster RPCs) are unaffected - this only
  bites JS-side vector math.
- **Reaction counts are `real`; decay cadence is load-bearing.**
  Two coupled traps that together euthanized the entire corpus
  to health 0 once. (1) `confirm_count`/`disconfirm_count` MUST
  be `real`: reactions increment by `1/sqrt(cohort_N)` (~0.2-0.6),
  which an integer column truncates to 0, freezing confidence and
  making the locked-in decay rule fire on everything. Any RPC
  RETURNS TABLE that re-declares these as `int` (e.g.
  `samskara_search_by_prediction`) re-introduces the truncation
  on the way out - keep them `real`. (2) the decay rates are a
  per-pass nudge calibrated for a ~30-minute cadence; at -0.03
  health per locked-in pass, anything that runs the pass more
  often is lethal within ~30 min. The cadence is owned by the
  `nak-samskara-decay` pg_cron schedule - if you ever see health
  collapse across the board again, check the column type and the
  cron schedule before the decay formula.
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
  retargeting; the constraint is belt-and-braces. The inline
  cohort panel's clustered-by-theme view assumes one fire per
  (cohort, samskara) - duplicates show up there as
  identical-looking expanded siblings under one cluster. If you
  ever see that symptom return, look at the merge helper, not
  the cluster RPC.
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
  checking `samskara_should_regen_compound` against the edge
  module's `Math.log10` is confusing if you're used to JS/C
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
  stale signal. This is why reaction-classify is tail-only and
  runs FIRST in the tail: the tail of turn N+1 lands exactly
  when turn N's cohort becomes classifiable, and it is the only
  hard timing window in the whole pipeline.
- **Neutral has no boolean state.** `was_confirmed` is
  true/false/NULL, and a classified-neutral fire stays NULL -
  it is marked only by `fired_at` being backdated 15 minutes,
  which pushes it out of the resolution window. A query that
  treats `was_confirmed is null` as "not yet classified" is
  counting neutrals too; there is no way to distinguish a
  neutral from an aged-out unresolved fire after the fact.
- **`samskara_record_fires` thread-ownership guard is silent-
  skip.** The RPC verifies the supplied `thread_id` belongs to
  `auth.uid()` before inserting fire rows (RLS hides reads but
  doesn't constrain the insert once `user_id` is trusted). On
  a mismatch it returns early without raising, matching the
  pattern of `mark_thread_reflected_if_claimed` and
  `save_thread_summary_if_claimed`. A bug calling this with
  the wrong thread_id therefore does nothing, rather than
  surfacing a Postgrest exception through the chat loop.
- **Rate-limit propagates through the agent contract.** The
  agent helpers (via `callOnce`) re-throw `VeniceError` with
  `kind='rate_limit'` rather than swallowing to null, and
  `runPhase` re-throws it past the per-phase catch, so the
  driver abandons the rest of the rotation - the next turn or
  tick retries with fresh budget. Every other Venice failure
  returns null and folds into the phase's no-result path.
  Without this distinction a rate-limited rotation would keep
  hammering Venice phase after phase.
- **The trigger cadence is the only rate limit.** There are no
  per-phase throttles anywhere in the pipeline; one trigger
  (turn or tick) runs one rotation and stops. Adding a phase to
  the tail therefore adds its cost to EVERY completed turn, and
  adding one to the sweep adds it per active user per hour -
  budget accordingly. The tail/sweep phase split is the design,
  not an accident: reaction-classify is tail-only (timing
  window), mint-tier2 / dedup / compound-regen are cron-only
  (heavy or timing-insensitive), and moving a phase across that
  line should be a deliberate decision.
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
  tier-2 rows that keep vanishing a tick after they mint. Keep
  the band below the floor.
- **Tier-2 re-mint storm without the coverage skip.** Once a
  tier-2 covers a constellation, that group keeps co-firing, so
  detection would re-surface it every probe. Two guards stop
  the loop: `samskara_tier2_candidate`'s Jaccard `p_overlap_skip`
  (skip a group an existing tier-2's child-set already covers) and
  the mint phase's tier-scoped embedding dedup (reinforce the
  nearest existing tier-2 instead of inserting when cosine >=
  `MINT_DEDUP_COSINE`). The first catches the same-children case,
  the second a different child set the agent synthesized into the
  same claim. Neither is optional.
- **Tier-2 rides the unchanged hot path; orphans are fine.**
  `samskara_fire_top_k`, `samskara_apply_reaction`, and
  `samskara_decay_sweep` have no tier filter, so a tier-2 fires, gets
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
- **`samskara_tier2_candidate` clears its temp table with
  TRUNCATE, not DELETE.** The local stack's PostgREST
  connections preload pg-safeupdate, which rejects an
  unqualified `delete from _tier2_edges` with `DELETE requires
  a WHERE clause` (SQLSTATE 21000) - so a "simpler" unqualified
  DELETE breaks every tier-2 probe against the local stack
  while passing hosted. Keep the TRUNCATE.
- **Pair-relate uses a naive seed-most-recent approach.**
  One pair per probe: seed on the most recent embedded
  substrate row, walk its neighbours best-cosine-first to the
  closest pair the relator hasn't already ruled on, call the
  relator once. Good enough at substrate-corpus scale; expect
  to replace with a smarter multi-pair sampler once the corpus
  grows past a few hundred rows per user.
- **A quiet corpus goes silent, not chatty.** Both relator
  verdicts persist (accepts in `samskara_associations`,
  declines in `samskara_pair_declines`), and candidate
  selection skips adjudicated pairs - so once every pair in the
  window is ruled on, the probe logs a trace line and spends no
  Venice call until fresh substrate changes the selection. A
  flat associations count during a quiet stretch is this, not a
  stall. An agent-null result (transport/parse failure) is NOT
  a verdict and leaves the pair unadjudicated for retry.
- **Association-mint self-quenches the same way - stamp on
  decline or loop forever.** Mint-tier1-assoc stamps `minted_at`
  on the fed edges for EVERY minter verdict, decline included;
  without stamping declines, a stable graph re-feeds the same hub
  every sweep and burns a minter call per hour re-asking an
  unchanged question (the pair-relate pathology, one level up).
  Decline consumes the *current* evidence; future edges to the
  same hub arrive unstamped and re-qualify it - that's the
  designed re-open, not a loophole. Conversely a non-verdict
  (`agentMint` -> null, embed failure, failed insert) must NEVER
  stamp, or evidence is silently discarded. That is the whole
  reason `agentMint` returns `MintResult | 'declined' | null`
  instead of the recency path's `MintResult | null`.
- **A consumed edge is permanent per edge.** Re-reinforcing an
  already-consumed edge (pair-relate re-encountering the pair)
  bumps `reinforcement` but does NOT re-trigger minting. Known
  limitation: corroboration of an already-minted pattern reaches
  the existing samskara's health only if a fresh mint attempt
  happens to dedup onto it. No direct re-reinforcement -> health
  path today.
- **Mixed-pattern hubs underperform by design.** A hub's edges
  can span genuinely different tendencies (one observation
  relating to a baking pattern AND a family pattern). v1 feeds
  the whole neighbourhood and leans on the minter's
  `confirm:false` guard; decline-stamps guarantee no loop, but a
  messy crossroads hub yields one-or-zero samskaras where a
  smarter version would get several. The future fix - grouping a
  hub's edges by what their *labels* say before minting - is what
  the dropped `relation_embedding` column was reserved for.
- **Mixed-kind provenance breaks the first-row heading.**
  Association-minted tier-1s are the only rows with two
  provenance kinds (substrate + association), and the detail RPC
  orders by `weight` desc - an edge with reinforcement > 1
  outranks substrate weight 1.0 - so heading the section off
  `provenance[0].kind` mislabels it. `Samskaras.svelte` groups by
  kind via `groupProvenance` (in `src/lib/ui/samskara-browse.ts`)
  and renders one headed section per kind present. Any future
  provenance kind must extend that grouping, not resurrect the
  first-row heuristic.
- **Writes that bypass the RPC boundary.** The mint inserts +
  provenance upserts and the pair-decline writes use the raw
  admin client rather than an RPC, with `user_id` set
  explicitly on every row (the column defaults are
  `auth.uid()`, which is NULL under the service role).
  Association writes are the exception: they go through the
  `samskara_associate` RPC because the on-conflict
  reinforcement increment can't be expressed in a PostgREST
  upsert. Future policy that wants to encapsulate the remaining
  raw writes (soft-uniqueness, merge jobs) should wrap them in
  RPCs first.
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
  whatever's currently in the database and proceeds. If
  formation is hours behind, the model just operates on
  staler bias.
- **The assimilate drain works one turn behind, by
  construction.** The browser records turn N's substrate stub
  at roughly the same moment turn N's tail runs, so the tail
  usually assimilates turn N-1's stub; the sweep catches
  strays. The full in-session path for a new claim is: stub
  (browser, end of turn N) -> assimilate (tail of N+1) ->
  situation embedding (the */5 embed backfill) -> mint probe
  (tail of N+2). A few minutes and a couple of turns is the
  expected mint latency - a toast that doesn't appear on the
  very turn that earned it is normal, not a bug.
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

## Three-way scope split

The samskara UI is partitioned by what each surface's data is scoped to:

- **Per-conversation -> a modal.** The mood graph (where this
  conversation's latest fire sits on the `(valence x confidence) ->
  emoji` map) is inherently per-conversation, so it lives in the
  `SamskaraMood.svelte` modal opened from the mood pill / footer tile,
  not on the corpus-global tab.
- **Per-round -> the inline cohort dropdown.** The samskaras a single
  user turn triggered (the `CohortPanel` under each user message).
- **Global -> the Samskara tab.** Everything corpus-wide: the corpus
  browse, pipeline health, and the always-on compound summary
  (per-user, one row).

## Observability tab

A first-class drawer tab (sibling to chats/memories/wiki/recipes,
`drawer=samskara`) is the operator's read-only window into the global
pipeline state. It replaced the old `route.modal='samskara'`
diagnostics modal (whose per-conversation mood graph moved to
`SamskaraMood.svelte`). Three surfaces, NO sub-nav. **Summary** and
**Health** are both GLOBAL (per-user / corpus-wide) and reached via
top-bar buttons in `Chat.svelte`'s samskara `TopBarActions` cluster;
**Corpus** is the per-samskara detail, reached by selecting a sidebar
row. Summary is the default landing page. Both globals lived as sub-nav
tabs next to the per-samskara Corpus detail once, which wrongly implied
they belonged to the selected instinct; they were lifted out to the top
row (Summary first, then Health), which collapsed the sub-nav to a
single Corpus tab and so removed it entirely.

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
  history). The headline severity is the worst of the ACTIONABLE
  signals only: backlog depth (pending assimilate / embed, loose
  `[50, 500]` bars - a snapshot of a few is normal, since the
  tail drains small caps per turn and the sweep is hourly),
  internal inconsistencies (orphan fires, stuck claims -
  tight bars, should be ~0), and compound-summary staleness. The
  windowed mint/fire/resolution rates and the corpus counters
  are shown but NOT severity-bearing (see the calibration note
  below). Backed by
  `samskara_health_snapshot`, `samskara_rates`, and the severity
  thresholds in `src/lib/ui/samskara-browse.ts`
  (named constants, tune against observed behaviour). Piece:
  `src/components/SamskaraHealthPanel.svelte`. Reached via the top-bar
  **Health** button (an `activity`/pulse icon in `Chat.svelte`'s samskara
  `TopBarActions` cluster), which flips the `triggerHealthView`
  `$bindable` prop; `Samskaras.svelte` watches it, switches `subView` to
  `health`, and clears `route.samskara_id` (Health is corpus-wide, so a
  lingering sidebar selection would falsely read as "health of this one")
  - same shape as the Summary trigger below.

- **Summary** - the default landing page: the always-on compound summary
  block (per-user, global) plus a short orientation paragraph on what
  samskara is. Fetched via `samskaraGetCompoundSummary` in
  `Samskaras.svelte`. Reached on tab-open and via the top-bar **Summary**
  button (an `align-left` icon in `Chat.svelte`'s samskara `TopBarActions`
  cluster), which flips the `triggerSummaryView` `$bindable` prop;
  `Samskaras.svelte` watches it, switches `subView` to `summary`, and
  clears `route.samskara_id` so the sidebar deselects. The inverse wiring
  is a `$effect` that flips `subView` to `corpus` whenever
  `route.samskara_id` becomes truthy (sidebar row click or deep link), so
  selecting a samskara always lands on its detail. The mood legend that
  used to share this surface moved to the conversation-mood modal (see the
  scope split above).

Read-only by design - no delete/pin/edit. Curation would re-open the
"operator games the bias model" question; if it's ever wanted it's a
deliberate separate decision. The modal's manual "Consolidate" and
"Copy snapshot" buttons were build-time scaffolding from the original
samskara work - never intended as permanent operator features - so they
were intentionally not migrated. Dedup runs automatically in the
hourly sweep regardless.

Search ranks by plain cosine (`samskara_search_by_prediction`), NOT
the `samskara_fire_top_k` formula - browse wants closest-to-query, not
most-likely-to-fire, so health/confidence are deliberately left out of
the ranking.

**Health-metric calibration (a fixed false alarm).** One signal looks
like a failure but isn't, and an early version of the panel turned the
headline permanently red on it: **fires aged out unresolved** grows
unbounded by design. Reaction-classify only resolves the cohort whose
follow-up landed in the 1-10min window, so ~95% of fires never get an
explicit reaction (the resolution rate is *meant* to be low). This is
not surfaced as a severity bar at all; the windowed resolution rate is
shown with a note that low is normal. A genuinely stuck pipeline shows
up as a deep, persistent backlog instead - which IS a severity bar.
The headline severity therefore considers only backlog,
inconsistencies, and compound staleness.

## Where to go next

- `./chat.md` - the seam where samskara plugs into the per-turn
  flow.
- `./embeddings.md` - the server-side backfill the substrate
  source rides.
- `./memory.md` - the closest sibling system; useful for
  understanding why samskara is structured differently
  (emergent vs declared, opaque vs user-facing, autonomic vs
  tool-driven).
- `./logging.md` - how the edge loggers' entries reach the
  in-app Logs drawer.
- `./architecture.md` - the background-fleet model in context.
