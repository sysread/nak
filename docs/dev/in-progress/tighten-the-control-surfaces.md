# Tighten the control surfaces

## STATUS (2026-06-10)

**Umbrella for three independent milestones**, successor to
[reorganize-the-workshop](./reorganize-the-workshop.md). That project
moved all tool execution and the agent fleets server-side; these
milestones clean up the seams the move left behind. Each has its own
plan doc and ships independently:

1. [SoC fixes](./soc-fixes.md) - the findings from the 2026-06-10
   separation-of-concerns audit of the fleet and dispatch layers.
   **Active.**
2. [Edge log coverage](./edge-log-coverage.md) - extend
   edge-to-drawer logging to the streaming chat path and the
   remaining silent functions.
3. [De-browser the background jobs](./de-browser-background-jobs.md)
   - no job that isn't UI- or ongoing-chat-scoped should depend on a
   browser tab.

Cross-milestone sequencing: the SoC route-layer collapse lands
first (the other milestones add or touch handlers and should land on
the collapsed shape); log coverage second (the de-browsering ports
want loggers from day one); de-browsering last, design pass at build
time per the planning rhythm.

## A premise correction, recorded

The directive that produced milestone 3 included "we trigger
reflection from the chat on each round, but we could do that with an
async call from the streaming chat edge function." **Reflection
already works that way** - it moved server-side in phase 2 of the
workshop project and fires from `getStreamingResponse`'s tail inside
the venice function, per completed turn, under `waitUntil`. No
browser involvement. The tail (turn end) rather than message receipt
(turn start) is deliberate: reflection must not compete with the
live stream for the same user's resources mid-turn; the user has
confirmed turn-end is fine. What actually remains browser-triggered:
the supervisor's five units, bias, and samskara's formation loop -
milestone 3's scope.
