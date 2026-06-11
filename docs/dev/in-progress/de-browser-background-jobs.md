# De-browser the background jobs

## STATUS (2026-06-11)

**C1, C2, and C3 are all implemented, and the milestone is
closed** (dates in the Items list; designs below). Third of the
three
[tighten-the-control-surfaces](./tighten-the-control-surfaces.md)
milestones. The lease apparatus is gone end to end: the
browser-side files, the orphaned `SupabaseService` wrappers, and
the `worker_leases` table + its RPCs (replaced in the schema by an
idempotent teardown block).

**The rule:** a job that is not UI-scoped or ongoing-chat-scoped
must not depend on a browser tab being open. **Satisfied** - zero
Web Workers and zero browser background jobs remain.

## Items

- **C1. Retire the browser supervisor.** Implemented 2026-06-11
  (design in "C1 design" below); the five units run in the venice
  function off the chat-turn tail and the hourly curation sweep,
  and the supervisor + its lease apparatus are deleted. Full
  scoping in
  [planned-changes.md](../planned-changes.md) ("Retire the browser
  supervisor"): port auto_title / summary / topics on the
  reflection-style turn tail (tail placement is load-bearing for
  title latency), memory_topics / recipe_topics as cron sweeps
  (these are the server-writes/browser-drains gap the workshop
  migration created), and delete the supervisor worker plus its
  whole lease apparatus. All five together or not at all - a
  partial port keeps the apparatus alive.
- **C2. Port bias. Implemented 2026-06-11** (design + outcomes in
  the "C2 design" section below). Lease became the hourly
  `nak-bias-sweep` cron; the per-thread claim columns stay as the
  mutual exclusion. The two open design questions resolved harder
  than the re-inspection guessed: the exclusion set was deleted
  outright (the day-gate subsumes it), and the aggregate
  dirty/throttle state collapsed into the cron cadence plus a 24h
  freshness floor.
- **C3. Port the samskara formation loop. Implemented 2026-06-11**
  (design in "C3 design" below). The formation rotation runs in
  the venice function as `samskaraOnTurnTail` (turn tail, between
  curation and reflection) plus the hourly `nak-samskara-sweep`
  cron at :23; mint toasts ride the realtime INSERT relay on
  `samskaras`. The chat-scoped half (fire, substrate stub,
  compound-summary read, priming format, mood pill) stayed
  browser-side as planned. Samskara was the last lease tenant, so
  the lease apparatus went with it end to end: the browser files
  (`base-manager.ts`, `holder.ts`, `embeddings/lease.ts`, the
  manager wiring, the logger's worker postMessage relay), the
  orphaned `SupabaseService` wrappers, and the `worker_leases`
  table + RPCs (idempotent teardown block in schema.sql).

  **Decay lifted early (2026-06-11).** Upstream 13ef213 flagged
  the decay phase as the cleanest pre-port lift (pure SQL, no LLM,
  no in-worker consumer, predicates row-local), so it moved ahead
  of the rest of C3: `samskara_decay()` (per-user invoker) became
  `samskara_decay_sweep()` (cross-user definer) driven by the
  `nak-samskara-decay` pg_cron job at `13,43 * * * *`, and the
  browser worker's decay phase + throttle were deleted. QA:
  `docs/qa/use-cases/samskara-decay.md`. Dedup
  (`samskara_collapse_by_cofiring`) is NOT row-local (per-user
  pair enumeration + population cap), so it rode the full C3
  port instead and now runs per user in the hourly sweep.

## Stays browser-side by definition

Intuition and context-recall (ongoing-chat-scoped), the
composer/catalog, the manual-run strips (UI).

## C1 design (2026-06-11)

Baseline QA executed first per the convention:
`docs/qa/use-cases/supervisor-units.md` logs the browser-supervisor
behavior the port must preserve (single-burst drain, same-rotation
title-then-tag, no `updated_at` bumps, summary-triggered re-embed).

### Drivers

Reflection's dual-driver shape, applied to all five units:

- **Turn tail** (`getStreamingResponse.ts`, next to the reflection
  fire): one `curateOnTurnTail(admin, userId)` promise under its own
  `edgeWaitUntil`. Runs auto_title FIRST and sequentially (title
  latency on a brand-new conversation is the load-bearing UX), then
  topics, summary, memory_topics, recipe_topics. The last two ride
  the tail as well even though their work supply is not chat turns:
  an empty-queue probe is one cheap RPC, and it preserves the
  baseline's "tags land within minutes while the user is active"
  feel. The tail is sufficiency for the thread-shaped units and
  opportunism for the tag queues.
- **Cron sweep** (`curation-sweep` route, `sweepHandler` factory,
  pg_cron `57 * * * *` - the free slot): global catch-up for all
  five queues. This is what closes the server-writes/browser-drains
  gap: a rem consolidation at 3am re-queues memory tags and the
  sweep drains them with no tab open. Unlike the one-row reflection
  sweep, each queue drains up to a per-tick row cap (tag queues
  burst after a librarian consolidation; one row per hour would
  never catch up). Cap hit is logged - no silent truncation.

### Schema

Follows the reflection precedent exactly:

- The existing per-user claim/save/clear RPCs (auto_title, summary,
  topics x claim/save/clear; memory_topics, recipe_topics x
  save/clear) gain the b-strict `p_user_id uuid default null`
  overload (`coalesce(p_user_id, auth.uid())`) so the turn tail's
  service-role client can scope them. Browser callers are gone
  after this milestone, but the overload keeps the functions
  role-agnostic rather than forking them.
- Five new global SECURITY DEFINER sweep claims
  (`claim_next_*_for_*_sweep`), mirroring
  `claim_next_thread_for_reflection_sweep`: scan across users,
  return the claimed row plus `user_id` (and the vocab CTE scoped
  to the candidate row's user, not `auth.uid()`).
- Per-row claim TTL is the shared 120s the browser supervisor
  actually passed to every unit (CURATION_CLAIM_TTL_SECONDS) - the
  work shape per row is unchanged.

### Server agents

One module per unit under `supabase/functions/venice/agents/`,
prompts ported verbatim from the browser copies (behavior parity is
the QA contract). Non-streaming completions via `toolComplete`;
model ids hardcoded per agent, mirrored from the browser
`AGENT_MODELS` registry at port time (same approach as
`REFLECTION_MODEL`). Edge logger sources drop the browser's
`-worker` suffix: `auto-title`, `summary`, `topics`,
`memory-topics`, `recipe-topics`.

### Deletions (the payoff)

The supervisor worker + manager + loop, the five browser unit
loops/agents/prompts, `title-gen.ts` (if no other caller), the
`nak:supervisor-worker` Web Lock, the supervisor `worker_leases`
partition, its heartbeat and session-token forwarding, the
start-payload model wiring, and the browser-side unit tests (the
ported logic gets Deno coverage in the functions island instead).

### Risks the QA re-execution must check

- Open-tab freshness: the browser worker wrote from inside the tab;
  the UI now learns about titles/topics/summaries via realtime. If
  the sidebar title or the dropdowns go stale after the port, the
  realtime delivery (not the agents) is the suspect.
- Hosted waitUntil lifetime now also carries the tail curation
  chain (five quick completions worst-case) on top of reflection -
  same soft-degradation posture, sweep is the backstop.

## C2 design (2026-06-11)

Baseline QA already passing:
`docs/qa/use-cases/bias-pipeline.md` (post-starvation-fix rows)
records the behavior the port must preserve - queue-head claim with
the count predicate inline, full-drain claim/agent/save chains,
zero-observation saves still stamping `bias_processed_at`, and the
aggregate recompute updating `bias_summary`.

### Drivers: cron-only, no turn tail

The one fleet member that does NOT get the dual-driver shape.
Analyze eligibility requires `threads.updated_at` before today's
local midnight - by construction, the thread a chat turn just
touched is never eligible at turn time, so a turn tail could only
ever drain *yesterday's backlog*, which is exactly what the hourly
sweep does. Bias is also the least time-critical feature in the
app (results surface only in the diagnostics modal and the next
day's prompt block). One driver, one code path.

Each sweep tick runs both phases in order: analyze (drain up to
the per-tick thread cap, cap hit logged) then aggregate. The
in-memory `aggregateDirty` / bootstrap-probe / throttle machinery
all collapses into the cron cadence: aggregate recomputes for
(a) every user who got an analyze save this tick, plus (b) any
user whose oldest `bias_summary.computed_at` is older than 24h -
the daily floor matters because the posterior and feedback EMA
are age-weighted, so tiers drift even with no new observations.
`biasSummaryFreshness` (the bootstrap probe) has no successor.

### Exclusion set: deleted, not replaced

The re-inspection suggested replacing the postMessage'd
open-tab id list with a recency window, but the recency window
already exists: the `p_today_start` gate excludes everything
updated today, which is a superset of "open and active in a tab
right now". The save RPC's user-message-count guard covers the
mid-analysis race (a message landing during analysis drops the
save and releases the claim). `p_exclude_ids` and the
`active-conv-ids` postMessage channel are deleted with nothing
in their place.

### Timezone: per-user, from the profile

The browser computed "today's local midnight" from the device
clock. The server has no device clock; the sweep claim computes
each candidate's midnight from the profile's `displayTimezone`
via `nak_safe_timezone` (the reflection-sweep precedent). Known
semantic shift - the old code deliberately preferred the device
wall clock for travelers - accepted: the divergence window is
hours at most and the worst case is analyzing a thread the
traveler is still using, which the save-time count guard already
tolerates.

### Schema

- `bias_claim_next_thread_for_sweep(p_holder_id, p_ttl_seconds,
  p_min_user_messages)` - SECURITY DEFINER, cross-user, mirrors
  the per-user claim (inline count predicate and all) but
  computes `p_today_start` per candidate from the owner's
  timezone and returns `user_id` alongside `thread_id`,
  `user_message_count`, `active_biases`. Service-role only.
- b-strict `p_user_id uuid default null` overloads on
  `bias_save_observations`, `bias_processed_threads_for_bias`,
  and `bias_reactions_for_bias` so the sweep's service-role
  client can scope the save and the aggregate reads per claimed
  user. `bias_summary` upserts go through the admin client with
  an explicit `user_id` (the browser method was already a direct
  table upsert, not an RPC).
- Per-thread claim columns (`bias_claim_holder` / `_expires`)
  carry forward unchanged as the mutual exclusion; TTL stays
  300s (one LLM call against a long transcript).
- `nak_trigger_bias_sweep()` + pg_cron `nak-bias-sweep` at
  `3 * * * *` (free minute; pg_net ladder is otherwise
  :07/:17/:27/:37/:47/:57).

### Server agent

`supabase/functions/venice/agents/bias.ts` exporting
`runBiasSweepTick(adminClient)` for the `bias-sweep` route via the
existing `sweepHandler` factory. Observer/reactor prompt ported
verbatim from `src/lib/agents/bias/prompts.ts`; model hardcoded
`mistral-small-3-2-24b-instruct` (the browser `AGENT_MODELS.bias`
entry at port time). Edge logger source `bias` (drops the
`-worker` suffix, per the C1 convention); per-claim loggers name
the row's owner. The aggregate math (`aggregatePosterior`,
`feedbackEMA`, `clampConfidence`, the confidence floor/cap and
`MIN_USER_MESSAGES` constants) MOVES into the function tree -
after the worker deletion the browser no longer runs any bias
math. `src/lib/bias/` keeps only what the chat path and modal
read (catalog, format, types); audit its exports post-port.

### Deletions (the payoff)

`src/lib/agents/bias/` entirely (agent, loop, manager, prompts,
worker), the `nak:bias-worker` Web Lock and its `worker_leases`
partition use, the `active-conv-ids` plumbing in the state layer,
the worker-only `SupabaseService` wrappers (`biasClaimNextThread`,
`biasSaveObservations`, `biasSummaryFreshness`,
`biasProcessedThreadsForBias`, `biasReactionsForBias`,
`biasUpsertSummary`), the `AGENT_MODELS.bias` entry, and the
browser bias-loop tests (ported logic gets Deno coverage).
`biasClearThread` and the chat/modal reads stay - they are
chat-scoped. The shared lease apparatus had one tenant left after
this (samskara) and went with the C3 port: the browser-side files
(`base-manager.ts`, `holder.ts`, `embeddings/lease.ts`) are
deleted, and only the `worker_leases` table + its schema surface
remain as the tracked follow-up.

### Risks the QA re-execution must check

- The prod backlog (~200 unprocessed threads) drains at the
  per-tick cap per hour - a day-long burst of observer calls
  after deploy. Deliberate; log lines make it visible.
- Reactions depend on `bias_active_at_turn` snapshots written by
  the browser chat path - unchanged here, but the sweep is the
  first non-browser reader; a reactor pass that never fires
  post-port points at the snapshot, not the agent.
- Aggregate parity: the TS math moved runtimes; the QA pass
  should compare a recomputed `bias_summary` row against its
  pre-port value for the same inputs.

## C3 design (2026-06-11)

Baseline QA per the convention: backfill
`docs/qa/use-cases/samskara-formation.md` and execute against the
unchanged browser worker first. The baseline is expected to log
one FAIL: `samskara_tier2_candidate` errors on every call against
the local stack (`DELETE requires a WHERE clause`, SQLSTATE 21000)
because the local PostgREST connections preload pg-safeupdate and
the function clears its temp edge table with an unqualified
`delete from _tier2_edges`. The mint-tier2 phase has therefore
never run locally. The fix (`truncate`) ships with the C3 schema
changes; the service-role port would hit the identical error, so
this is a port prerequisite, not a drive-by.

### Drivers: dual (turn tail + hourly cron), with a phase split

The seven formation phases split by timing sensitivity, and the
split is the design:

- **Turn tail** (`samskaraOnTurnTail(admin, userId)`, sequential
  between curation and reflection in `getStreamingResponse`'s
  waitUntil tail - before reflection because reflection can span
  minutes and the samskara phases carry the only hard timing
  window in the fleet): reaction-classify FIRST, then an
  assimilate drain (capped), then one pair-relate probe, then one
  mint-tier1 probe.

  Reaction-classify is the reason the tail exists. A fired
  cohort's resolution window is 1-10 minutes after the fire, and
  the resolving evidence IS the next user message - so the tail
  of turn N+1 runs at exactly the moment turn N's cohort becomes
  classifiable. A cron at any sane cadence misses most of the
  window; the design already ages unresolved fires out via decay,
  and a user who walked away produced no next message to classify
  anyway. The 1-minute floor (avoid racing an in-flight turn)
  stays for parity even though the tail runs post-turn.

  Pair-relate and mint-tier1 ride the tail for mint
  responsiveness: the in-session toast is the product surface.
  Expected latency for a new claim: stub (browser, end of turn N)
  -> assimilate (tail of N+1) -> situation embedding (the */5
  embed backfill; `samskara-substrate` is already a registered
  server-side source) -> mint probe (tail of N+2). A few minutes
  and a couple of turns - comparable to the old worker's 60s
  throttle plus embed lag.

- **Hourly cron sweep** (`samskara-sweep` route via
  `sweepHandler`, `nak-samskara-sweep` at `23 * * * *` - free
  minute on the ladder): the catch-up driver and the only driver
  for the heavy, timing-insensitive phases. Per tick: drain the
  global assimilate queue (cross-user sweep claim, capped, cap
  hit logged), then for each user with recent samskara activity
  run pair-relate, mint-tier1, mint-tier2, dedup, and
  compound-regen probes. Mint-tier2 and dedup and compound-regen
  are cron-only on purpose: the tier-2 detection self-join is the
  heaviest query in the feature and compounds form over days, the
  dedup collapse is population maintenance, and the compound
  summary already tolerates 24h staleness in the priming block.
  The old 5-minute tier-2 throttle becomes "once per user per
  hourly tick" for free.

Sweep user discovery: a definer RPC returning users with
substrate or fire activity inside the lookback window (2h - one
tick plus slack for a missed tick). Compound-regen's per-user
`should_regen` predicate and dedup's population cap make the
probes self-limiting for users the window over-includes.

### Throttles: deleted

`PHASE_THROTTLE_MIN_INTERVAL_MS`, the tier-2 override, and the
lease-loss throttle reset all existed to stop a continuously
rotating browser worker from re-running exploratory probes every
~9 seconds. Server-side there is no continuous rotation - one
rotation per trigger (turn or tick) - so the trigger cadence IS
the throttle. Nothing replaces them.

### Mint toasts: postMessage becomes a realtime INSERT relay

The worker's `onMint` -> postMessage -> manager ->
`SAMSKARA_MINT_EVENT` chain dies with the worker. Replacement is
the established relay pattern (wiki_articles / memories /
recipes): add `samskaras` to the `supabase_realtime` publication,
subscribe to user-filtered postgres_changes INSERTs in
Chat.svelte, and map the new row's `(tier, valence, confidence)`
into `notifySamskaraMint`. INSERT-only - no replica-identity
index needed (that lesson applies to DELETE delivery).
Dedup-reinforce hits insert nothing and so toast nothing, which
matches the browser behaviour exactly. `SamskaraToasts.svelte`,
the mood pill, and `events.ts` are untouched consumers.

### Schema

- Fix `samskara_tier2_candidate`: `truncate _tier2_edges` instead
  of the unqualified `delete` (pg-safeupdate, above).
- b-strict `p_user_id uuid default null` overloads on the invoker
  RPCs the rotation calls: `samskara_claim_next_assimilate`,
  `samskara_save_assimilation_if_claimed`,
  `samskara_nearest_by_prediction`, `samskara_reinforce_existing`,
  `samskara_tier2_candidate`, `samskara_apply_reaction`,
  `samskara_collapse_by_cofiring`,
  `samskara_should_regen_compound`,
  `samskara_claim_compound_regen`,
  `samskara_save_compound_summary_if_claimed`.
  (`samskaraTopForSummary` was never an RPC - it is a direct
  RLS-scoped table read; the admin client filters explicitly.)
- A global SECURITY DEFINER assimilate sweep claim
  (`samskara_claim_next_assimilate_for_sweep`) returning
  `user_id`, service-role only - the C2 claim shape; the per-row
  claim columns on `samskara_substrate` carry forward as the
  mutual exclusion between tail and sweep.
- A definer sweep-users RPC for the per-user cron phases.
- The loop's raw `.from()` writes (associations upsert, both mint
  inserts, provenance upserts) move to the admin client and MUST
  set `user_id` explicitly - `samskaras`,
  `samskara_provenance`, and `samskara_associations` all default
  `user_id` to `auth.uid()`, which is NULL under the service role
  (the C2 landmine).
- `samskaras` joins the `supabase_realtime` publication.
- `nak_trigger_samskara_sweep()` + pg_cron `nak-samskara-sweep`
  at `23 * * * *`. Ladder after this: embed */5, bias :03, wiki
  :07, decay :13/:43, rem+attachments :17, samskara :23,
  reflection :27, librarian+recipe-gc :37, deep-sleep :47,
  curation :57.

### Server agent

`supabase/functions/venice/agents/samskara.ts` exporting
`samskaraOnTurnTail(adminClient, userId)` and
`runSamskaraSweepTick(adminClient)`. The six prompts port
verbatim from `src/lib/agents/samskara/prompts.ts`; model
hardcoded `mistral-small-3-2-24b-instruct` (the
`AGENT_MODELS.samskara` entry at port time). The loop's math
helpers (cosine, `buildTopicalCluster`) and tuning constants
(`MINT_DEDUP_COSINE`, `MINT_CLUSTER_*`) move into the module -
no browser reader survives the port, so no `_shared` mirror is
expected (verify with grep at port time; the chat-side constants
in `src/lib/samskara/types.ts` are a disjoint set and stay).
Edge logger source `samskara` (drops the `-worker` suffix, per
the fleet convention); the sweep's per-user work logs through
per-user loggers for drawer attribution.

### Deletions (the payoff)

`src/lib/agents/samskara/` entirely (agent, loop, manager,
prompts, worker), the `nak:samskara-worker` Web Lock and its
`worker_leases` partition use, the twelve worker-only
`SupabaseService` wrappers (`samskaraClaimNextAssimilate`,
`samskaraSaveAssimilation`, `samskaraRecentEmbeddedSubstrate`,
`samskaraNearestByPrediction`, `samskaraReinforceExisting`,
`samskaraTier2Candidate`, `samskaraApplyReaction`,
`samskaraCollapseByCofiring`, `samskaraShouldRegenCompound`,
`samskaraClaimCompoundRegen`, `samskaraTopForSummary`,
`samskaraSaveCompoundSummary`), the `AGENT_MODELS.samskara`
entry, the state-layer manager wiring, and
`tests/samskara-loop.test.ts` (ported logic gets Deno coverage).
The diagnostics tab's worker-lease panel
(`samskaraWorkerLeases`) loses its subject and comes out in the
same PR - a user-facing change, so `docs/user/` moves with it.
Samskara is the last lease tenant: the shared apparatus
(`base-manager.ts`, `holder.ts`, `embeddings/lease.ts`, the
`worker_leases` table) becomes deletable, tracked as its own
follow-up step after this port lands.

### Risks the QA re-execution must check

- Toast delivery now depends on realtime INSERT relay - a mint
  that writes the row but never toasts points at the publication
  or the subscription, not the agent.
- The waitUntil tail now chains curation + samskara + reflection
  sequentially; samskara adds up to ~4 quick completions before
  reflection starts. Hosted lifetime is already on the [hosted]
  ledger; the hourly sweep is the backstop for tail deaths.
- Stub-recording race: the browser records the substrate stub at
  end of turn N at roughly the same moment the tail runs, so the
  tail usually assimilates turn N-1's stub. One-turn lag,
  by construction; the sweep catches strays.
- Tier-2 runs for the first time locally post-fix - the baseline
  FAIL row and the post-fix row are the before/after evidence the
  tier-2 schema functions have been owed since they shipped.
