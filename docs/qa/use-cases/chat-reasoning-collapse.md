# Chat: reasoning panel collapse + pills while streaming

## Covers

The live streaming reasoning panel's open/collapse behavior and its
header pills ([dev: chat](../../dev/chat.md), Gotchas - "The streaming
reasoning panel opens once, then yields"). Exercises
`reasoningShouldCollapse` / `reasoningElapsedPill` / `reasoningCharPill`
(`src/lib/ui/reasoning-panel.ts`), the `ExchangeSlot` reasoning fields
(`reasoningUserToggled` / `reasoningStartedAt` / `reasoningEndedAt`),
and the open/collapse + pill wiring in `Chat.svelte`. Also covers the
click-anywhere-to-collapse affordance on expanded panel bodies -
`clickShouldCollapse` (`src/lib/ui/collapse-click.ts`) - which is
shared between the reasoning block quote and the tool-call detail
panel (`ToolCalls.svelte`), so steps 8-10 exercise both.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A thread whose current model is reasoning-capable (the per-thread
  Reasoning picker is visible in the composer's slide-up column - it
  only shows on reasoning-capable tiers). Set reasoning effort to
  `medium` or `high` so traces are long enough to cross the collapse
  boundary.

## Steps

1. Send a prompt that forces a long chain-of-thought, e.g.
   "Think step by step in detail before answering: how many times does
   the digit 7 appear in the integers from 1 to 1000?"
2. Watch the reasoning panel from the first thinking token through to
   the answer.
3. Send a second, similar long-reasoning prompt. While the reasoning
   is still streaming AND the panel is open, click the "Reasoning"
   header once to collapse it. Keep watching as more thinking streams.
4. Send a third long-reasoning prompt. Let it auto-collapse on its
   own, then click the collapsed "Reasoning" header to expand it and
   keep watching through to the answer.
5. Send a prompt that elicits only a short thought (e.g. "Reply with
   just the word OK."), and watch the panel.
6. After any completed turn above, click the saved "Reasoning" header
   on the persisted bubble.
7. Note the pills on a completed turn's "Reasoning" header, send one
   more message in the thread, then switch to another thread and back.
   Finally, reload the page (or reopen the thread on another device).
8. Expand a persisted "Reasoning" panel and click once anywhere on
   the italic reasoning text itself (not the header). Re-expand it,
   then drag-select a few words of the reasoning and release the
   mouse over the panel.
9. During a live streaming turn with the panel open, click the
   reasoning text body to collapse it, and keep watching as more
   thinking streams.
10. Send a prompt that triggers a tool call (e.g. "What's the weather
    in Tokyo right now?" for `web_search`). Expand the tool-call card,
    then: (a) click the "view: json" toggle; (b) click a link in the
    rendered result if one is present; (c) drag-select part of the
    result; (d) click once on plain text inside the detail panel.

## Expected

- (1-2) Panel slides open on the first thinking token. As the trace
  grows it auto-collapses mid-thought (at a sentence break, once it is
  clearly long); the collapsed "Reasoning" header shows two pills - an
  elapsed-ms timer counting up and a character count rising. When the
  answer begins the timer freezes at its final value and the answer
  renders below. The panel never flickers back open on its own.
- (3) After your click the panel STAYS collapsed - it does not snap
  back open as further thinking deltas arrive (the pre-fix bug). The
  pills keep ticking while thinking continues.
- (4) After your expand-click the panel STAYS open for the rest of
  the turn - the first-answer-delta auto-close does NOT fire, because
  your manual choice latched automation off. (A fresh send resets
  this - automation governs the next turn again.)
- (5) A short thought stays open the whole time (never crosses the
  collapse boundary) and closes only at the answer hand-off.
- (6) The persisted header expands the saved block-quote reasoning,
  with the elapsed-ms + char-count pills still showing (they carry over
  from the live bubble).
- (7) The pills stay on the completed turn's header across a follow-up
  send and a thread switch-and-back (the thread stays loaded). After a
  full page reload - or reopening the thread on another device - the
  header renders WITHOUT pills: the timing is in-memory only, never
  saved, same elision as the tool-duration pills.
- (8) The body click collapses the panel (cursor shows a pointer over
  the body). The drag-select does NOT collapse it - the selection
  survives and the panel stays open.
- (9) The mid-stream body click collapses the panel AND latches
  manual control, exactly like a header click: the panel does not
  snap back open as further thinking deltas arrive.
- (10) (a) the view toggle flips to raw JSON without collapsing the
  panel; (b) the link opens without collapsing the panel; (c) the
  drag-select leaves the panel open with the selection intact;
  (d) the plain-text click collapses the detail back to the summary
  row.

## Cleanup

None - sends are normal turns; delete the test thread if desired.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-28 | - | claude/reasoning-collapse-streaming-rlmdev | not executed | authored alongside the feature; cloud session has no browser - needs a manual run against a local stack for the baseline |
| 2026-08-03 | - | claude/message-card-collapse-29ho59 | not executed | steps 8-10 (body-click collapse on reasoning + tool-call panels) authored alongside the feature; cloud session has no browser - needs a manual local-stack run |
