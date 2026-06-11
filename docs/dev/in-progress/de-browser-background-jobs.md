# De-browser the background jobs

## STATUS (2026-06-10)

**Planned, broad-strokes on purpose; starts after the SoC and
edge-log-coverage milestones** (the ports want the collapsed route
layer and day-one loggers). Third of the three
[tighten-the-control-surfaces](./tighten-the-control-surfaces.md)
milestones. Design pass happens when this becomes the active
milestone, per the planning rhythm.

**The rule:** a job that is not UI-scoped or ongoing-chat-scoped
must not depend on a browser tab being open.

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
- **C2. Port bias.** Qualifies under the rule (not UI-scoped).
  Fleet pattern applies: lease becomes cron, per-thread claim RPCs
  stay as the mutual exclusion. Two design questions from the
  re-inspection: the active-conversation exclusion set becomes
  recency-based ("updated in the last N minutes") instead of
  postMessage'd tab state, and the in-memory aggregate
  dirty/throttle state needs a persistent home (or the cron cadence
  becomes the throttle, as it did for the fleets).
- **C3. Samskara formation loop: deferred, user-confirmed
  (2026-06-10).** The one standing exception to the rule. Deferred
  until a concurrent session's samskara changes land - it is
  building a new tab for observing samskaras (read-only, for
  debugging and observability). On top of that: the tier-2 compound
  machinery is weeks old (its two schema functions still owe the
  post-deploy manual SQL exercise), the port is its own milestone
  (8 phases, in-memory throttles, mint toast propagation), and the
  chat-scoped half (fire, substrate stub, compound-summary read)
  stays browser-side regardless. Standing rule applies when this
  reopens: the samskara area needs a fresh full read before any
  plan touches it.

  **Decay lifted early (2026-06-11).** Upstream 13ef213 flagged
  the decay phase as the cleanest pre-port lift (pure SQL, no LLM,
  no in-worker consumer, predicates row-local), so it moved ahead
  of the rest of C3: `samskara_decay()` (per-user invoker) became
  `samskara_decay_sweep()` (cross-user definer) driven by the
  `nak-samskara-decay` pg_cron job at `13,43 * * * *`, and the
  browser worker's decay phase + throttle were deleted. QA:
  `docs/qa/use-cases/samskara-decay.md`. Dedup
  (`samskara_collapse_by_cofiring`) is NOT row-local (per-user
  pair enumeration + population cap) and stays in the rotation
  until the full C3 port.

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
chat-scoped. The shared lease apparatus (`base-manager.ts`,
`holder.ts`, `embeddings/lease.ts`, the `worker_leases` table)
still waits for the samskara port - it has one tenant left after
this.

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
