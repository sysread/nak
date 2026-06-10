# Tighten the control surfaces

## STATUS (2026-06-10)

**Planned; not started.** Successor milestone to
[reorganize-the-workshop](./reorganize-the-workshop.md). That project
moved all tool execution and the agent fleets server-side; this one
cleans up the seams the move left behind. Three workstreams:

- **A. Separation-of-concerns fixes** - the findings from the
  2026-06-10 SoC audit of the fleet and dispatch layers.
- **B. Log-drawer coverage** - extend edge-to-drawer logging to the
  streaming chat path and the remaining silent functions.
- **C. Finish de-browsering the background jobs** - no job that
  isn't UI- or ongoing-chat-scoped should depend on a browser tab.

Per the project planning rhythm: workstream A and B get their design
here (they're first); C stays broad-strokes and gets its design pass
when it becomes active, folding in what A and B teach.

## A premise correction, recorded

The directive that produced workstream C included "we trigger
reflection from the chat on each round, but we could do that with an
async call from the streaming chat edge function." **Reflection
already works that way** - it moved server-side in phase 2 of the
workshop project and fires from `getStreamingResponse`'s tail inside
the venice function, per completed turn, under `waitUntil`. No
browser involvement. The tail (turn end) rather than message receipt
(turn start) is deliberate: reflection must not compete with the
live stream for the same user's resources mid-turn. What actually
remains browser-triggered: the supervisor's five units, bias, and
samskara's formation loop - workstream C.

## Workstream A: separation-of-concerns fixes

Findings from the audit, in build order. A1 goes first because B and
C both add or touch handlers and should land on the collapsed shape.

- **A1. Collapse the route layer** (`venice/index.ts`). The four
  sweep handlers and three manual-run handlers are one shape with
  data varying: service-role gate, the ~8-line `adminClient` +
  `readVeniceKey` preamble (repeated 9+ times across all handlers),
  runId validation, publisher setup/flush, result mapping. Extract a
  sweep-handler factory, a manual-run-handler factory, and a
  `withVeniceKey`-style preamble helper. The variation that remains
  per fleet should be a table entry, not a function body.
- **A2. Give reflection a visible trigger.** Reflection is the only
  fleet not discoverable from the routing table - it hides in
  `getStreamingResponse`'s finally tail. Add a `/reflection-sweep`
  cron route as a catch-up drain (the per-thread claim RPC already
  makes double-driving safe; this was noted when the tail landed).
  The tail stays as the fast path. Side effect: closes the known
  no-chat-no-draining gap.
- **A3. Stop mutating tool wire schemas on listener attach**
  (`agents/_run.ts`). Attaching `onProgress` silently injects a
  required `activity` param into every tool schema - the model sees
  different tools depending on whether a UI is watching. Replace the
  hidden mutation with an explicit `withProgressNarration(toolbox)`
  wrapper applied at the manual-run call sites. The token-saving
  rationale (no narration generated on cron runs) survives; the
  schema change becomes visible where it happens.
- **A4. Kill the `threadId: ''` sentinel** on `AgentToolContext`.
  Librarian agents blank `threadId` and tools like `wiki_update`
  must know empty-means-no-current-thread. Make it
  `threadId: string | null` (or a named discriminant) so the two
  caller modes are explicit at the type level.
- **A5. Split `handleStream`'s `reconnectOnly` mode** into two
  handlers behind the route (rides A1). Fresh-stream and reconnect
  share the JWT/ownership preamble and then diverge completely -
  the textbook parameter-mode function.
- **A6. Move subconscious fire-policy into the pipelines.** The
  chat-loop builds the trigger context, evaluates the intuition and
  context-recall triggers, holds the model-id gate, and decides
  whether each fires (`chat-loop.ts` ~1161-1279). Push the
  fire-decision into the pipeline entry points; the chat-loop
  supplies inputs and owns sequencing only.
- **A7. Delete the dead `evaluateTitleTrigger`** (zero callers,
  grep-verified) and fix `docs/dev/intuition.md`, which still
  describes the disconnected mid-turn title-trigger / ephemeral-
  splice behavior as live.
- **A8. Move ask_user arg-shape parsing** out of the chat-loop into
  `ask-user.ts` (which already owns the persisted-content parsing).
  Suspension stays a chat-loop lifecycle concern; the tool's shape
  knowledge does not.

Audited and rated defensible, no action: changelog and
source-attribution writes inside tools (the narrative is
tool-semantic; relocating the write separates nothing - though the
best-effort error swallowing deserves a second look when touched);
the `complete` DI seam on `RunHeadlessAgentOptions`; the browser
`ToolContext.depth` vestige; the structural `RoundCacheSnapshot`
shared by intuition/context-recall; `toolboxes_enabled` living in
the chat-loop (documented rendezvous design).

## Workstream B: log-drawer coverage

Current coverage: the five fleet agents only (`reflection`, `wiki`,
`wiki-manual`, `wiki-librarian`, `rem`, `deep-sleep`). Everything
else in the functions tree logs to console only - visible in hosted
function logs, invisible to the in-app drawer.

- **B1. Streaming chat orchestrator** (`getStreamingResponse.ts`,
  14 console-only calls). The browser already renders the *content*
  events; what never reaches the front end is the *operational*
  layer: round transitions, tool dispatch results and failures,
  retry signals (rate-limit waits, truncation re-rolls, guard
  retries), terminal kind, and the reflection-tail outcome. Add a
  `chat` source edge logger threaded through the orchestrator. The
  drawer's existing level gating handles volume - chatty lines go
  at trace/debug.
- **B2. Completion retry loop** (`getStreamingCompletion.ts`). Takes
  an optional logger from B1's orchestrator rather than
  constructing one (it's Venice-facing and has no userId of its
  own).
- **B3. The mid-turn recall agents** (`recall.ts`,
  `conversation_recall.ts`, `wiki_recall.ts`, `context.ts`) -
  console-only today. Sources named after each agent.
- **B4. Embed backfill sweep** - per-row user attribution exists;
  `embeddings` source.
- **B5. The two non-venice functions** (`expire-attachments`,
  `recipe-image-gc`) - currently fully silent, and they are
  deletion jobs, exactly the kind of thing you want visibility on.
  Rows carry user_id, so per-user drawer lines are possible.
- **B6. Handler-level errors** - logged once in A1's shared handler
  wrapper instead of per-handler.

## Workstream C: finish de-browsering the background jobs

Broad-strokes; design pass when active. The rule: a job that is not
UI-scoped or ongoing-chat-scoped must not depend on a browser tab.

- **C1. Retire the browser supervisor.** Already scoped in
  [planned-changes.md](../planned-changes.md) ("Retire the browser
  supervisor"): port auto_title / summary / topics on the
  reflection-style turn tail (tail placement is load-bearing for
  title latency), memory_topics / recipe_topics as cron sweeps
  (these are the server-writes/browser-drains gap), and delete the
  supervisor worker plus its whole lease apparatus. All five
  together or not at all - a partial port keeps the apparatus alive.
- **C2. Port bias.** Under this milestone's rule it qualifies (not
  UI-scoped). Fleet pattern applies: lease becomes cron, per-thread
  claim RPCs stay as the mutual exclusion. Two design questions
  from the re-inspection: the active-conversation exclusion set
  becomes recency-based ("updated in the last N minutes") instead
  of postMessage'd tab state, and the in-memory aggregate
  dirty/throttle state needs a persistent home (or the cron cadence
  becomes the throttle, as the fleets did).
- **C3. Samskara formation loop: deliberately deferred.** It is the
  one remaining violation of the rule, left standing on purpose:
  the tier-2 compound machinery is weeks old (its two schema
  functions still owe the post-deploy manual SQL exercise), the
  port is its own milestone (8 phases, in-memory throttles, mint
  toast propagation), and the chat-scoped half (fire, substrate
  stub, compound-summary read) stays browser-side regardless.
  Revisit after tier-2 bakes. **This defer wants explicit
  sign-off.**

Stays browser-side by definition: intuition and context-recall
(ongoing-chat-scoped), the composer/catalog, the manual-run strips
(UI).

## Sequencing

1. **A1** (route collapse) - everything later lands on it.
2. **B** (logging) - the C ports want loggers from day one, and B6
   rides A1.
3. **A2-A8** - independent of each other; opportunistic order.
4. **C1**, then **C2** - each gets its design pass at build time.
5. **C3** stays deferred unless overridden.

## Open questions

- Is the C3 samskara defer acceptable, given the milestone's stated
  rule? (Recommendation: yes - cost/value and tier-2 bake time both
  argue for it.)
