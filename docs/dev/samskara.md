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

> **Where the chat-time half runs:** the cosine fire + compound-summary
> read run server-side, as part of the priming stage of
> `getStreamingResponse` (`supabase/functions/venice/priming/samskara.ts`,
> orchestrated by `runServerPriming` in `priming.ts`), so they survive a
> browser disconnect mid-turn. `samskara_fire_top_k` and
> `samskara_record_fires` gained a `p_user_id` parameter for the
> service-role caller. The fire's throbber rides the `priming_start/end`
> (op `'samskara'`) events. The **end-of-turn substrate stub write**
> (`recordSubstrateStub`) stays browser-side - it is not priming. The
> formation pipeline + sweeps remain server-side as before.

**Diagnosing the system as a whole:** use the `samskara-audit`
project skill (`.claude/skills/samskara-audit/SKILL.md`). It walks
every stage's inter-stage contract against live data before any
synthesis - the pipeline's failures have historically been contract
gaps between individually-healthy stages, which symptom-first
debugging misses.

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
constellations of tier-1 samskaras, judging fired predictions
against settled conversations, reaping dead samskaras,
regenerating the compound summary - runs server-side. The
formation pipeline lives in the venice edge function
(`supabase/functions/venice/agents/samskara.ts`), driven by the
completed-turn tail and an hourly cron sweep; the evaluation
judge and the reaper ride their own pg_cron jobs. Every LLM phase uses the hardcoded
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

- `supabase/functions/venice/priming/samskara.ts` - the
  turn-entry IO half. Owns `getCompoundSummary` and
  `fireSamskaras`, run by `runServerPriming` as part of the
  priming stage. Every samskara-side failure path is swallowed
  here (returns null, never throws) so a samskara failure never
  blocks a chat turn.
- `supabase/functions/venice/priming/samskara-format.ts` - the pure
  priming-block formatter plus the shared `FireResult` /
  `FiredSamskara` / `PrimingInput` types and the tunable constants
  (`K_BASE`, `PRIMING_CHAR_BUDGET`, `STALE_CEILING_HOURS`,
  `FIRE_SCORE_FLOOR`, `topKForCorpusSize`). `formatPrimingThinks`
  renders the compound summary as one `<think>` body and the fired
  samskaras as bullets in another, token-budget capped via
  `PRIMING_CHAR_BUDGET`. Weakest-but-relevant fires fall back to an
  abbreviated form before being dropped, so the long tail stays
  visible when budget tightens. Self-contained (no relative imports)
  so it stays a pure, trivially-testable module.
- `src/lib/samskara/index.ts` - the surviving browser surface.
  Owns `recordSubstrateStub`, the end-of-turn fire-and-forget
  substrate stub write (not priming - it runs after the terminal
  assistant row persists).
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
  (`moodState`), written only by `SamskaraMoodSync.svelte` and
  read by the pill (`DiagnosticPills.svelte`) and
  `SamskaraMoodLegend.svelte`. Two fields: `current` (the raw
  `{ valence, confidence, tier } | null` triple) plots the legend's
  "you are here" dot; `visual` (glyph/label + transition id) is
  what the pill renders. The sync component is the sole writer
  (updates on mint events and on the seed-from-history path;
  clears both on thread switch); the legend and pill are passive
  observers. Lifting this out of the pill keeps the dot aligned
  with the pill the user clicked - no separate fetch, no listener
  race - and lets the pill be rendered twice (desktop + mobile)
  as a pure reader. Lives in its own .svelte.ts module rather
  than `events.ts` because `events.ts` stays rune-free plain TS
  and the shared mood state needs `$state`.
- `src/components/SamskaraMoodSync.svelte` - headless single owner
  of the mood data. Renders nothing; listens for
  `SAMSKARA_MINT_EVENT` on `window`, runs the thread-open
  seed-from-history fetch and the `route.cid` reset effect, and
  publishes to `moodState`. The mood *pill* itself is the
  `samskara` entry in the shared diagnostic-pill column (see
  [diagnostic-pills.md](./diagnostic-pills.md)) - bottom-right of
  the messages pane on desktop, the wharf menu on mobile - and
  shows the latest mint's emoji until the next mint (or a thread
  switch). Present whenever a thread is active (`route.cid` set).
  On thread open the sync owner seeds asynchronously
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
  as one of seven sources the server-side embeddings backfill
  drains. The cron-driven backfill claims
  `samskara_substrate where situation_embedding is null and situation
  is not null` (via `samskara_claim_next_substrate_embed`), embeds via
  `localEmbed` (Supabase.ai.Session), and saves under a guard.
  Mirrors the memories source entry.
