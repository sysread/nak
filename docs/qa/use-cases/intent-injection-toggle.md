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

- Local stack up, signed in as the dev user. `$UID` is the
  signed-in user - take it from the auth session, not from a bare
  `select user_id from profiles limit 1` (nondeterministic when a
  restored local volume carries more than one profile). The thread
  you send in must be owned by `$UID`.
- At least one active intent to render. Forge one directly (no need
  to run the minter):

  ```sql
  insert into intents (user_id, statement, status, target_kind)
  values ('$UID', 'help them name a contrary view before committing', 'active', 'none');
  ```

## What is observable, and what is not

The "# Working intentions" block is spliced into the row-0 system
message INSIDE the edge function (`applyIntentPriming`), AFTER the
browser has already POSTed and logged its own pre-priming view of
the wire (`chat-loop.ts` "venice request wire", source `chat`). The
server-side `stream` logger carries only operational lines
(round/historyLen/terminal kind), never the assembled prompt
content. So there is NO drawer-surfaced dump of the row-0 system
message with the block in it - do not try to read the block in the
`stream` wire; it is not there.

The faithful, deterministic signal is the per-thread snapshot
`threads.intent_active_at_turn`. It is computed from the exact same
`pickRenderableIntents(rows, cap)` call that builds the block -
`renderedIds = rows.slice(0, picked.length)` - so the ids in the
snapshot ARE the intents that rendered into the prompt. Gate,
rendered-set, and cap are all read off this column. The block's
byte-level placement (intent block AFTER the bias block on row 0)
is pinned by the sequencing assertion in
`supabase/functions/tests/priming-orchestration.test.ts`, which is
the right layer for an ordering check.

## Steps

1. **Toggle OFF (the gate).** Ensure off, reset the snapshot, then
   send a chat message in the thread:

   ```sql
   update profiles set settings = settings - 'intentsEnabled' where user_id = '$UID';
   update threads set intent_active_at_turn = '{}' where id = '<thread-id>';
   ```

   Send "hello", then read the snapshot:

   ```sql
   select intent_active_at_turn from threads where id = '<thread-id>';
   ```

2. **Toggle ON via the UI.** Open Settings -> AI -> "Working
   intentions" and check the box. Confirm it persisted:

   ```sql
   select settings->>'intentsEnabled' from profiles where user_id = '$UID';
   ```

3. Send another chat message, then re-read the snapshot and compare
   to the active intents:

   ```sql
   select intent_active_at_turn from threads where id = '<thread-id>';
   select id, statement from intents where user_id = '$UID' and status = 'active';
   ```

4. **Combined cap with bias.** Insert several active intents (4+)
   for a user whose `bias_summary` already renders biases, send a
   message, and count the ids in `intent_active_at_turn`.

## Expected

- (1) Toggle OFF: `intent_active_at_turn` stays `{}` - the pipeline
  returns at the gate, so no intents query and no snapshot write.
- (2) The checkbox persists `intentsEnabled = true`; the inline
  confirmation copy appears; a refresh keeps it checked (it reloads
  from `profiles.settings`).
- (3) Toggle ON: `intent_active_at_turn` holds exactly the rendered
  intent ids - a subset of the active intents, in render order. A
  non-empty snapshot is the proof the block rendered into the row-0
  prompt (framing + after-bias placement covered by the
  orchestration test above).
- (4) The snapshot length never exceeds the shared ceiling:
  `len(intent_active_at_turn) == min(activeIntents, INTENT_RENDER_CAP
  (3), COMBINED_APPENDIX_CEILING (6) - biasRendered)`. A user already
  showing 4 biases caps intents at 2; intents yield to bias when the
  ceiling is full (snapshot can be empty even with active intents).
- The turn is never blocked or delayed by intents: a read failure
  or cold start degrades to "no block this turn" and the snapshot
  write is detached + swallowed, same contract as bias.

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
| 2026-06-24 | local (dev-start) | f05168c | pass | First execution, driven by calling the real `applyIntentPriming` against the local Postgres (the orchestrator/Venice/Realtime path is unnecessary - priming is what mutates row-0 + writes the snapshot). Gate held: toggle off -> no block injected, `intent_active_at_turn` stayed `{}`. Toggle on -> block injected into row-0 with the dispositional-leans framing + user-instructions-first precedence note + both statements as bullets; snapshot held exactly the 2 active intent ids (cross-checked). With a bias block pre-seeded on row-0, the intent block landed AFTER it (precedence "guidance above" resolves). Cap arithmetic is pure + unit-covered (`intent-format.test.ts`). Rewrote the verification this run: dropped the non-executable "read the block in the `stream` wire" step (the block is spliced server-side after the browser logs its pre-priming wire, and the `stream` logger carries only operational lines - confirmed against `chat-loop.ts` + `getStreamingResponse.ts`); the faithful signal is the `intent_active_at_turn` snapshot. Root inaccuracy lives in `prompt-augmentation.md`'s Observability claim (tracked separately). |
