# Chat: reasoning panel collapse + pills while streaming

## Covers

The live streaming reasoning panel's open/collapse behavior and its
header pills ([dev: chat](../../dev/chat.md), Gotchas - "The streaming
reasoning panel opens once, then yields"). Exercises
`reasoningShouldCollapse` / `reasoningElapsedPill` / `reasoningCharPill`
(`src/lib/ui/reasoning-panel.ts`), the `ExchangeSlot` reasoning fields
(`reasoningUserToggled` / `reasoningStartedAt` / `reasoningEndedAt`),
and the open/collapse + pill wiring in `Chat.svelte`.

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

## Cleanup

None - sends are normal turns; delete the test thread if desired.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-28 | - | claude/reasoning-collapse-streaming-rlmdev | not executed | authored alongside the feature; cloud session has no browser - needs a manual run against a local stack for the baseline |
