# SoC fixes: collapse the dispatch-layer seams

## STATUS (2026-06-10)

**Active milestone.** First of the three
[tighten-the-control-surfaces](./tighten-the-control-surfaces.md)
milestones. Source material: the 2026-06-10 separation-of-concerns
audit of the agent fleet and tool-call layers (findings summarized
here; the audit itself was conversational).

## Items, in build order

A1 goes first because the other two milestones add or touch handlers
and should land on the collapsed shape.

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

## Audited and rated defensible - no action

Recorded so the next audit doesn't re-litigate them:

- Changelog and source-attribution writes inside tools: the
  narrative is tool-semantic ("Merged X into this memory");
  relocating the write separates nothing. The best-effort error
  swallowing deserves a second look when the code is next touched.
- The `complete` DI seam on `RunHeadlessAgentOptions`: deliberate
  injectable-completion test seam; deviates from the
  `__test`-namespace convention but is documented at the
  declaration.
- The browser `ToolContext.depth` field: vestigial mirror kept for
  shape tests.
- The structural `RoundCacheSnapshot` shared by intuition and
  context-recall: documented single-sourcing; fine until the two
  trigger policies need to diverge.
- `toolboxes_enabled` living in the chat-loop: the documented
  turn-boundary rendezvous design, not drift.
