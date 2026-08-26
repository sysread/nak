# Chat: "cut off" retry banner - when it should and should not fire

## Covers

The incomplete-turn detection ([dev: chat](../../dev/chat.md); classifier in `src/lib/ui/incomplete-turn.ts`, banner wiring in `src/screens/Chat.svelte`):

1. **Genuine cut-off: bare user tail.** A non-draft user message at the tail with no assistant reply means the completion worker failed before writing anything. The banner should fire.
2. **Genuine cut-off: tool-row tail.** A tool round completed but the next assistant round never landed. The banner should fire.
3. **Genuine cut-off: reasoning-only stall.** An assistant row with reasoning but no content and no tool calls. The banner should fire.
4. **Deliberate endpoint: aborted.** A user-initiated stop commits as `status='aborted'`. The banner should NOT fire.
5. **Deliberate endpoint: pending ask_user.** A tool row carrying the ask_user pending sentinel. The banner should NOT fire.
6. **Expected state: draft tail.** A user message with `status='draft'` at the tail (fork-and-edit flow). The banner should NOT fire.
7. **Settled transcript.** A thread ending with a completed assistant reply. The banner should NOT fire.

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

## Expected

- (1) No banner. The transcript ends with a completed assistant reply. Nothing below it.
- (2) No banner. The fork ends with the inherited prefix (e.g. user -> assistant). The draft row is invisible (buildMessageBlocks filters it). The composer is pre-populated with the draft text. No "cut off" banner.
- (3) No banner. The aborted marker ("--- user interrupted response") is the last visible content. The status is 'aborted'. The classifier suppresses the banner for deliberate stops.
- (4) Banner appears. The user message is at the tail with no assistant reply (the completion failed). The banner reads "The response appears to have been cut off. Click to retry." A Retry button is present.
- (5) No banner. The draft is still at the tail, still `status='draft'`. The composer is re-populated from the draft. The classifier treats draft tails as expected.

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
