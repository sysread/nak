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

- **C1. Retire the browser supervisor.** Full scoping in
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
- Per-row claim TTLs keep their browser-era values (60s title /
  120s summary, topics / 60s memory, recipe tags) - the work shape
  per row is unchanged.

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
