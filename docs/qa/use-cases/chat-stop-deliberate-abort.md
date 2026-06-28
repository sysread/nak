# Chat: a deliberate Stop is a first-class endpoint, not a cut-off

## Covers

The Stop button as an explicit user signal ([dev: chat](../../dev/chat.md),
entry point "Stop button" and gotcha "A cut-off reply's partial is
preserved as a card, not dropped"):

1. **Always persists an `'aborted'` row.** A user-initiated stop commits
   the assistant turn as `status='aborted'` with the `INTERRUPTED_MARKER`
   appended. A stop that lands before any text OR reasoning streamed
   still persists a marker-only `'aborted'` row
   (`getStreamingResponse.ts` terminal write,
   `withInterruptedMarker('')`), rather than leaving the thread tail on
   the bare user message.
2. **Never offered for retry.** The transcript-tail classifiers
   (`incompleteTurnTail` in `Chat.svelte`, `isReasoningOnlyStall` /
   `isCutOffPartialText` in `src/lib/ui/incomplete-turn.ts`) all treat a
   `status='aborted'` tail as a deliberate endpoint - no cut-off banner,
   no recovery banner, no replace-on-retry. Contrast with the `'error'`
   tail in [chat-cutoff-retry](./chat-cutoff-retry.md), which IS offered.
3. **Cross-device agreement.** Because the verdict keys off the persisted
   `status='aborted'`, a second device that opens the same thread reaches
   the same "deliberate stop, leave it alone" conclusion the stopping
   device did - no spurious retry prompt on the observer side.
4. **The user can continue.** Typing a new message and sending against an
   aborted tail produces a valid next turn (the marker keeps the wire
   shape valid).

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A model slow enough to give you time to click Stop mid-reply (a
  reasoning-heavy tier helps). Note the thread id.
- A second browser (or a private window with a distinct
  `localStorage` holder id) signed in as the same user, for the
  cross-device step.
- Both control-channel realtime policies present on the project
  (`"control channel: owner publish"` AND `"control channel: owner
  subscribe"` on `realtime.messages`). The browser must JOIN the control
  channel before it can publish the cancel, and the join is a SELECT
  check - missing the subscribe policy makes Stop a silent no-op
  server-side (the function streams to completion). Verify with:
  `select policyname, cmd from pg_policies where schemaname='realtime'
  and tablename='messages' and policyname like 'control channel%';`

## Steps

1. Stop after text has streamed. Send a prompt, wait until visible answer
   text is rendering, then click the Stop button (the filled square).
2. Inspect the tail card and the row:

   ```sql
   select role, status, left(content, 40) as content_head,
          reasoning is not null as has_reasoning
     from messages
    where thread_id = '<thread>'
    order by created_at desc
    limit 1;
   ```

3. Stop before anything streams. Send another prompt and click Stop as
   fast as possible - ideally before any reasoning or text appears.
   Re-run the query from step 2.
4. Reload the thread (hard refresh). Confirm what renders at the tail.
5. Cross-device. On the second browser, open the same thread. Observe the
   tail.
6. Continue. Back on the first browser, type a new message and send.
   Confirm the turn runs normally.

## Expected

- (1) The reply stops streaming promptly. The function log shows
  `end terminalKind=aborted`. (If it shows `completed`, the control-
  channel cancel never reached the server - a real bug, not a pass.)
- (2) The tail row is `status='aborted'`; its content ends with
  `--- user interrupted response`. The card renders as a normal
  assistant bubble. **No** "response appears to have been cut off"
  banner and **no** Retry affordance beneath it.
- (3) Even with nothing streamed, a row exists: `role='assistant'`,
  `status='aborted'`, content is exactly `--- user interrupted response`.
  The thread tail is this row, NOT the bare user message.
- (4) After reload the marker row is still the tail and still carries no
  retry banner (the verdict survives a page load because it keys off the
  persisted status).
- (5) The second device shows the same aborted tail with no retry/cut-off
  banner - it does not offer to regenerate a turn the first device
  deliberately stopped.
- (6) The new message sends and a fresh reply streams in beneath the
  aborted row; no provider 400 on the wire shape.

## Cleanup

Delete any forged/aborted rows the follow-up turn did not bury:

```sql
delete from messages
 where thread_id = '<thread>'
   and status = 'aborted'
   and content like '%user interrupted response%';
```

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
