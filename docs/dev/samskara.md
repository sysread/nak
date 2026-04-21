# Samskara

> **Status**: planned feature on the `samskara` branch.
> No code shipped yet; this doc captures the design before
> implementation so the contracts and gotchas are reviewable
> in isolation. Remove this banner when v1 lands in `main`.

The chat model's progressively-built predictive model of the
user. Per-round observations (substrate) compound through
background clustering into emergent predictive claims
(samskaras); cohorts of samskaras that fire together compound
once more into higher-tier samskaras. The accumulated set is
periodically summarized into prose that lives always-on in
the system prompt; a per-turn cosine fire surfaces
situationally-relevant samskaras on top.

The intent is the opposite of "born yesterday" - every
conversation, the model carries some calibrated bias from
prior conversations with the same user, without having to
fit the entire history into a context window.

## Role in the app

A samskara is a one-line predictive claim ("in situations
like X, this user tends to Y") with an embedding so it can
be fired by cosine similarity to the user's current message.
There is no fixed affect/trait vocab - samskaras are
free-form text and their structure is emergent through
clustering, not declared by an enum.

Per turn the chat loop does two cheap reads: it pulls the
cached compound prose summary into the system prompt
unconditionally, and it fires a wide cosine query against
the samskara table to collect situationally-relevant ones.
The combined block is appended to the system prompt for
that round only.

Everything else - assimilation, pair labelling, clustering,
minting, reaction classification, decay, compound
regeneration - runs in a dedicated background worker
between user messages. The worker uses the project's "fast
model" tier for all LLM calls. Async-friendly: nak chat is
SMS-shaped (the user can wander off for an hour and come
back), so formation has time to catch up between turns
without blocking anything.

## Files

Planned. Marked `(planned)` until they ship; this section
should be the first thing updated as the code lands.

- `src/lib/samskara/index.ts` (planned) - public surface
  the chat loop calls: `fireSamskaras(userId, threadId,
  userText): Promise<FireResult>`,
  `recordSubstrateStub(userId, threadId, msgIds): Promise<void>`,
  `getCompoundSummary(userId): Promise<string | null>`,
  `formatPriming(fire: FireResult, summary: string | null):
  string`. One module so the chat loop has exactly one
  import for samskara-side work.
- `src/lib/samskara/format.ts` (planned) - prose formatter
  for the priming block. Token-budget aware. Renders the
  compound summary as a leading paragraph and the fired
  samskaras below, weakest-but-relevant ones rendered in
  abbreviated form so the long tail is present without
  dominating.
- `src/lib/embeddings/sources/samskara-substrate.ts`
  (planned) - registered with the embeddings worker.
  Polls `samskara_substrate where situation_embedding is
  null`, embeds via Venice, saves under a guard.
  Mirrors the memories source exactly.
- `src/lib/agents/samskara/{agent,loop,manager,prompt,
  worker}.ts` (planned) - the formation worker. Mirrors
  the reflection worker shape (`src/lib/agents/reflection/`)
  but its `loop.ts` round-robins across multiple phases
  per cycle (assimilate, pair-relate, mint, reaction-
  classify, compound-regen, decay) instead of doing one
  thing per cycle.
- `src/lib/agents/samskara/prompts/{relator,minter,
  reaction,assimilator,summary}.ts` (planned) - the five
  fast-model agent prompts. Each is a small, sharply
  scoped prompt; see the Contracts section for what each
  returns.
- `supabase/schema.sql` (samskara section, planned) - all
  six tables, RLS, and the claim / fire / reinforce RPCs.
  Schema additions are append-only and idempotent like the
  rest of the file.

## Entry points

- **`runChatLoop` entry, before round 1's
  `requestMessages`** - call
  `getCompoundSummary(userId)` and `fireSamskaras(userId,
  threadId, userText)` in parallel. Both are bounded
  Supabase queries with no LLM calls; combined latency is
  well under what the user perceives as "send delay."
  Pass the formatted priming string through the existing
  `buildSystemPrompt` opts as a new `promptAppendix` field
  (see `./chat.md` for the seam).
- **`runChatLoop` end of round, after the assistant row
  persists** - call `recordSubstrateStub` with the message
  ids. No LLM call here; the worker enriches it later.
  Also writes one `samskara_fires` row per fired samskara
  from this round, so reaction classification has the
  cohort to work against.
- **`samskaraManager.start()` in
  `activate()`** - acquires the
  `worker_kind='samskara'` lease (independent of the
  `'embedding'`, `'reflection'`, and `'summary'` leases),
  spawns the formation worker. Settled and torn down by
  `samskaraManager.stop()` in `lock()`, same shape as
  every other worker.
- **Embeddings worker cycle** - the existing worker picks
  up `samskara_substrate` rows whenever the substrate
  source is its turn in the round-robin. No new entry
  point, just a new registered source.

## Data model

Six tables, all RLS by `auth.uid() = user_id`, all created
with `if not exists`, RLS policies dropped-and-recreated
following the project's idempotency convention (see
`schema.sql`'s header comment).

### `samskara_substrate`

Per-round episodic observations. Written as a stub at
chat time; enriched in the background.

- `id uuid primary key default gen_random_uuid()`
- `user_id uuid not null references auth.users(id)`
- `thread_id uuid not null references public.threads(id)
  on delete cascade`
- `user_message_id uuid not null` and
  `assistant_message_id uuid` (nullable when the
  assistant turn errored or was aborted) - the anchors
  the assimilator reads to compose `situation` /
  `outcome`.
- `situation text` and `outcome text` - filled by the
  assimilator agent. Null at chat-loop write-time.
- `situation_embedding vector(2048)` - null until the
  embeddings worker fills it from the enriched
  `situation` text. Padded from 1024-dim Venice native;
  see `padEmbeddingForStorage` in `models.ts`.
- `valence real` - continuous scalar, roughly [-1, 1],
  written by the assimilator. Unlike scratch's
  categorical affect vocab, this is a single number
  capturing how positive/negative the observation
  felt. Zero is neutral.
- Standard claim columns
  (`embedding_claim_holder text`,
  `embedding_claim_expires timestamptz`,
  `assimilate_claim_holder text`,
  `assimilate_claim_expires timestamptz`).
- `created_at timestamptz default now()`.

### `samskara_associations`

Pair-labels between substrate rows. Written by the
formation worker.

- `id uuid primary key default gen_random_uuid()`
- `user_id`, `a_id`, `b_id` (FKs into `samskara_substrate`)
- `articulated_relation text` - the relator agent's
  short label.
- `relation_embedding vector(2048)` - lets us cluster
  associations to mint samskaras.
- `kind text check (kind in ('pattern','contrast',
  'prerequisite','consequence'))` - the relator's
  taxonomy. The fifth scratch category, `'orthogonal'`,
  is filtered at agent boundary and never written.
- `reinforcement int default 1` - bumped by `on
  conflict (user_id, a_id, b_id, articulated_relation)
  do update`.
- `last_reinforced_at timestamptz default now()`.
- `created_at timestamptz default now()`.

### `samskaras`

The unit. Tier 1 are minted from substrate-cluster mints;
tier 2 are minted from cohort-fire patterns of tier-1
samskaras. Cap is `tier in (1, 2)` - no tier 3.

- `id uuid primary key default gen_random_uuid()`
- `user_id uuid not null`
- `tier int not null check (tier in (1, 2))`
- `prediction text not null` - the minter's
  one-or-two-line predictive claim.
- `prediction_embedding vector(2048) not null` - what
  the chat-time fire query runs against.
- `inner_voice text` - optional silent self-talk
  fragment; rendered in the priming block when present.
- `valence real` - aggregated from the substrate or
  child-samskara provenance. Same continuous scalar as
  on substrate.
- `confidence real not null default 0.5` - Bayesian-ish
  via reaction reinforcement (see Contracts ->
  reinforcement formula).
- `health real not null default 1.0` - decays over
  time and on disconfirm; clamped to [0, 1]. NO
  threshold filter at fire time (see Gotchas).
- `fire_count int not null default 0`,
  `confirm_count int not null default 0`,
  `disconfirm_count int not null default 0`.
- `last_fired_at timestamptz`.
- `created_at`, `updated_at` timestamptz.

### `samskara_provenance`

Audit trail for what each samskara was minted from. Kept
even if the underlying substrate or association is
deleted - debugging beats normalization here.

- `samskara_id uuid not null references samskaras(id) on
  delete cascade`
- `user_id uuid not null`
- `kind text not null check (kind in ('substrate',
  'association', 'samskara'))` - tier-1 samskaras have
  `'substrate'` and `'association'` provenance; tier-2
  samskaras have `'samskara'` provenance pointing at
  their tier-1 children.
- `ref_id uuid not null` (no FK; tolerates orphans).
- `weight real default 1.0`.
- `primary key (samskara_id, kind, ref_id)`.

### `samskara_fires`

One row per samskara fired per turn. Drives reaction
reinforcement and cohort detection.

- `id uuid primary key default gen_random_uuid()`
- `user_id uuid not null`
- `samskara_id uuid not null references samskaras(id) on
  delete cascade`
- `thread_id uuid not null`
- `cohort_id uuid not null` - shared across the set of
  samskaras fired together on the same turn.
  Lets the reaction classifier and the tier-2 mint
  step both operate on the cohort as a unit.
- `fired_at timestamptz default now()`
- `score real not null` - the
  `cosine * sqrt(health * confidence)` ranking score
  at fire time, kept for analytics.
- `was_confirmed bool` - null until the reaction
  classifier resolves it; one of true (confirm), false
  (disconfirm), or null (neutral / abandoned).

### `samskara_compound_summary`

Cached prose, one row per user. The always-on block
that lives at the top of every system prompt. Rewritten
by the compound-regen phase of the worker on a hybrid
trigger (see Gotchas).

- `user_id uuid primary key references auth.users(id)`
- `summary text not null` - the prose. Token-budget
  capped (see Contracts).
- `samskara_count_at_regen int` - count of live
  samskaras at the last regeneration; the trigger
  formula reads this.
- `last_regen_at timestamptz default now()`.
- `regen_holder text`, `regen_claim_expires timestamptz`
  - claim columns so concurrent workers across devices
  don't both regenerate at once.

### Lease

`worker_leases` row with `worker_kind='samskara'`. New
lease kind, runs concurrently with `'embedding'`,
`'reflection'`, and `'summary'` leases. Same TTL /
heartbeat numbers as the others (45s / 20s) - no need
to invent new constants.

## Contracts

### Chat-loop side (synchronous, no LLM)

- `getCompoundSummary(userId): Promise<string | null>` -
  reads the cache row. Returns null on cold start (first
  session, no compounds yet) or when the row's
  `last_regen_at` is older than a hard staleness ceiling
  (24h, say) - if the worker has been down for a day,
  we'd rather inject nothing than something stale enough
  to be misleading.
- `fireSamskaras(userId, threadId, userText):
  Promise<FireResult>` - embeds `userText` via Venice,
  runs the fire RPC `samskara_fire(user_id, embedding,
  k_max)` on Supabase. Returns the cohort it intends
  to fire AND writes the `samskara_fires` rows
  (`cohort_id` is generated client-side as a uuid).
  `k_max` is computed as
  `ceil(K_BASE * log10(live_samskara_count + 10))` per
  the user's "log10 capping" preference - K_BASE
  pinned at 5, so a corpus of 10 samskaras allows
  ~5 fires, 100 allows ~10, 1000 allows ~15.
- `formatPriming(fire, summary): string` - renders the
  appendix block. Layout: leading paragraph from
  `summary` (if present), then the fired samskaras as
  bullet lines, sorted by `score` descending. Total
  budget capped at ~600 tokens; weakest-but-relevant
  fires get truncated rendering when the budget tightens
  rather than being dropped, so the long tail stays
  present (see Gotchas).
- `recordSubstrateStub(userId, threadId, msgIds):
  Promise<void>` - one INSERT into `samskara_substrate`
  with `situation` / `outcome` / `valence` /
  `situation_embedding` all null. Worker fills these in.

### Background-worker side (async, fast-model agent calls)

Each phase is a one-row-at-a-time cycle that mirrors the
embeddings worker's claim-then-process-then-save shape;
the worker's `loop.ts` round-robins across phases per
cycle so a single phase falling behind doesn't starve
the rest.

- **Assimilator** -
  `assimilate(userMsg, assistantMsg) -> {situation,
  outcome, valence}`. Takes the raw exchange, returns
  the enriched substrate fields. Explicit prompt:
  produce `situation` as third-person observation
  ("user asked X about Y, expressing Z"), `outcome` as
  what the assistant did and how it landed, `valence`
  as a [-1, 1] scalar.
- **Relator** - `relate(a, b) -> {kind, label} |
  {kind: 'orthogonal'}`. Substrate-pair labelling. Same
  taxonomy as scratch's relator agent
  (`pattern | contrast | prerequisite | consequence |
  orthogonal`), but the orthogonal verdict skips the
  write entirely.
- **Minter** - `mint(cluster) -> {confirm, prediction,
  inner_voice, valence, confidence} | {confirm: false}`.
  Used at both tiers: tier-1 mint inputs are clusters of
  associations whose endpoints share a theme; tier-2
  mint inputs are cohorts of tier-1 samskaras that have
  fired together repeatedly. The `confirm: false`
  return is a kill-switch so the agent can refuse to
  mint a weak cluster even if the heuristics let it
  through.
- **Reaction-classifier** -
  `classify(cohort, nextUserMsg) -> {confirm: uuid[],
  disconfirm: uuid[], neutral: uuid[]}`. Reads the
  cohort that fired on the previous turn plus the
  user's response to the assistant; partitions the
  samskara_ids into reaction buckets. Updates
  `samskara_fires.was_confirmed` and bumps
  `samskaras.confirm_count` / `disconfirm_count` +
  `confidence` accordingly.
- **Compound-summarizer** -
  `summarize(samskaras[]): string`. Reads the top
  `K_SUMMARY * log10(N + 10)` live samskaras ranked by
  `health * confidence`, returns prose. Writes to
  `samskara_compound_summary`.

### Reinforcement formula

Bayesian-ish, lifted from scratch with the
documentation that future-us will need:

```text
on confirm:
  confirm_count += 1
  confidence = (confirm_count + 2) / (confirm_count + disconfirm_count + 3)
on disconfirm:
  disconfirm_count += 1
  confidence = (confirm_count + 1) / (confirm_count + disconfirm_count + 3)
```

Cohort co-fires get a small modifier: when N samskaras
fire together and the cohort is confirmed, each cohort
member gets a `+1 / sqrt(N)` weight on its confirm
count rather than the full +1, so a 5-strong cohort
contributes meaningfully but doesn't dominate single-
fire signal.

### Decay formula

Two passes, runs in the decay phase of the worker
cycle:

```text
stale-fire decay:
  health -= 0.02 where last_fired_at is null
                    or last_fired_at < now() - interval '60 days'
disconfirm decay:
  health -= 0.10 where disconfirm_count > confirm_count
                    and disconfirm_count + confirm_count >= 3
```

Health is clamped to `[0, 1]`. There is **no** filter
that hides decayed samskaras at fire time - see Gotchas.

### Compound-regen trigger

Hybrid (time + event), with log10 dampening on the
event side so a chatty user doesn't thrash regeneration
as the corpus grows:

```text
should_regen =
  (now() - last_regen_at) > 6 hours
  OR
  events_since_last >= max(3, ceil(K_REGEN * log10(samskara_count + 10)))
```

`events_since_last` counts net mints + meaningful
health changes (a confirm/disconfirm crossing a
0.1-magnitude band) since the last regen. K_REGEN
pinned at 5.

## Interactions with other features

- **Chat** - the chat loop is the only synchronous
  reader of samskara state. `runChatLoop` reads the
  compound and the fire at round-1 entry, then writes a
  substrate stub plus a fire-log row at end-of-round.
  The `buildSystemPrompt` change adds `promptAppendix`
  to its options struct; samskara is the only initial
  caller. See `./chat.md`.
- **Embeddings** - `samskara-substrate` registers as a
  third source in the existing embeddings worker
  alongside memories and threads. Pure embed work; no
  LLM calls in this path. The worker's round-robin
  handles the new source automatically. See
  `./embeddings.md`.
- **Memory** - distinct system. Memories are facts the
  user/assistant chose to commit; samskaras are
  emergent predictive bias the model formed on its own.
  No data flows between them today. The reflection
  agent reads thread transcripts; the samskara
  assimilator reads individual exchanges. They run on
  separate workers with separate leases. See
  `./memory.md`.
- **Reflection / summary workers** - peer workers,
  separate `worker_kind` values, separate leases.
  Samskara assimilation looks at one exchange at a time
  and writes substrate; reflection looks at settled
  threads end-to-end and writes memories; summary
  produces thread-level prose. Three different
  granularities, three different stores.
- **Tools** - none. Samskara is intentionally not
  exposed as a tool (no `samskara_search`, no
  `samskara_invalidate`). It's an autonomic system; if
  the user wants to forget something they said, the
  recourse is the (planned) inspector page or a manual
  Supabase edit. Keeping it out of the tool surface
  keeps the model from reasoning about its own bias as
  a thing it can game.
- **Settings** - in v1 there is no settings surface
  for samskara (no enable/disable, no thresholds, no
  vocab knobs). The system is on or it's removed; no
  middle ground. If we ever expose tuning, it's a
  separate change with its own Settings work.
- **Auth-session** - same as every worker. The
  samskara worker requires a live session; lock()
  releases the lease.

## Gotchas

- **No health threshold at fire time.** The natural
  instinct is to filter out samskaras with `health <
  X` from the fire query; that defeats the design.
  Three near-dead samskaras co-firing is exactly the
  signal we want to surface, because cohort
  reinforcement can pull them back from the brink and
  the formation worker can mint a tier-2 compound
  from the cohort. The fire RPC ranks by
  `cosine * sqrt(health * confidence)` so weak-but-
  relevant samskaras break through. The token budget
  in `formatPriming` is what bounds the long tail,
  not a SQL filter.
- **Two injection mechanisms, both always-on.** The
  compound prose summary captures stable bias across
  every turn; the per-turn cosine fire surfaces
  situational bias. Either one alone is wrong: only
  the summary is too coarse to match this turn's
  situation; only the fire is too jittery and lacks
  the stable across-turn personality the user is
  trying to build. Future contributors will be tempted
  to consolidate them; resist.
- **`shape_signature`-style dedup is intentionally
  absent.** Scratch uses a sign-quantized SHA-256 of
  the embedding to dedupe attachments across projects
  on a single user's machine. Nak is single-user PWA
  with no cross-project surface, so the dedup
  gymnastics serve no purpose here. The `samskaras`
  table's natural dedup is the cluster minter's
  prerogative: if two clusters would produce the same
  prediction, the minter is supposed to refuse one.
- **Embedding dimensions are padded to 2048 on disk;
  fire and similarity queries use the padded form.**
  The padding (zero-extension) is cosine-invariant.
  If you ever introduce a path that hashes or
  fingerprints the embedding (you shouldn't, see the
  previous gotcha), unpad first or the trailing zeros
  will dominate the signature.
- **Cohort fires get a sqrt-N reinforcement weight, not
  full +1 each.** A 5-strong cohort all confirming
  contributes `5 * (1/sqrt(5)) = sqrt(5) ~ 2.24`
  total confirm-count, not 5. This stops large
  cohorts from dominating individual-fire signal but
  still lets the cohort reinforce its members
  meaningfully. The choice of sqrt vs log vs linear
  was empirical in scratch; revisit if cohort
  dynamics misbehave.
- **Compound-regen has log10 dampening in two places**
  - on the event-count side of the regen trigger (so
  a chatty session doesn't thrash) and on the
  inclusion cap of which samskaras feed the summary
  (so the prose stays bounded as the corpus grows).
  Both use `log10(N + 10)` so a fresh user with N=0
  still gets a sensible value.
- **Reaction classification reads the user's NEXT
  message, not the same turn's user message.** The
  fire happens on turn T's user input; reaction is
  classified from turn T+1's user input (responding
  to the assistant's reply on turn T). The 10-minute
  resolution window from scratch ports straight over -
  fires older than 10 minutes are left unresolved and
  age out via decay rather than being force-classified
  by a stale next-turn read.
- **Samskara is opaque to the user in v1.** No UI
  surface, no tool to inspect, no settings to tune.
  Visibility is via structured logs only (every
  fire with score / cohort, every mint, every
  reaction decision, every decay event). When debugging
  user-reported "the assistant is acting weird," logs
  are the only window. Keep them dense and stable -
  changing the log shape breaks debugging workflows
  that don't have a UI substitute.
- **Cap recursion at tier 2.** A tier-3 mint
  (compounds-of-compounds) is mathematically
  defensible but pragmatically a noise amplifier and
  a debugging nightmare. The `tier in (1, 2)` check
  on `samskaras` is load-bearing; lifting it should
  be a deliberate design change, not an oversight.
- **`samskara_compound_summary.summary` can be NULL on
  cold start AND can be invalidated to NULL when a
  staleness ceiling trips.** The chat-loop reader
  must handle both - a missing summary just means
  "no compound block this turn," not an error.
  Returning empty string vs null is fine either way;
  pick one in `getCompoundSummary` and document it
  there.
- **Eventual consistency is the contract, not a
  caveat.** The user can send a message before the
  assimilator has caught up on the previous turn's
  substrate, before reaction classification has run,
  before the next regen has fired. None of this is
  an error - the chat loop reads whatever's currently
  in the database and proceeds. If the formation
  worker is hours behind, the model just operates on
  staler bias. The system degrades gracefully rather
  than blocking.

## Where to go next

- `./chat.md` - the seam where samskara plugs into the
  per-turn flow.
- `./embeddings.md` - the worker pattern the substrate
  source mirrors.
- `./memory.md` - the closest sibling system; useful
  for understanding why samskara is structured
  differently (emergent vs declared, opaque vs
  user-facing, autonomic vs tool-driven).
- `./architecture.md` - the worker model in context.
