# Edge log coverage: every function reaches the drawer

## STATUS (2026-06-10, end of day)

**Fully landed.** The streaming orchestrator ('stream' source), the
four mid-turn agents, and the two GC functions all reach the drawer;
verified live for the orchestrator (a dev chat turn rendered its
operational lines). Second of the three
[tighten-the-control-surfaces](./tighten-the-control-surfaces.md)
milestones.

## Current coverage

Drawer logging (`createEdgeLogger` -> `logs:<userId>` Broadcast)
exists in exactly the five fleet agents: `reflection`, `wiki` (plus
`wiki-manual`), `wiki-librarian`, `rem`, `deep-sleep`. Everything
else in the functions tree logs to console only - visible in hosted
function logs, invisible to the in-app Logs drawer.

## Items

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
- **B4. Embed backfill sweep** - [DONE 2026-06-10, second pass -
  the user overrode the initial defer for drawer consistency.] All
  five claim RPCs return user_id; the backfill tallies successful
  saves per owner and emits one 'embedded N item(s)' summary per
  affected user under the `embeddings` source. Empty ticks emit
  nothing.
- **B5. The two non-venice functions** (`expire-attachments`,
  `recipe-image-gc`) - currently fully silent, and they are
  deletion jobs, exactly the kind of thing you want visibility on.
  Rows carry user_id, so per-user drawer lines are possible.
- **B6. Handler-level errors** - logged once in the SoC milestone's
  shared handler wrapper instead of per-handler.

## Notes

- `docs/dev/logging.md` keeps the source inventory; every item here
  updates it in the same PR.
- The drawer's source filter UI derives from observed sources, so
  new sources need no frontend work beyond the docs.