- `supabase/functions/venice/agents/samskara.ts` - the formation
  pipeline. The five agent prompts (`ASSIMILATOR_PROMPT`,
  `RELATOR_PROMPT`, `MINTER_PROMPT`, `TIER2_MINTER_PROMPT`,
  `COMPOUND_SUMMARY_PROMPT` - terse on
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
  RLS and the RPC surface covering fire, cohort log, evaluation
  apply, substrate record, assimilate claim/save, substrate-embed
  claim/save, the cron-driven reaper, co-firing-based
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
  order; default threshold 0.7 sits in gte-small's "topically
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
  `insertMint` publishes a `samskara-mint` Broadcast event so
  mints reach the browser (the toast signal); `samskaras` is
  intentionally NOT in the `supabase_realtime` publication.
  Follows the project's idempotent-apply conventions (`if not
  exists`, drop-then-create for policies and functions).

## Entry points

- **`runServerPriming` turn-entry** - in
  `supabase/functions/venice/priming.ts`, before the first round's
  messages go to Venice, the priming stage races `getCompoundSummary`
  and `fireSamskaras` (both in `venice/priming/samskara.ts`) in
  parallel under a 1500ms cap. The user-round index is computed from
  `countUserRounds` so each cohort row carries the user-message index
  it anchors to. The resulting bodies become the samskara `<think>`
  blocks the orchestrator splices ahead of the round (one cohort id
  per user turn, not per round). Underlying Promises keep running on
  timeout; the worst case is a cohort logged whose think-block never
  reached the model - the next-day judge still rules on those fires,
  which typically read as loose topical matches and land not-engaged.
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
  completed turns, sequenced curation -> samskara.
  Runs the session-responsive phases: a capped assimilate drain,
  then one pair-relate probe, then one mint-tier1 probe. (Reaction
  scoring is no longer a tail phase - it moved to the next-day
  evaluation sweep, `samskara_evaluation.ts`.)
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
  the other sources do.
- **Mint relay** - `insertMint` publishes a `samskara-mint`
  Broadcast event (`(tier, valence, confidence)`) on the user's
  private `samskaras:<uuid>` topic via
  `_shared/samskara-mint.ts`. `Chat.svelte` subscribes through
  `SupabaseService.subscribeToSamskaraInserts` and routes the
  payload into `notifySamskaraMint`, which dispatches
  `SAMSKARA_MINT_EVENT` on `window`; the `SamskaraMoodSync`
  component mounted inside `Chat.svelte` listens for it and
  publishes the valence-mapped mood to `moodState`, which the
  diagnostic-pill column renders. INSERT-only by design:
  `insertMint` is the sole insert path, so dedup-reinforce hits
  (which UPDATE an existing row) stay silent. Broadcast rather
  than a postgres_changes echo keeps `samskaras` out of the
  realtime publication - its fire-bookkeeping UPDATE churn had
  made `realtime.list_changes` decode the table's WAL the
  single largest database-time consumer.

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
  text. Padded from 384-dim gte-small native via
  `padEmbeddingForStorage` (see `src/lib/models/index.ts`).
- Claim columns for each pending phase: `(embedding_claim_holder,
  embedding_claim_expires)` for the substrate-embed source and
  `(assimilate_claim_holder, assimilate_claim_expires)` for the
  assimilator phase. Two phases write to this row at different
  times so they need independent claims.
- `pair_seeded_at timestamptz` - the pair-relate seed cursor.
  Stamped when this row is chosen as a pair-relate seed; the probe
  always seeds the longest-unseeded embedded row, so the seed
  round-robins the corpus. See `samskara_pair_probe_candidates`.
- Partial indexes on `(user_id, created_at) where situation is
  null` and `(user_id, created_at) where situation_embedding is
  null and situation is not null` keep the claim queries cheap
  as the substrate table grows; a third on `(user_id,
  pair_seeded_at nulls first) where situation_embedding is not
  null` orders the pair-relate seed pick.

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

(An old `relation_embedding vector(2048)` column was dropped when
association-mint landed - never populated or read. Noted here only
so a reference to it in the association-mint plan's history doesn't
read as a missing column.)

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

### `samskara_tier2_declines`

Ledger of tier-2-minter `confirm:false` verdicts, keyed
`(user_id, group_key)` where `group_key` is the declined group's
sorted child ids joined with `,`. `children uuid[]` holds the same
sorted ids for the candidate RPC's Jaccard overlap test. Unlike
`samskara_pair_declines` this is **TTL'd, not permanent**: the
candidate walk only honors a decline within the recency window
(`v_decline_ttl`, 7 days) before the group re-qualifies. A tier-2
decline is over a co-fire *constellation*, and the co-fire graph
keeps growing - a group too weak today may strengthen - so the
verdict must be able to lapse, where a pair decline (immutable
substrate) cannot. A re-decline upserts on `group_key`, re-arming
the window. No per-element FK (arrays can't reference); a deleted
child leaves a stale id that only weakens the Jaccard match
slightly and is cleared by the TTL anyway. Select-only RLS for the
owner; writes come exclusively from the service-role client. Folds
into `samskara_tier2_candidate`'s coverage skip - see the Mint-tier2
contract.

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
- `confidence real default 0.5` - the verdict posterior, kept
  equal to `health` (see Health: the verdict posterior).
- `health real default 1.0` - the derived posterior, recomputed
  by `samskara_apply_evaluation`; clamped to [0, 1]. **NO threshold
  filter at fire time** - see Gotchas.
- `fire_count int`; `confirm_count real`, `disconfirm_count
  real` (fractional by design - the per-genuine-test discount and
  the `w_soft` soft-miss weight are sub-unit; an int column would
  truncate them to 0; see Gotchas);
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
  `score real not null`, `was_confirmed boolean`, `verdict text`.
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
- `verdict` is the authoritative judgment, written by the
  next-day evaluation judge (held / contradicted / not-borne-out
  / not-engaged; NULL = not yet judged). `was_confirmed` is kept
  in sync for legacy readers: held -> true, contradicted and
  not-borne-out -> false, not-engaged stays NULL.
- Partial index on `(user_id, thread_id, fired_at desc) where
  was_confirmed is null` - served the retired reaction-classify
  unresolved poll; now vestigial (an unused-index advisor will
  flag it for a later drop).
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

### Turn-entry side (server, synchronous, no LLM)

The IO half (`getCompoundSummary`, `fireSamskaras`) lives in
`venice/priming/samskara.ts`; the pure formatter
(`formatPrimingThinks`) in `venice/priming/samskara-format.ts`. The
service-role admin client has no `auth.uid()`, so the RPCs are called
with an explicit `p_user_id`.

- `getCompoundSummary(admin, userId, log): Promise<string | null>` -
  reads the cache row. Returns null on cold start (no row yet
  or `summary` is null/empty) and when `last_regen_at` is older
  than `STALE_CEILING_HOURS` (24h). Fetch/RPC errors are
  swallowed and surface as null so a transient blip doesn't
  propagate into the orchestrator's priming path.
- `fireSamskaras({ admin, userId, threadId, userRound,
  userText, signal?, log }): Promise<FireResult | null>` - embeds
  `userText` via `localEmbed`, pads the query, runs `samskara_fire_top_k`,
  drops dead-tail rows below `FIRE_SCORE_FLOOR`, and persists a
  `samskara_fires` row per surviving hit via `samskara_record_fires`.
  `cohort_id` is generated with `crypto.randomUUID`. Returns null
  on empty corpus, empty input, embedding failure, or RPC
  failure; errors are logged at debug so a chat turn is never blocked.
- `queryFiredSamskaras({ admin, userId, apiKey, queryText, signal?,
  log }): Promise<FiredSamskara[] | null>` - the read-only half of a
  fire (embed + top-k + score floor, NO cohort write). `fireSamskaras`
  is this plus the record step. Exists for callers that want advisory
  context without touching fire bookkeeping - today that is the
  second-thoughts refinement probe, which keys a query to the doubt
  note + user text and must not double-count the round's fire (see
  `./second-thoughts.md`). Same swallow contract.
- `recordSubstrateStub(supabase, threadId, userMessageId,
  assistantMessageId | null): Promise<void>` - the surviving
  browser end-of-turn write; one INSERT via
  `samskara_record_substrate`. `situation` / `outcome` /
  `valence` / `situation_embedding` all null; the formation
  pipeline fills them. Errors swallowed; fire-and-forget.
- `formatPrimingThinks({ compoundSummary, fire }): { compound,
  fire }` - pure. Returns the two `<think>`-block bodies (or null
  per field when the signal is absent): the compound paragraph and
  the fire bullets sorted by score descending. The orchestrator
  prepends the `SAMSKARA_*_THINK_MARKER` provenance comments when it
  wraps the bodies in `<think>` tags (markers ride at wrap time so
  this stays a pure projection and the budget math is untouched; see
  prompt-augmentation.md -> "Provenance markers"). Keeps the top three
  fires in full form and abbreviates the rest when total length
  exceeds `PRIMING_CHAR_BUDGET` (2400 chars); drops the weakest
  entries one by one if abbreviation alone doesn't fit.
- `topKForCorpusSize(n, kBase): number` - computes
  `max(1, ceil(kBase * log10(n + 10)))`. The fire call passes
  `topKForCorpusSize(100, K_BASE) = 11` - the rendered set, not a
  generous multiple of it. Fires past what `PRIMING_CHAR_BUDGET`
  renders never reach the model and are pure bookkeeping (judge
  padding, fire_count inflation, co-fire saturation). A score-based
  cutoff was measured and rejected (2026-08): the RPC truncates at k
  BY SCORE, so recorded cohorts are definitionally the closest-scored
  k rows and their within-cohort ratios stay compressed regardless of
  health spread - there is no knee to calibrate against, only this
  structural line. The formatter still does the budget trim.

### Formation side (edge function, fast-model agent calls)

Each phase is a one-row-at-a-time probe that mirrors the
embeddings backfill's claim -> process -> save shape. Two
drivers run the phases, split by timing sensitivity:

- **Turn tail** (`samskaraOnTurnTail`) - an assimilate drain
  capped at `TAIL_ASSIMILATE_CAP` (3) so one tail invocation
  never monopolises the background budget, then one pair-relate
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
day of staleness in the priming block. Evaluation is neither a
tail nor a sweep phase - it rides its own day-gated cron
(`nak-samskara-evaluation-sweep`; see the Evaluation contract
below).

There are no per-phase throttles. One trigger runs one rotation,
so the trigger cadence (turn or tick) IS the rate limit -
nothing rotates continuously. The one bounded exception:
mint-tier1-assoc adjudicates up to `ASSOC_HUBS_PER_TICK` (3) hubs
per rotation - each a minter call - stopping at the first
non-verdict or when headroom runs out; the constant is the spend
ceiling. A Venice rate-limit re-throws out
of any phase and abandons the rest of the rotation (the next
turn or tick retries with fresh budget); any other phase failure
logs and yields to the next phase.

- **Assimilate** - `agentAssimilate(apiKey, userMsg,
  assistantMsg, secondThoughts?) -> {situation, outcome, valence}
  | null`. Reads the raw exchange, returns structured substrate
  fields. When the assistant row carries a second-thoughts DOUBT
  verdict (hedge/reframe/correct - never conviction;
  `doubtForAssimilation` is the gate), it rides the payload as
  `assistant_second_thoughts` so the misgiving colours `outcome`
  and `valence` - the embarrassment-event feed from
  [second thoughts](./second-thoughts.md). Timing is forgiving:
  the reviewer writes seconds after the turn, assimilation runs a
  later tail or the hourly sweep, so the verdict is normally
  present; a missing verdict just degrades to the doubt-free
  payload. Claim RPC `samskara_claim_next_assimilate` (per-user,
  tail) or `samskara_claim_next_assimilate_for_sweep` (cross-user,
  sweep); save RPC `samskara_save_assimilation_if_claimed`. Both
  claim RPCs carry the same junk-data gate as the reflection /
  wiki / evaluation claims: a stub whose thread has fewer than two
  user messages is never claimed. One-shot lookups ("how does
  postgres paging work") say nothing about the user, and letting
  them into substrate polluted tier-1 mints and the compound
  summary upstream. The gate defers rather than drops - the
  round-1 stub of a thread that grows becomes claimable as soon as
  the second user message lands, so real conversations lose
  nothing; stubs of threads that stay one-shot wait unclaimed
  forever (the health snapshot's `pending_assimilate` excludes
  them so they don't read as a stuck worker). Cap
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
  refusal). The probe is population-gated via the shared
  `ensureTier1Headroom` helper: at or above `TIER1_POPULATION_CAP`
  (150, mirroring the collapse RPC's `p_target_count` - see the
  treadmill gotcha) it first attempts cap-pressure eviction
  (`samskara_evict_for_mint`, see the decay section) and returns
  before any Venice spend when no victim qualifies. With headroom, the
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
  service role). `insertMint` then publishes a `samskara-mint`
  Broadcast event to the user's private topic, which reaches
  `Chat.svelte`'s subscription and re-emits `SAMSKARA_MINT_EVENT`
  for the mood pill. Dedup-reinforcement inserts nothing and so
  emits no mint event - the intended toast semantics - though it
  logs so the Logs drawer shows "dedup-reinforced existing"
  breadcrumbs.

  A third tool - `samskara_collapse_by_cofiring(...)` - handles
  ongoing redundancy consolidation. It's the same RPC the
  sweep's dedup probe runs each tick (see below); it has no
  manual UI trigger - dedup runs autonomically. Idempotent.
- **Mint-tier1-assoc** (`mintTier1FromAssociationsProbe`, SWEEP
  ONLY) - mints from the association graph instead of the recency
  window, so cross-session recurrence that no recency window can
  co-locate still reaches the minter. Adjudicates up to
  `ASSOC_HUBS_PER_TICK` (3) hubs per sweep tick - a verdict stamps
  the fed hub's edges so the next cluster read returns a different
  hub; any other outcome breaks the loop. Each hub carries the same
  `ensureTier1Headroom` cap-or-evict gate as Mint-tier1, checked
  BEFORE the cluster read: a gated skip is a non-verdict, so the
  hub's edges stay unstamped and the evidence waits intact. The
  gate parity matters - see the probe-order note in the eviction
  section - and a declined hub does not fill the slot its eviction
  freed, so one victim can fund several adjudications in a tick.
  With headroom, `samskara_association_cluster`
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
- **Evaluation (next-day judge)** - `samskara_evaluation.ts`, the
  `nak-samskara-evaluation-sweep` cron. NOT on the turn tail: it waits
  until a conversation has settled (same next-day + `>= 2`-round gate as
  reflection), then judges every samskara that FIRED in the thread and
  routes the GENUINE-TEST verdicts (held / contradicted / not-borne-out)
  through `samskara_apply_evaluation` - the sole writer of the verdict
  tallies and the derived health posterior. Not-engaged verdicts are
  stamped on the fire rows only; they never reach the RPC (see Health:
  the verdict posterior). The
  fired-prediction list is judged in batches of `EVALUATION_BATCH_SIZE`
  (20), one structured completion per batch with the transcript resent
  each time - long threads fire 40-90+ distinct samskaras, and a single
  completion over the whole list truncates its verdict map at the token
  budget (see the truncation gotcha below). A zero-verdict run (every
  batch truncated or unparseable) does NOT advance the evaluation
  cursor; the thread re-qualifies next tick, bounded by the claim RPC's
  `evaluation_attempt_count < 3` gate. The judge answers a two-step
  decision tree: STEP 1, did the prediction's situation actually arise?
  If not, `not-engaged` (a loose topical fire, no fair test) - the
  skeptical default applies to this question only. STEP 2, for engaged
  predictions only: `held` (a POINTABLE moment where the user did the
  predicted thing - mere consistency is not confirmation, and the
  prompt carries the operational test "would the transcript look any
  different if the prediction were false?"), `contradicted` (did
  the opposite), or `not-borne-out` (situation arose but the tendency
  did not distinctly appear - a soft miss, including the consistent-
  but-undemonstrated case); the prompt forbids falling back to
  `not-engaged` once the situation is deemed to have arisen, and
  carries worked examples of all four verdicts plus the broad-
  prediction trap. The held bar exists because a consistency-is-
  confirmation judge ruled 92.5% of genuine tests `held` in prod
  (2026-07 audit), pinning `p0` at ~0.95. Firing is recall; this
  four-way is precision - splitting the old single `not-engaged` bucket
  is what lets health discriminate (see Health: the verdict posterior).
  Firing is the relevance gate, so an untested prediction is never
  judged. It replaced a live 1-10 minute reaction classifier
  (`agentClassifyReaction` + `samskara_apply_reaction`)
  that resolved only ~4% of fires; `was_confirmed` is now set by the
  judge (`held` -> true, `contradicted` -> false) for the legacy panels
  that still read it.
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

### Health: the verdict posterior

Health is a *derived statistic*, not an accumulator. It is a
recency-discounted hit rate - of the times a samskara's topic actually
came up (it fired) and the next-day judge tested it, how often did the
prediction hold? `health` and `confidence` are the SAME number now (the
merge): both are this posterior, so the fire score's
`sqrt(health * confidence)` collapses to it.

`samskara_apply_evaluation(user, held[], contradicted[], not_borne_out[])`
updates each GENUINELY-TESTED samskara online, one discount step plus
the verdict:

```text
discount prior evidence (the forgetting):
  confirm_count    *= d        -- d = 0.5 ^ (1/L), L = half-life in genuine tests
  disconfirm_count *= d
fold in this test's verdict:
  held          -> confirm_count    += 1
  contradicted  -> disconfirm_count += 1
  not-borne-out -> disconfirm_count += w_soft   -- soft miss, w_soft = 0.25
recompute the posterior (written to BOTH health and confidence):
  health = confidence = (confirm_count + k*p0) / (confirm_count + disconfirm_count + k)
```

`not-engaged` fires are NOT passed to the RPC at all - the verdict is
stamped on the fire rows for the diagnostics surfaces, but the
samskara's evidence is untouched. An earlier version passed them for a
discount-only "forgetting" step; live data killed that: ~80% of judged
fires land not-engaged (a wide-K cosine fire is usually just a loose
topical match), so evidence decayed roughly 4x faster than genuine
tests could accrue it - the largest tally in a 184-row corpus was 5.5
confirms and every posterior sat pinned at `p0` (156/184 rows at 0.95,
min 0.77), which made the health axis carry no information. The
half-life `L` is therefore denominated in genuine tests: firing near a
conversation neither earns nor costs a samskara anything.

`not-borne-out` is the verdict that gives health teeth. The situation
arose and the predicted tendency did not appear - real but weaker
evidence against the prediction than an active contradiction, so it
counts as a fractional miss (`w_soft = 0.25`, the one hand-chosen
magnitude; `k`, `L`, and `p0` are data-derived). The value is a gentle
launch setting: a counterfactual over the live corpus showed only the
product `w_soft * not-borne-out-rate` is identifiable (the rate is
unknown until the judge runs), and `0.25` keeps the effective decay in
the healthy band even if that rate is high - recalibrate upward from the
observed rate if health under-discriminates. Because `p0` is itself
computed from these tallies, soft misses also pull the population prior
down off its ceiling, so the *whole* corpus gains a discriminating
baseline rather than every row sitting at a near-1 `p0`. There is no
backfill: already-judged threads keep their verdicts, so the corpus
migrates to the new calibration forward, over roughly `L` evaluation
cycles per samskara, as new conversations are judged - a gradual
re-weighting, not a one-time mass decay.

`p0` is the **population's aggregate hit rate** (`samskara_population_p0`:
`sum(confirm) / sum(confirm + disconfirm)` across the user's corpus, weak
neutral fallback under 20 evidence) and `k` is the prior strength
(pseudo-count, 5). A fresh or evidence-less samskara therefore sits at
`p0` - the user's own baseline - not a guessed constant. That is the
"calibrate from aggregate metrics" prior: every individual health is a
shrinkage estimate toward the population. The posterior is a weighted
average of {0,1} outcomes and `p0` in [0, 1], so it is inherently bounded
to [0, 1] - it cannot run away.

`confirm_count` / `disconfirm_count` stay **`real`** (the discount makes
them fractional). An integer column truncated the earlier classifier's
sub-unit increments to 0 and froze the whole corpus at health 0 - the bug
this column's type prevents. The two knobs (`p0`, `L`) are data-derived,
not eyeballed: `p0` from the population tallies, `L` from the typical
evaluation cadence. The old reaction-tally Laplace `(confirm+2) /
(confirm+disconfirm+3)` is exactly the `k*p0` / `k` prior here, now
population-derived instead of flat.

### Decay: relevance-gated forgetting (no wall clock)

There is no wall-clock decay pass. Forgetting IS the evidence discount
above: each time a samskara is genuinely tested without earning a fresh
hit, its prior evidence shrinks and its posterior regresses toward `p0`.
A prediction whose topic never genuinely arises - whether it never fires
at all, or fires only as loose not-engaged matches - never decays, and
waits at its last posterior - untested is not wrong. That is the whole
point of the redesign: decay tracks *being tested*, not elapsed time or
fire volume, so a narrow-but-valid claim is not eroded on the days its
topic is absent.

"Dead" therefore means **repeatedly contradicted** - a posterior driven
well below `p0` by real misses, not mere staleness. The reaper
(`samskara_reap_dead`, the `nak-samskara-reap` pure-SQL cron at minute
:13) deletes only rows whose health is below a RATIO of the owner's own
prior (`health < 0.5 * p0`, per user) AND that have not fired in `>= 14`
days, so genuinely-wrong, long-quiet predictions are cleared while an
untested-but-baseline one is spared (still eligible to fire and prove
itself). The floor is a ratio because an absolute floor was unreachable
arithmetic: the posterior is bounded below by `k*p0 / (m_max + k)` (the
decay ceiling `m_max = 1/(1-d) ~= 14.4`), which at the observed
`p0 ~= 0.95` is ~0.25 - above the old 0.15 floor even for a samskara
contradicted on every test forever, so the reaper could never fire. At
the 0.5 ratio a row is reaped once net miss evidence outweighs roughly
`k` genuine tests' worth of prior.

### Release of never-tested claims: probation + cap-pressure eviction

Relevance-gated decay has a blind spot: a claim whose topic never
*genuinely* arises - the one-off-lookup mints (a burst of questions
about one technology, a single shopping errand) - never accrues
evidence in either direction, sits at `p0` forever, and holds a capped
tier-1 slot. Two release paths clear that residue. Both key on
`confirm_count = 0 and disconfirm_count = 0`, which identifies
never-genuinely-tested exactly (any genuine verdict, even a soft miss,
writes a nonzero tally, and the discount decays tallies toward but
never to zero), and both spare a row with an unresolved fire (it may
be the first genuine test, and the next-day judge hasn't ruled).

- **Probation** (`samskara_reap_untested`, same :13 cron statement as
  `samskara_reap_dead`): never-tested rows older than 45 days are
  deleted. The window is grounded in live-corpus measurement (2026-07,
  daily-active user): claims that ever get genuinely tested see their
  first test at median < 1 day, p90 ~13 days, worst observed ~65 days -
  so 45 days of judge coverage without one genuine engagement means the
  situation isn't part of the user's life. The window is wall-clock and
  calibrated to daily use; a long-idle account under-tests its corpus
  and would need it widened.
- **Cap-pressure eviction** (`samskara_evict_for_mint`, called by
  BOTH tier-1 mint probes - recency and association, via the shared
  `ensureTier1Headroom` gate - when the population cap blocks a
  mint): frees
  one slot by deleting the most-disproven untested row - judged >= 10
  times with zero genuine engagements, >= 14 days old, ranked
  most-judged-first. Decay by replacement: it runs exactly as fast as
  formation pressure demands. Merely-quiet rows (the median untested
  row has ~2 judged fires) are NOT evictable. When no untested victim
  qualifies, a second tier keeps pressure alive as the corpus matures:
  **weakly-established rows gone stale** - at most one full test's
  worth of evidence tally (a single held is 1.0, a lone soft miss
  0.25) whose last genuine verdict is >= 90 days old, ranked
  stalest-first. Without this tier one genuine test ever is a lifetime
  pass, and a mature corpus fills with claims established once and
  never re-engaged. Rows with a real track record (tally > 1.0) are
  untouchable by this tier, the staleness clock only matters under cap
  pressure (an idle account never bleeds), and the pending-fire guard
  applies to both of these tiers. When neither qualifies, a **third
  tier evicts on demonstrated failure**: the lowest-health row whose
  posterior sits more than 15% below the user's own `p0`. Low health
  is earned - under the k=5 shrinkage a row needs roughly two full
  contradictions' worth of net miss evidence to fall below
  `0.85 * p0` - so every victim is a claim the judge genuinely tested
  and rejected, never one that is merely quiet. This tier drops the
  pending-fire guard on purpose: that guard spares a row whose
  in-flight fire may be its FIRST test, but a row this far under
  water cannot be exonerated by one more verdict, and on an active
  day the guard empties the pool (2026-08 measurement: 115 of 150
  tier-1 rows carried a fire awaiting next-day judgment). If no tier
  qualifies the probe skips at cap exactly as it did before eviction
  existed.

Eviction is reachable from BOTH mint probes on purpose. When only the
recency probe could evict, sweep order decided who minted: recency
runs first, evicted, and refilled the slot in the same probe, so the
association probe - gated on the same cap - never saw headroom and its
unconsumed-edge backlog grew without bound (1,082 edges at the 2026-08
audit, months of cross-session evidence never reaching the minter).
With the shared `ensureTier1Headroom` gate, entry to a capped corpus
is decided by whether a qualified victim exists when a probe wants a
slot, not by which probe runs first; within one sweep the two probes
draw victims from the same pool in turn.

All eviction tiers are threshold-gated, so pressure can still dry up:
if the "Probation due" and all "Evictable" readouts sit at zero while
tier-1 is pinned at cap and the mint probe keeps skipping, no release
path has material and formation is starved. This state actually
occurred (2026-08-08): the first two tiers had zero victims - the
judge rework engages most fires now, so `confirm_count = 0` rows
(tier one's requirement) barely exist, and nothing could yet be 90
days stale in a corpus whose judge only started ruling in July - and
every mint path sat blocked at cap for ~42 hours while the
association backlog grew. The health tier is the remedy: it keys on
the one signal the judge rework made trustworthy (a discriminating
posterior) and needs no new state. The earlier-deferred alternative,
demand-driven escalation (relaxing criteria as skipped-at-cap
attempts accumulate), stays deferred for the same reason as before:
it is the only option needing new state (nothing records a skipped
mint), and the health tier's pool regenerates continuously as
verdicts land. Re-evaluate it only if all three readouts sit at zero
while the cap is pinned and probes keep skipping.

A released claim is cheap to lose: if the pattern is real and recurs,
minting re-creates it from fresh substrate. A design road not taken:
scoring "is this topic recurrent?" by cosine-matching each samskara
against the substrate archive was measured and rejected - at the 0.6
substrate floor the mint-cluster centroid matched 30-70% of the entire
archive, and at 0.7 known one-off junk still spanned 12 distinct weeks;
the judge's per-fire rulings are the reliable archive-grounded signal,
already computed out-of-sample. The baseline-sitting *tested* majority
remains bounded by `samskara_collapse_by_cofiring` and the 150-row
population cap, not by decay.

History: this replaced a wall-clock `samskara_decay_sweep` (a per-pass
health nudge on a 30-minute cron) plus a live 1-10 minute reaction
classifier that resolved only ~4% of fires. Both are retired and dropped.
Design of record + the model's derivation:
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
bar but the count is still growing without bound. With the mint
probes' `TIER1_POPULATION_CAP` gate in place this pass is a
backstop for races (a mint slipping through while the count query
fails open), not the routine make-room mechanism - see the
treadmill gotcha.

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
  cofires(A, B) >= p_min_cofires             -- default 10
  lift(A, B)    >= p_min_lift                 -- default 2.0
  p_cosine_lo <= cosine(embed_A, embed_B)    -- default 0.30
  cosine(embed_A, embed_B) < p_cosine_hi     -- default 0.68 (< dedup floor 0.70)

  where lift(A, B) = cofires(A, B) * cohorts / (fires_A * fires_B)
```

Lift is the load-bearing selectivity: observed co-fires over the
co-fires expected if A and B fired independently. Base-rate
binding - two busy predictions colliding because both fire on a
large share of turns - sits at lift ~1 (at or below chance);
genuine co-activation runs several times chance. Raw co-fire
ranking, and even dedup's `cofires / min(fires)` ratio, both fail
here: the ratio still reads ~0.5 for two busy-but-independent
predictions because the rarer member is also busy. A 2026-06-15
prod audit measured the grab-bag pairs (emoji + pork chops + Thai,
each firing 600-1300x) at lift < 1.5 while real constellations ran
2x-25x, so `p_min_lift = 2.0` splits them. The companion
`p_min_cofires = 10` is an absolute-mass guard against lift's
small-sample variance (a pair firing 4x that always co-fires
scores a huge lift on 4 points). Lift is a rate ratio, so the
threshold holds as the corpus grows.

The half-open cosine top end is a separate guard: tier-2 only ever
groups pairs whose embedding similarity sits *below* dedup's merge
floor, so it claims the "related but distinct" band dedup
deliberately leaves alone (see the dedup-coupling Gotcha). The
`p_cosine_lo` floor is effectively inert - the shared prediction
template floors any pairwise prediction-cosine around 0.38 (audit:
`min_cos` 0.381, zero co-firing pairs below 0.30) - and is left
that way on purpose: prediction-cosine is template similarity, not
topical similarity, so raising the floor would filter noise, not
gate coherence. Coherence rides on lift plus the minter's
judgement, not the cosine band.

The group is the strongest-LIFT eligible edge plus every node
sharing an eligible edge with BOTH seed members (not either -
co-firing with one seed member is adjacent, not part of the
constellation), strongest combined lift first, capped at
`p_max_group_size` (default 6). A group smaller than
`p_min_group_size` (default 3) is rejected - a 2-member group is a
dedup candidate, not a compound. The coverage skip then *advances*:
a *covered region* overlaps the candidate by Jaccard >=
`p_overlap_skip` (default 0.60), that seed is skipped and detection
walks to the next-strongest *uncovered* edge rather than returning
empty, so one tier-2 on a dense region no longer masks every other
constellation. A covered region is either an existing tier-2's
child-set OR a recent minter decline (below). The probe budget
(`64 + 16 * (existing_tier2_count + recent_decline_count)`) bounds the
walk while keeping the first uncovered, non-declined seed reachable. A
cheap precondition (at least 8 tier-1 samskaras with `fire_count > 0`)
gates the whole thing before the expensive self-join runs.

Per-member `cofire_weight` (summed co-fire count of that
member's in-group edges) rides back on the result and becomes
the provenance `weight`.

The lift redesign is recorded in
[`plans/samskara-tier2-detection-quality-plan.md`](plans/samskara-tier2-detection-quality-plan.md);
it superseded an earlier raw-co-fire-then-ratio detection that
minted exactly one tier-2 in a 151-samskara / ~29k-fire corpus and
returned empty every sweep.

**Decline memory.** The coverage skip would otherwise know only
*minted* tier-2s, so a candidate the minter *declines* (`confirm:false`)
would be re-offered every sweep - and a persistently-declined top
candidate would starve every weaker uncovered constellation behind it.
`mintTier2Probe` records each clean decline (the sorted child-set) into
`samskara_tier2_declines`, and the candidate RPC folds recent declines
into the same coverage test that handles minted tier-2s. A `null` from
the minter (transport/parse failure) is NOT a verdict and is never
recorded - same non-verdict discipline as the association-mint decline
stamp. Unlike `samskara_pair_declines`, this ledger is **TTL'd, not
permanent** (`v_decline_ttl`, 7 days): a pair decline is over immutable
substrate so the verdict can never change, but a tier-2 decline is over
a co-fire constellation, and the co-fire graph keeps growing - a group
too weak to compound today may accumulate enough joint firing to be
worth re-offering after the window. A re-decline upserts on `group_key`
(the sorted child ids), re-arming the window.

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
  curation -> samskara. `Chat.svelte` mounts the
  single `<SamskaraMoodSync />` component and owns the
  `subscribeToSamskaraInserts` realtime subscription that turns
  `samskara-mint` Broadcast events into `SAMSKARA_MINT_EVENT`. See
  `./chat.md` and [diagnostic-pills.md](./diagnostic-pills.md).
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
  individual exchanges and writes substrate. Samskara rides the
  waitUntil tail (it carries the fleet's only hard timing
  window); reflection is sweep-only on an hourly cadence.
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
- **Second thoughts** - two seams, one in each direction. OUT:
  a refinement turn (the user acting on a doubt verdict) skips
  the standard priming stage but gets ONE read-only samskara
  probe keyed to the doubt note + the original user text
  (`queryFiredSamskaras`, no cohort recorded), so the
  full-context deliberation can weigh the low-context reviewer's
  twinge against learned cross-thread patterns. The original
  turn's fire stays the round's only samskara bookkeeping -
  fire_count, co-fire detection, and the evaluation judge are
  unaffected by the probe. IN: the assimilator forwards a doubt
  verdict on the assistant anchor as `assistant_second_thoughts`
  (the embarrassment-event feed; see the Assimilate contract),
  so repeated misgivings can shape substrate and, downstream,
  mint claims about when confident answers miss for this user.
  See `./second-thoughts.md`.
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
  inflate fire_count, pad the next-day judge's per-thread
  prediction list, and poison co-fire dedup / tier-2 detection
  with spurious Hebbian binding. Live-but-weak matches (the long tail) all sit
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
- **Verdict counts are `real`; the prior is load-bearing.**
  `confirm_count`/`disconfirm_count` MUST be `real`: the
  per-genuine-test discount (`* 0.5^(1/L)`) and the earlier classifier's
  sub-unit increments are both fractional, and an integer column
  truncates them to 0, freezing health at the prior - the bug that
  once euthanized the whole corpus to 0. Any RPC RETURNS TABLE that
  re-declares these as `int` (e.g. `samskara_search_by_prediction`)
  re-introduces the truncation on the way out - keep them `real`.
  Health can no longer "collapse across the board" from a runaway
  decay cadence - there is no decay pass, and the posterior is a
  bounded rate. The remaining failure mode is a systematically harsh
  judge dragging the corpus toward `p0` and below; if you see that,
  look at the judge prompt and `p0`, not a cron schedule.
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
  that round goes empty. A cohort logged but never primed is
  still judged next-day - the judge tests the prediction against
  the user's behaviour in the transcript, not whether the
  assistant's prompt carried the block - and those loose fires
  typically land not-engaged. Not an error; intentional.
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
- **Evaluation is next-day, not in-session.** The judge waits until a
  conversation has settled (next-day + `>= 2`-round gate) and reads the
  whole transcript with hindsight - there is no in-session resolution
  window and no tail-first timing constraint. The tradeoff: a verdict,
  and the health it moves, lands roughly a day after the turn rather
  than minutes after. This replaced a live 1-10 minute reaction
  classifier whose narrow window resolved only ~4% of fires.
- **The `>= 2`-user-message gate is a junk-data filter, not a leak.**
  Single-round threads are excluded from evaluation on purpose: they
  are overwhelmingly "AI as a search engine" one-shots, and judging
  behavioural predictions against a one-question transcript produces
  noise, not evidence. Their fires stay `verdict is null` forever -
  a permanent, bounded pending population (~19% of threads in the
  2026-07 prod audit), not a backlog to drain.
- **The judge is batched, and a zero-verdict run must not advance the
  cursor.** Both halves are load-bearing, learned from the same prod
  failure: the judge originally sent every fired prediction in one
  2048-token completion and marked the thread evaluated regardless of
  the result. Long threads (40-90+ distinct fired samskaras) truncated
  the verdict map, `parseVerdicts` returned empty, and the cursor
  advanced anyway - the judged rate collapsed from 83% to ~5% past ~40
  predictions, and 43% of all fires ever recorded sat permanently
  unjudged BEHIND the cursor, concentrated in exactly the
  evidence-richest threads. `EVALUATION_BATCH_SIZE` (20) bounds each
  completion's output; `finish_reason = 'length'` or an empty parse
  fails the batch. Batching alone is not sufficient: on reasoning
  models `max_completion_tokens` covers the thinking pass, whose burn
  scales with TRANSCRIPT length, not verdict-map size - so the judge
  also needs the large `EVALUATION_MAX_TOKENS` (8192) and the 'low'
  reasoning-effort pin, or long-transcript batches still die at
  `length` with zero content. A run where every batch fails returns
  `no-verdicts` without calling `markEvaluated`, so the thread retries
  (bounded by `evaluation_attempt_count < 3`). If you touch this, keep
  "no verdicts" and "judged" distinguishable - collapsing them is the
  original bug.
- **The judge's skeptical default is scoped to the engagement step
  only.** With a single-step prompt, "default to not-engaged when
  unsure" swallowed the soft-miss bucket entirely: zero `not-borne-out`
  verdicts across 19k judged fires, which drove the population prior
  `p0` to ~0.98 and pinned every posterior at the ceiling - health
  could not discriminate, so fire ranking degenerated to pure cosine
  and the reaper had nothing to reap. The two-step prompt (engagement
  gate first, then held / contradicted / not-borne-out with an
  explicit "do not fall back to not-engaged") exists to keep
  `not-borne-out` reachable. The same class of failure exists on the
  OTHER side of the gate: a consistency-is-confirmation reading of
  `held` rubber-stamps broad meta-tendency predictions (92.5% of
  genuine tests ruled `held` at the 2026-07 audit, `p0` pinned at
  ~0.95), which is why the prompt's held bar demands a pointable
  moment and routes consistent-but-undemonstrated to `not-borne-out`.
  Watch the verdict mix on the Overview panel after any prompt edit:
  a zero not-borne-out rate over a meaningful window means one of
  these regressed.
- **Neutral has no boolean state.** `was_confirmed` is
  true/false/NULL, and a judged not-engaged fire stays NULL -
  indistinguishable on that column from a fire the judge has not
  ruled on yet. `verdict` is the authoritative read: `verdict is
  null` means pending, `verdict = 'not-engaged'` means tested
  with no evidence either way. A query that treats
  `was_confirmed is null` as "not yet judged" is counting the
  not-engaged majority too; filter on `verdict` instead.
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
  not an accident: the assimilate drain and exploratory probes are
  tail-driven (session-responsive), mint-tier2 / dedup / compound-regen
  are cron-only
  (heavy or timing-insensitive), and moving a phase across that
  line should be a deliberate decision.
- **Minting is population-gated; the overflow merge is a backstop,
  not the make-room mechanism.** Both tier-1 mint probes go through
  the shared `ensureTier1Headroom` gate: at `TIER1_POPULATION_CAP`
  (150) they first try cap-pressure eviction and skip when no victim
  qualifies, so at cap the corpus changes only through the reaper
  (repeated real failure), the Hebbian dedup pass (true duplicates),
  and eviction of provably-useless rows. Without the gate,
  every mint at cap forced the collapse RPC's overflow pass to
  greedy-merge two DISTINCT claims at its 0.60 cosine floor - the
  same "related but distinct" band tier-2 detection owns - and a
  2026-07 prod audit measured 49 mints/week churning through that
  treadmill: Venice spend to mint a claim, then a merge that blurs
  two others to make room for it. The gate fails OPEN on a count
  error (a transient blip must not silence minting), which is why
  the overflow pass stays: it catches the rare mint that slips
  through at cap. `TIER1_POPULATION_CAP` and the RPC's
  `p_target_count` must move together - the Deno suite pins the TS
  side and both sites carry mirror comments. Raising the cap is now
  the sanctioned way to grow the corpus; removing the gate is not.
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
  `samskara_fire_top_k` and `samskara_apply_evaluation` have no tier
  filter, so a tier-2 fires, gets judged, and updates its posterior
  exactly like a tier-1 the
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
- **Tier-2 gates on lift; dedup gates on the rarer-member ratio -
  the divergence is deliberate.** dedup (`cofires / min(fires) >=
  0.5`) is hunting *duplicates*, which are perfectly correlated
  (ratio -> 1), so the ratio is the right tool. Tier-2 is hunting
  *distinct-but-co-activating* pairs, and there the ratio fails:
  two busy-but-independent predictions still reach ratio ~0.5
  because the rarer member is also busy. Only lift
  (`cofires * cohorts / (fires_A * fires_B)`, observed over
  expected-under-independence) separates genuine association
  (several times chance) from base-rate binding (~1x). Do not
  "align" tier-2 with dedup by porting the ratio gate - a
  2026-06-15 prod audit proved it admits the exact grab-bag it is
  meant to reject. See the Tier-2 detection formula section.
- **Pair-relate seeds corpus-wide, round-robin, not on the
  recency frontier.** One pair per probe, but the seed is the
  longest-unseeded embedded substrate row (`pair_seeded_at` asc,
  nulls first), stamped on selection so successive probes walk the
  whole corpus instead of re-seeding the newest row. The seed's
  best still-unadjudicated partner (corpus-wide nearest-neighbour by
  `situation_embedding`, above `PAIR_RELATE_COSINE_FLOOR`) is the
  pair the relator rules on. All of this - seed pick, stamp,
  NN, adjudication-exclusion - is one RPC,
  `samskara_pair_probe_candidates`. The earlier version seeded only
  on the newest row and ranked partners within just the 40 newest,
  so associations among older observations went permanently
  unexplored; this fixes that coverage gap. No vector index on the
  scan on purpose (cheap seqscan at corpus scale, hourly not hot -
  same call as the retired memories HNSW); revisit with an ANN index
  only if the substrate corpus makes the seqscan the bottleneck.
- **A quiet corpus goes silent, not chatty.** Both relator
  verdicts persist (accepts in `samskara_associations`,
  declines in `samskara_pair_declines`), and the candidate RPC
  excludes adjudicated pairs - so once a seed's neighbourhood is
  fully ruled on it yields no partner and the probe logs a trace
  line and spends no Venice call (the seed still advances). A
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
  bumps `reinforcement` but does NOT re-trigger minting; the
  reinforcement count grows on the edge while the samskara it
  produced is unaffected. This is deliberate: `health` is the
  verdict posterior (does the prediction hold when tested in
  conversation), a different axis from how often the underlying
  pattern recurs, so recurrence is kept out of it.
- **Mixed-pattern hubs yield fewer samskaras.** A hub's edges
  can span genuinely different tendencies (one observation
  relating to a baking pattern AND a family pattern). The probe
  feeds the whole neighbourhood as one cluster and leans on the
  minter's `confirm:false` guard; decline-stamps guarantee no
  loop, but a messy crossroads hub mints one-or-zero samskaras
  rather than splitting into several. Acceptable as-is - the
  guard keeps it honest. If messy hubs ever prove a meaningful
  fraction of real hubs, revisit from scratch.
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
  a message before the assimilator has caught up, before the
  next-day judge has ruled, before the next regen has
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
   situation embedding (the every-minute embed backfill) -> mint probe
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
`SamskaraMood.svelte`). Two surfaces, NO sub-nav. **Overview** is the
GLOBAL (per-user / corpus-wide) read, reached on tab-open and via the
single top-bar button in `Chat.svelte`'s samskara `TopBarActions`
cluster; **Corpus** is the per-samskara detail, reached by selecting a
sidebar row. Overview is the default landing page.

Overview is a merge of two surfaces that used to be separate top-bar
buttons (**Summary** and **Health**). Both were global per-user reads,
so two buttons for "the global view" read as redundant; they were
collapsed into one page - the compound summary on top, pipeline health
below - behind one **Overview** button. (Earlier still, both lived as
sub-nav tabs next to the per-samskara Corpus detail, which wrongly
implied they belonged to the selected instinct; lifting them to the top
row removed the sub-nav entirely. The button-merge is the second step of
that same simplification.)

- **Corpus** - browse/search/filter/sort the samskara corpus, with a
  tier filter and a "hide similar" cosine slider (the corpus analog of
  the cohort dropdown's cluster slider). Selecting a row shows its
  detail + provenance; for a tier-2 the provenance is its tier-1
  children. Backed by `listSamskarasPage`,
  `searchSamskarasByEmbedding` / `searchSamskarasByText`,
  `samskara_cluster_corpus`, `samskara_provenance_detail`, and
  `samskara_verdict_counts` (the per-samskara lifetime verdict tally).
  Pieces: `src/screens/Samskaras.svelte`,
  `src/components/SamskaraBrowseList.svelte`,
  `src/lib/samskara-browse-store.svelte.ts`,
  `src/lib/ui/samskara-browse.ts`.
- **Overview** - the default landing page, `SamskaraHealthPanel.svelte`.
  Reached on tab-open and via the top-bar **Overview** button (an
  `activity`/pulse icon), which flips the `triggerOverviewView` `$bindable`
  prop; `Samskaras.svelte` watches it, switches `subView` to `overview`,
  and clears `route.samskara_id` so the sidebar deselects. The inverse
  wiring is a `$effect` that flips `subView` to `corpus` whenever
  `route.samskara_id` becomes truthy (sidebar row click or deep link), so
  selecting a samskara always lands on its detail. Two stacked reads,
  loaded by the panel itself and reloaded together by one **Refresh**:
  - **Compound summary** (top, below the refresh row) - the always-on
    prose block (per-user, global) that rides in every system prompt,
    plus a short orientation paragraph on what samskara is. Fetched via
    `samskaraGetCompoundSummary`. The mood legend that used to share this
    surface moved to the conversation-mood modal (see the scope split
    above).
  - **Pipeline health** - silent-failure detection computed live (no
    stored history). The headline severity is the worst of the
    ACTIONABLE signals only: backlog depth (pending assimilate / embed,
    loose `[50, 500]` bars - a snapshot of a few is normal, since the
    tail drains small caps per turn and the sweep is hourly), internal
    inconsistencies (orphan fires, stuck claims - tight bars, should be
    ~0), and the compound-summary regen backlog. That last signal is the
    EVENT arm of `samskara_should_regen_compound` reconstructed
    client-side (samskaras formed since the last regen vs the
    `max(3, ceil(5 * log10(total + 10)))` threshold), NOT the summary's
    age: regen only runs when the hourly sweep visits a user, and the
    sweep only fans out to users active in the last
    `SWEEP_USER_WINDOW_HOURS`, so an idle account's summary drifts past
    the predicate's 6h window with nothing wrong and nothing to do - an
    age-based dot lit amber/red on exactly that benign case. The delta
    only grows while the user is active (which is when the sweep can act),
    so a delta stuck past the bar is a real "not keeping up" signal. The
    age is still shown, as an informational, dot-less row. The windowed
    mint/fire/
    resolution rates, the corpus counters, and the tier-2-candidate
    readout are shown but NOT severity-bearing (see the calibration note
    below). Backed by `samskara_health_snapshot`, `samskara_rates`, and
    the severity thresholds in `src/lib/ui/samskara-health.ts` (named
    constants, tune against observed behaviour).
  - **Tier-2 candidate readout** - "Tier-2 candidate: available (N
    members) / none" in the Corpus card, via `samskaraTier2CandidateSize`
    (calls the same `samskara_tier2_candidate` detection RPC the sweep's
    mint-tier2 phase uses, security-invoker, scoped to `auth.uid()`).
    Informational, not thresholded: a non-empty result is GOOD (detection
    is finding an uncovered constellation to compound) and "none" is the
    normal resting state. This is the instrument that makes the tier-2
    detector's liveness visible - the "empty every sweep" stall the lift
    redesign fixed used to need a manual self-join to diagnose.

**Verdict legibility.** The four judge verdicts (held / contradicted /
not-borne-out / not-engaged) surface on three reads so the soft-miss
bucket is never invisible: the Overview **verdict mix** (windowed,
`samskara_rates` -> `verdictBreakdown`), the Corpus detail's **lifetime
per-samskara tally** (`samskara_verdict_counts` -> `verdictCountList`,
with a trailing `pending` count of fired-but-unjudged), and **per fire**
in the inline `CohortPanel` (each fire badged via `fireVerdictLabel` /
`fireVerdictStatusClass`, since fires in one cohort can carry different
verdicts - the judge rules per samskara). The per-samskara
`confirm`/`disconfirm` stat is the recency-discounted posterior input;
the verdict tally beside it is the raw lifetime count, so not-borne-out
reads as its own bucket instead of folding silently into disconfirm.
These are diagnostic summary reads, not user-facing controls.

**"Awaiting judgment" counts only genuinely-pending fires - junk-thread
sediment expires.** Fires land on every user message, including round
one of a thread that never gets a round two; the judge's junk-data
gate skips such threads forever, so their fires would stay
verdict-null permanently. Unexpired, that sediment inflated the
awaiting-judgment readout (2026-08-10 audit: 1,840 of 2,084 pending
fires, oldest from April) and - the real damage - permanently
shielded 132 of 150 tier-1 rows from probation and guarded eviction,
because the spare-the-pending-test guards read any verdict-null fire
as a test in flight. `samskara_expire_junk_thread_fires` (on the :13
reaper cron) stamps those fires with a terminal `not-engaged` once
the user has demonstrably moved on (a user message in a DIFFERENT
thread 24h+ after the junk thread's newest message - activity-
relative on purpose, so an idle account never expires anything). A
persistently large or growing awaiting-judgment count is therefore a
real judge problem again, not sediment.

**The associations "awaiting mint" count never reaches zero.** A large
share of unconsumed edges are singletons - pairs whose endpoints have
no other unconsumed connections (336 of 1,083 at the 2026-08 audit).
The hub-picker requires >= 2 distinct partners, so singletons wait for
corroboration BY DESIGN: one lone pair is not a pattern yet, and a new
edge touching either endpoint re-qualifies it. Read the count's TREND,
not its level - sustained growth in the reachable share is the "not
keeping up" signal; a stable floor is the resting state.

**Decay-standing legibility.** The release machinery (probation reap +
cap-pressure eviction, see the decay section) surfaces on both
diagnostics reads. The Overview Corpus card shows a **"Probation due"**
count and an **"Evictable (untested / stale / unhealthy)"** triple
(four `samskara_health_snapshot` columns whose predicates deliberately
mirror `samskara_reap_untested` / `samskara_evict_for_mint`'s three
tiers - keep them in lockstep). All are informational, not dotted:
probation-due
drains at the next hourly reap tick (a value that never drains means
the reaper cron is stalled), and a nonzero evictable pool is the normal
resting state while the tier-1 cap is pinned. The Corpus detail pane
adds an **engagement** stat (genuine/judged, `engagementSummary`) to
the verdict tally and a one-line **release status** under it
(`releaseStatus` - established / weakly-established-gone-stale /
awaiting judgment / probation countdown / evictable), with the SQL
thresholds mirrored as named constants in
`src/lib/ui/samskara-browse.ts`. The stale read rides
`samskara_verdict_counts`' `last_genuine_at` column plus the row's own
discounted evidence tally - the same two numbers the SQL stale tier
tests.

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
headline permanently red on it: **unresolved fires**. A fire stays
`verdict is null` until its thread settles and the next-day judge
rules, and some stay pending forever by design (single-round threads
never qualify - the junk-data gate above). Of the fires that ARE
judged, the large majority land not-engaged (~88% at the 2026-07 prod
audit) - loose topical firing is recall doing its job, not a defect.
Neither number is surfaced as a severity bar; the windowed resolution
rate is shown with a note that low is normal. A genuinely stuck
pipeline shows up as a deep, persistent backlog, or as threads parked
at the evaluation attempt gate - which ARE actionable signals.
The headline severity therefore considers only backlog,
inconsistencies, and the compound-regen backlog (the event arm of the
regen predicate, not summary age - see the observability section above).

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
