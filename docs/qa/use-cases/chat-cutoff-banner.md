# Chat: "cut off" retry banner - when it should and should not fire

## Covers

The incomplete-turn detection ([dev: chat](../../dev/chat.md); classifier in `src/lib/ui/incomplete-turn.ts`, banner wiring in `src/screens/Chat.svelte`):

1. **Genuine cut-off: bare user tail.** A non-draft user message at the tail with no assistant reply means the completion worker failed before writing anything. The banner should fire.
2. **Genuine cut-off: tool-row tail.** A tool round completed but the next assistant round never landed. The banner should fire. (Not staged here - requires engineering a mid-turn failure. Covered by unit tests in `tests/incomplete-turn.test.ts`.)
3. **Genuine cut-off: reasoning-only stall.** An assistant row with reasoning but no content and no tool calls. The banner should fire. (Not staged here - requires a model that emits non-standard tool-call syntax. Covered by unit tests.)
4. **Deliberate endpoint: aborted.** A user-initiated stop commits as `status='aborted'`. The banner should NOT fire.
5. **Deliberate endpoint: pending ask_user.** A tool row carrying the ask_user pending sentinel. The banner should NOT fire. (Not staged here - requires a model that calls ask_user. Covered by unit tests.)
6. **Expected state: draft tail.** A user message with `status='draft'` at the tail (fork-and-edit flow). The banner should NOT fire.
7. **Settled transcript.** A thread ending with a completed assistant reply. The banner should NOT fire.
8. **Empty completion re-roll.** A round whose stream ends with reasoning but no answer text and no tool call (observed on GLM 5.3 Flash: the model writes its answer inside the thinking channel and stops). The function must re-roll the round (up to `MAX_EMPTY_COMPLETION_REROLLS`, 2) before failing, and a failed turn must leave a reasoning-only `status='error'` row so case 3's stalled banner fires - never a bare user tail with nothing to retry against. (Cannot be staged on demand - the shape is a model glitch. Verify opportunistically when the "oops, all thinking!" notice appears in the wild. The predicate and temperature schedule are unit-covered in `supabase/functions/tests/stream-guards.test.ts`.)

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A thread with at least two completed turns. Note the thread id.
- For the draft-tail case: use the fork-and-edit flow (pencil button -> "Fork and edit") on any user message in the thread. This creates a fork with a draft row at the tail.
- For the aborted case: send a message and click Stop mid-stream.
- For the tool-row-tail case: this is hard to stage reliably without engineering a failure. The most reliable approach is to send a prompt that triggers a tool call (e.g. "Save a memory with label 'cutoff-test' and data 'test'"), then immediately close the browser tab before the follow-up assistant round lands. Reopen the thread.

## Steps

1. Settled transcript. Open the thread. Scroll to the bottom. Observe the area below the last message.

2. Draft tail. On the same thread, click the pencil button on a user message, then "Fork and edit." Observe the fork's transcript bottom. Do NOT send.

3. Aborted endpoint. Go back to the original thread. Send a new message. Click Stop while the response is streaming. Observe the bottom of the transcript after the aborted marker appears.

4. Bare user tail (genuine cut-off). This requires a failed completion. The simplest staging: temporarily set an invalid Venice API key in `app_config` (via psql), send a message, and observe. Restore the key afterward.

    ```sql
    -- Stage an invalid key (do NOT paste the real key here)
    update app_config set venice_api_key = 'invalid-key-for-testing';
    -- After the test:
    -- Restore the real key from .envrc (see AGENTS.local.md)
    ```

5. Draft tail after inherited prefix. On a fork created by fork-and-edit (step 2), navigate away and back. Observe the bottom.

6. Empty completion (opportunistic). When a turn on a reasoning model shows the "oops, all thinking!" notice card mid-stream, watch it through to the end. Then open the log drawer and filter the `stream` source.

## Expected

- (1) No banner. The transcript ends with a completed assistant reply. Nothing below it.
- (2) No banner. The fork ends with the inherited prefix (e.g. user -> assistant). The draft row is invisible (buildMessageBlocks filters it). The composer is pre-populated with the draft text. No "cut off" banner.
- (3) No banner. The aborted marker ("--- user interrupted response") is the last visible content. The status is 'aborted'. The classifier suppresses the banner for deliberate stops.
- (4) Banner appears. The user message is at the tail with no assistant reply (the completion failed). The banner reads "The response appears to have been cut off. Click to retry." A Retry button is present.
- (5) No banner. The draft is still at the tail, still `status='draft'`. The composer is re-populated from the draft. The classifier treats draft tails as expected.
- (6) Either a normal reply lands after the notice (the re-roll worked), or after the third empty attempt the live error card reads **"Unusable response"** with the "garbled output or no answer at all" advice and a Retry button - not the generic "Something went wrong inside Nak" card. If the last attempt carried reasoning, a reasoning-only error card also lands with the stalled banner. Never a bare user tail with nothing to retry against. The drawer shows one warn line per re-roll (`empty completion (finishReason=stop reasoningLen=N); re-rolling, attempt k/2`) and, on the failure path, an error line `empty completion after 3 attempts` plus `end terminalKind=error`. The hosted function logs (not the drawer) carry an `[streamFromVenice] empty stream: ... completion_tokens=... sample=[...]` line per empty attempt - capture it, it is the evidence for whether the model sent tokens the parser dropped. Before this behaviour the drawer showed `end terminalKind=completed persistedId=none` and the transcript tail stayed a bare user message across reloads.

## Cleanup

Restore the Venice API key if step 4 was used:

```sh
grep -oP 'VENICE[_A-Z]*KEY=\K\S+' .envrc | \
  xargs -I {} psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
  "UPDATE app_config SET venice_api_key = '{}';"
```

Delete any test forks from step 2.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-09-07 | cloud (pre-change) | 5075186 | fail (8) | from the hosted logs, not a walkthrough: thread 675efc75 hit three empty completions in a row (reasoning present, contentLen=0, finishReason=stop, no tool call); each ended `terminalKind=completed persistedId=none`, tail stayed a bare user message, banner read as a cut-off with nothing to retry against |
| 2026-09-07 | cloud | (this change) | not run (6/8) | cloud session has no browser and the shape cannot be forced; predicate + schedule unit-covered in stream-guards.test.ts, notice copy in slop-notice.test.ts. Verify opportunistically |
| 2026-09-07 | cloud | b451f3b | partial (6) | first live run of the re-roll on thread 675efc75: turn 1 re-rolled twice then answered (contentLen=1078); turn 2 ("Please go ahead") hit three empty attempts (two with ZERO reasoning, finish_reason=stop) and failed - but the live card showed the generic internal copy instead of the retry-exhausted card, and no forensics existed to say whether the model sent tokens the parser dropped. Both addressed in the follow-up change |
