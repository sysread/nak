# Chat: edit a user message destructively (private tail)

## Covers

The destructive edit flow ([dev: user-message-editing](../../dev/user-message-editing.md); range computation in `src/lib/ui/message-delete.ts`, handler + send branch in `src/screens/Chat.svelte`, supersede via `commit_assistant_message`):

1. **Dropdown visibility.** A pencil button on every user message opens a dropdown with "Edit" and "Fork and edit."
2. **Shared-region gate.** When the user message is in a shared region (other forks depend on it), "Edit" is hidden - only "Fork and edit" appears.
3. **Edit click.** Clicking "Edit" pre-populates the composer with the old message text, red-highlights the old message and everything after it, and sets pendingEdit state. The user edits and sends.
4. **Send semantics.** On send, a new user message is inserted with the edited text. The old range (old user message + everything after) is superseded - deleted atomically by the commit RPC when the new assistant reply lands. The completion runs against the new user message.
5. **Abandon.** Navigating to another thread clears the red highlighting and the pendingEdit state. The old messages survive untouched.
6. **Disabled states.** The pencil button is disabled while a send is in flight on the thread.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A thread with at least three completed turns (user -> assistant -> user -> assistant -> user -> assistant). Note the thread id.
- For the shared-region test: a second thread that was forked from the first (use the fork-from-message button on the first user message of the first thread). This makes the first user message's range shared.

## Steps

1. Dropdown visibility. Open the thread. Click the pencil button on the second user message. Observe the dropdown.
2. Edit click. Click "Edit" from the dropdown. Observe the composer and the transcript.

    ```sql
    select role, status, left(content, 60) as content_head, position
      from messages
     where thread_id = '<thread>'
     order by position;
    ```

3. Edit and send. Edit the text in the composer (change a word or two). Click Send. Wait for the response to stream.

    Re-run the query from step 2.

4. Abandon. Click the pencil button on another user message, click "Edit." Before sending, click a different thread in the drawer. Come back to the original thread.

5. Shared-region gate. Open the first thread (the one that was forked from). Click the pencil button on the first user message (the one a fork depends on). Observe the dropdown items.

6. Disabled state. Send a new message. While the response is streaming, try clicking the pencil button on any user message.

7. Edit after a stop, then continue. Send a message, click Stop while the reply streams, click the pencil on that message, choose "Edit," change the text, send, and wait for the reply. Then send one more message and wait for its reply. Re-run the query from step 2, then reload the page.

## Expected

- (1) The dropdown shows two items: "Edit" and "Fork and edit." Both are visible and clickable.
- (2) The composer is pre-populated with the old message text. The old user message and every row after it (the old assistant reply and any later turns) have the red `.regen-target` outline. Rows above the edited message stay normal. The DB query shows the original rows unchanged (nothing deleted yet).
- (3) The old range is gone from the view and the DB. The query shows the new user message (with the edited text) followed by the new assistant reply. Rows before the edited message are untouched. The old user message and old assistant reply are deleted. The new user message's `position` equals the old user message's position from step 2, and it is lower than the new assistant reply's position (the reply row is created when streaming starts, before the commit inserts the replacement). Reload the page: the edited message still renders directly above its reply.
- (7) Same as (3), then send one more message. The edited message, its reply, the new message, and the new reply render in that order, both live and after a reload. The `position` query shows the same order.
- (4) The red highlighting clears. The old messages are still visible and in the DB (query count unchanged). The composer is cleared or reset. No pendingEdit state remains.
- (5) The dropdown shows only "Fork and edit" - no "Edit" item. The shared-region gate hides the destructive option.
- (6) The pencil button is disabled (not clickable) while a send is in flight.

## Cleanup

The destructive edit permanently deletes the superseded rows. To restore the thread for future QA runs:

```sql
delete from messages where thread_id = '<thread>' and position >= <new-user-msg-position>;
```

Or re-run the steps on a fresh thread.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-08-26 | local (mise run dev-start) | 59ea99c1 | PASS (1-6) | All 6 steps pass. (1) Dropdown shows Edit + Fork and edit on all 4 user messages. (2) Composer pre-populated with old text, 3 messages red-highlighted (old user msg + everything after). (3) Edited text visible, old text gone; DB confirms old range (pos 9-11) superseded, new user msg at pos 12, assistant reply at pos 13 complete. (4) Abandon: red highlights cleared on thread switch, old messages survived (10 rows in DB). (5) Shared-region gate: only "Fork and edit" shown on a forked message, no "Edit" item. (6) Edit buttons disabled during streaming (both true). |
| 2026-08-27 | local (mise run dev-start) | 743ed1da | PASS (1-5), CONDITIONAL (3) | Re-run after B-1/B-2/M-5 fixes. (1) Dropdown shows both items on 2 user messages. (2) Composer pre-populated, 3 red-highlighted blocks. (3) Atomic edit: on completion error, old range survived (not deleted), no new user message inserted - edit is a clean no-op. The error row (streaming attempt transitioned to status=error) is visible. On success, the commit RPC inserts the new user message + deletes the old range atomically. (4) Abandon with return-to-thread: red highlights cleared (0), composer cleared, old messages survived - B-1 fix confirmed. (5) Shared-region gate: only "Fork and edit" shown. |
| 2026-09-01 | scratch Postgres 16, RPC only (no UI) | (this commit) | PASS (7, RPC layer) | Reproduced the step-7 bug against the previous `commit_assistant_message`: after the edit commit the DB held `[reply pos 3, edited user pos 4]`. With the rewritten RPC the same call yields `[edited user pos 1, reply pos 3]`, and a follow-up plain commit appends `[user pos 4, reply pos 5]`. Also checked: regenerate keeps its anchor, an empty-content edit keeps the old rows and inserts nothing, a competing send still returns `newer_user_message`, an inherited edit anchor returns `edit_anchor_inherited`, and a plain inherited-anchor commit still succeeds. Steps 1-6 and the browser half of 7 not run (cloud session, no browser). |
