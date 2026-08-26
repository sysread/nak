# Chat: fork and edit a user message (non-destructive, with draft)

## Covers

The fork-and-edit flow ([dev: user-message-editing](../../dev/in-progress/user-message-editing.md); fork primitive in `src/lib/supabase/threads.ts`, draft message in `src/lib/ui/draft-message.ts`, handler + send branch in `src/screens/Chat.svelte`, draft filter in `src/lib/ui/message-blocks.ts`):

1. **Fork and edit click.** Clicking "Fork and edit" from the edit dropdown forks from the message before the user message, inserts a draft row on the fork, opens the fork, and loads the draft text into the composer.
2. **Draft invisibility.** The draft row (status='draft') is invisible in the transcript - buildMessageBlocks filters it. The composer is the only surface that shows the draft text.
3. **Non-destructive.** The original thread is untouched. All its messages survive. The fork appears in the drawer under "Recent" with the forked-conversation glyph.
4. **Edit and send.** The user edits the text in the composer and sends. The draft is promoted (content updated, status cleared) and the completion runs normally on the fork.
5. **Reconnection.** Navigating away from the fork and back re-populates the composer from the draft row. The draft text persists across navigation.
6. **Abandoned fork.** If the user navigates away without sending, the fork stays in the drawer with the draft row. The user can return later and send, or delete the fork.
7. **First message edge case.** Forking and editing the first user message (no preceding anchor) creates a fresh empty thread with the parent's title and pins.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A thread with at least two completed turns (user -> assistant -> user -> assistant). Note the thread id.
- Venice API key seeded in `app_config` (see `AGENTS.local.md`) so completions can run.

## Steps

1. Fork and edit. Open the thread. Click the pencil button on the second user message. Click "Fork and edit" from the dropdown.

    ```sql
    select t.id, t.title, t.forked_from_thread_id, t.forked_from_msg_id, t.hidden,
      (select count(*) from messages m where m.thread_id = t.id) as msg_count
      from threads t where t.title ilike '%<thread-title>%'
      order by t.created_at desc;
    ```

2. Draft invisibility. Observe the fork's transcript. Check that no draft card is visible. Check the composer.

    ```sql
    select id, role, status, left(content, 60) as content_head, position
      from messages where thread_id = '<fork-id>'
      order by position;
    ```

3. Non-destructive. Switch back to the original thread in the drawer. Verify all messages are still there.

4. Reconnection. Switch to the fork in the drawer. Observe the composer.

5. Edit and send. Edit the text in the composer. Click Send. Wait for the response.

    Re-run the query from step 2.

6. Abandoned fork. Click "Fork and edit" on another user message. Navigate to a different thread without sending. Navigate back to the new fork.

7. First message. Open the original thread. Click the pencil button on the FIRST user message. Click "Fork and edit."

    ```sql
    select t.id, t.title, t.forked_from_thread_id, t.forked_from_msg_id
      from threads t where t.title ilike '%<thread-title>%'
      order by t.created_at desc limit 5;
    ```

## Expected

- (1) A new fork appears in the drawer under "Recent" with the forked-conversation glyph and the same title (no sigil - markTitle is false). The URL changes to the fork's cid. The composer is pre-populated with the old user message text. The fork's transcript shows the inherited prefix (the messages before the edited user message) but NOT the edited user message itself. The DB query shows the fork has `forked_from_thread_id` set to the original thread and `forked_from_msg_id` set to the message before the edited user message. The fork has 1 message (the draft).
- (2) The transcript shows the inherited prefix only. No draft card is visible. The composer contains the draft text. The DB query shows one row with `role=user, status=draft`.
- (3) The original thread has all its messages, `hidden=false`. The DB query from step 1 shows the original thread with the same message count as before.
- (4) The composer is re-populated with the draft text. The draft row is still in the DB with `status=draft`.
- (5) The draft is promoted: the DB query shows the row with `status=null` (was 'draft') and `content` updated to the edited text. A new assistant reply follows. The completion ran on the fork. The transcript shows the edited user message and the response.
- (6) The fork is still in the drawer. Navigating back shows the draft text in the composer. The draft row is still `status=draft` in the DB. No completion ran.
- (7) The fork has `forked_from_thread_id = null` and `forked_from_msg_id = null` (a fresh thread, no parent - there was no anchor before the first message). The composer is pre-populated with the first user message's text. The thread carries the parent's title and pins (model, reasoning, verbosity, toolboxes).

## Cleanup

Delete any test forks created:

```sql
delete from messages where thread_id in (
  select id from threads
   where title ilike '%<thread-title>%'
     and forked_from_thread_id is not null
);
delete from threads
 where title ilike '%<thread-title>%'
   and forked_from_thread_id is not null;
```

Also clean up any fresh threads from step 7 (forked_from_thread_id is null but created during the test run).

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
