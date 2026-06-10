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
