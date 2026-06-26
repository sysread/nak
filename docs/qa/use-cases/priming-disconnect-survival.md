# Priming: survives a mid-turn browser disconnect

## Covers

Turn-entry priming runs server-side, as the opening stage of
`getStreamingResponse` (`supabase/functions/venice/priming.ts`
`runServerPriming`), under the same `EdgeRuntime.waitUntil` that keeps
the streaming half alive across a disconnect. This case proves the
durability claim end to end: a turn whose tab closes WHILE priming is
still running (the slowest part - intuition is ~6 LLM calls) comes back
to a fully-primed, finished answer, not an unprimed or dropped one. It
also exercises feedback parity - the spinner, the Intuition / Recall
modals + pills, and the per-source log-drawer entries are now driven by
the `PrimingEvent`s the function publishes, not by local callbacks
([dev: prompt-augmentation](../../dev/prompt-augmentation.md),
[dev: intuition](../../dev/intuition.md),
[dev: context-recall](../../dev/context-recall.md),
[dev: samskara](../../dev/samskara.md),
[dev: bias-profile](../../dev/bias-profile.md)).

Scope note: this is about the relocation + durability + feedback parity.
The per-pipeline retrieval correctness lives in each feature's own case
(e.g. [context-recall-priming](./context-recall-priming.md),
[bias-pipeline](./bias-pipeline.md)).

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user
  (`dev@nak.local` / `devpass123`).
- A **warm** thread: one that already has at least a few turns of
  history, an intuition model configured, context recall enabled, and -
  ideally - a non-empty `bias_summary` and at least one samskara so all
  four priming surfaces have something to render. A cold thread ships no
  priming chain at all (by design) and would not exercise the splice.
- Logs drawer open, level filter `debug`. Priming logs under sources
  `intuition`, `context-recall`, `samskara`, and `bias`; the round/wire
  dump under `stream`. These are edge sources reaching the drawer over
  the edge-log Broadcast relay.
- A way to throttle so priming is observably in-flight when you cut the
  tab: either a slow model tier for intuition, or DevTools network
  throttling, so the window between "send" and "first token" is wide
  enough to close the tab inside it.

## Steps

1. Open the warm thread. Confirm the bias pill (chart) and, once warm,
   the Intuition (brain) and Recall (bulb) pills are present.
2. Send a message whose content should trip a context-recall / samskara
   fire (reference a topic the thread's memories/samskaras cover).
3. **While the subconscious spinner is still showing** (priming
   in-flight, before the assistant's first token), close the tab (or
   hard-background the PWA / kill the browser process).
4. Wait past the expected completion time, then reopen the app and the
   same thread.

## Expected

- **(1)** The pills render; the bias pill is always present, the
  Intuition/Recall pills present on a warm thread.
- **(2)** As priming runs, the subconscious spinner cycles its ops
  (recall / samskara / intuition) and the log drawer accrues entries
  under the `intuition`, `context-recall`, `samskara`, and `bias`
  sources - sourced from the EDGE function now, not the browser. The
  Intuition and Recall modals populate with the fresh payload when each
  pipeline refreshes.
- **(3-4)** On reopen, the turn is **complete and primed**: the
  assistant response is present, and the thread row carries the fresh
  `intuition_payload` / `context_recall_payload` (verify with the
  `nak-inspect-thread` skill or `mise run dev-sql`). The bias appendix
  having shipped is visible in the round wire dump under `stream`
  (`# User profile - observed cognitive patterns`, when any bias cleared
  soft). The turn did NOT ship unprimed and did NOT drop. This is the
  core regression: before the relocation, closing the tab during priming
  could ship an unprimed turn or no turn.
- **Parity**: nothing about the spinner / modal / pill / log surfaces
  should look different from before the relocation - only their trigger
  moved from local callbacks to the stream channel.

## Cleanup

- None required beyond the test message. To re-run from a clean priming
  state, clear the thread's cached payloads:
  `update threads set intuition_payload = null, context_recall_payload = null where id = '<thread>';`

## Results log

Append-only. Every row carries date, environment, and commit. Do not
overwrite prior rows.

| Date | Environment | Commit | Result | Notes |
| --- | --- | --- | --- | --- |
| pending | local | branch claude/dreamy-wozniak-cuvf1d | not yet executed | Authored with the relocation; needs a manual run against a running stack (cloud agent has no browser). |
