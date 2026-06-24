# Intent injection: the toggle, the system-prompt block, the snapshot

## Covers

The chat-turn side of intents ([dev: intents](../../dev/in-progress/intents.md),
[dev: prompt-augmentation](../../dev/prompt-augmentation.md)):
`applyIntentPriming` in the venice priming stage - the
`intentsEnabled` toggle gate, the "Working intentions" block
rendered into the row-0 system message AFTER the bias appendix
under the shared `COMBINED_APPENDIX_CEILING`, and the
`threads.intent_active_at_turn` snapshot. Also the Settings AI-pane
toggle that writes `profiles.settings.intentsEnabled`.

This case proves the behavior-activating wire: with the toggle on
and an active intent, the block lands in the prompt; with it off,
nothing does. The full assembled wire is dumped under the `stream`
drawer source ([dev: logging](../../dev/logging.md)).

## Preconditions

- Local stack up, signed in as the dev user, Logs drawer open at
  `Trace+`. `$UID` = `select user_id from profiles limit 1;`.
- At least one active intent to render. Forge one directly (no need
  to run the minter):

  ```sql
  insert into intents (user_id, statement, status, target_kind)
  values ('$UID', 'help them name a contrary view before committing', 'active', 'none');
  ```

## Steps

1. **Toggle OFF.** Ensure off, then send a chat message in any
   thread:

   ```sql
   update profiles set settings = settings - 'intentsEnabled' where user_id = '$UID';
   ```

   Send "hello" in a thread. In the Logs drawer `stream` source,
   open the assembled request wire and read the row-0 system
   message.

2. **Toggle ON via the UI.** Open Settings -> AI -> "Working
   intentions" and check the box. Confirm it persisted:

   ```sql
   select settings->>'intentsEnabled' from profiles where user_id = '$UID';
   ```

3. Send another chat message. Re-read the row-0 system message in
   the `stream` wire dump, and check the per-thread snapshot:

   ```sql
   select intent_active_at_turn from threads where id = '<the-thread-id>';
   ```

4. **Combined cap with bias.** With several active intents (insert
   a few) AND a user whose `bias_summary` already renders biases,
   send a message and count the bullets in each block in the wire.

## Expected

- (1) Toggle OFF: the row-0 system message has NO "# Working
  intentions" section. The pipeline read is skipped entirely - no
  intents query, no snapshot write.
- (2) The checkbox persists `intentsEnabled = true`; the inline
  confirmation copy appears; a refresh keeps it checked (it reloads
  from `profiles.settings`).
- (3) Toggle ON: the row-0 system message now contains a
  "# Working intentions" section, positioned AFTER the bias
  "observed cognitive patterns" block (so the precedence note's
  "guidance above" resolves), with the forged statement as a
  bullet. The framing reads as dispositional leans + the explicit
  user-instructions-first precedence, NOT turn commands.
  `threads.intent_active_at_turn` holds the rendered intent's id.
- (4) Bias bullets + intent bullets together do not exceed the
  shared ceiling (`COMBINED_APPENDIX_CEILING`, 6): intents are
  capped at `min(INTENT_RENDER_CAP, ceiling - biasRendered)`, so a
  user already showing 4 biases sees at most 2 intentions, and
  intents yield to bias when both are full.
- The turn is never blocked or delayed by intents: a read failure
  or cold start degrades to "no block this turn", same swallow
  contract as bias.

## Cleanup

```sql
delete from intents where user_id = '$UID';
update profiles set settings = settings - 'intentsEnabled' where user_id = '$UID';
-- intent_active_at_turn resets to '{}' on the next turn after the
-- intents are gone; clear eagerly if a later case depends on it:
update threads set intent_active_at_turn = '{}' where user_id = '$UID';
```

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-24 | — | (this commit) | not run | Authored alongside the feature; first execution pending a live stack (cloud authoring env has none). The sequencing (intent block after bias on row 0) is also pinned by a Deno orchestration test; this case proves the end-to-end wire + the toggle gate + the snapshot, which unit tests cannot reach. |
