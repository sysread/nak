# Chat: delete-from-here - the trash button on user messages

## Covers

The delete-from-here gesture ([dev: chat](../../dev/chat.md);
delete path `deleteMessages` in `src/lib/supabase/threads.ts`,
button + hover wiring in `src/screens/Chat.svelte`):

1. **Visibility.** The trash button sits in the action row of every
   USER message. Assistant replies show regenerate instead; neither
   button appears on auxiliary cards.
2. **Hover preview.** Hovering the trash button red-outlines the
   clicked user message and every row after it, via the same
   preview channel regenerate uses. Leaving clears it.
3. **Click semantics.** Clicking deletes the user message and
   everything after it from the view and the DB, reverting the
   thread to its pre-message state. Attachments on deleted rows are
   reclaimed (link rows cascade; storage objects removed
   best-effort - the delete path swallows Storage errors and the
   daily attachment-gc sweep backstops, so a transient Storage
   failure here is not a regression).
4. **Disabled mid-send.** The button is disabled while a reply is
   streaming on the thread.

This case is a BASELINE for the conversation-forking work (see
`docs/dev/in-progress/conversation-forking.md`): M1 must preserve
all four behaviors unchanged, and M6 later changes behavior number
3 ONLY inside a shared region of a forked thread - everywhere else
this case must keep passing as written.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user
  (`dev@nak.local` / `devpass123`).
- A fresh thread with three completed ordinary turns. Note its id
  (`<thread>`).
- One image file to attach in step 4.
- SQL access via `mise run dev-sql` (or psql to 127.0.0.1:54322).
- Every trash click fires a browser confirm() dialog ("Delete this
  message and everything after it?") - accept it. An automated
  executor must handle the dialog or it stalls on every delete.

## Steps

1. **Visibility sweep.** Hover each message. Note which rows offer
   the trash button and which offer regenerate.
2. **Hover preview.** Hover (do not click) the trash button on the
   SECOND user message. Observe the transcript, then move the
   pointer away. Run:

   ```sql
   select count(*) from messages where thread_id = '<thread>';
   ```

3. **Delete from the middle.** Click the trash button on the second
   user message. Re-run the step-2 count and re-read the
   transcript.
4. **Delete reclaims attachments.** Send a new prompt WITH the
   image attached; let the reply finish. Note the attachment row:

   ```sql
   select ma.id, ma.storage_path
     from message_attachments ma
     join messages m on m.id = ma.message_id
    where m.thread_id = '<thread>';
   ```

   Then click the trash button on that user message and re-run the
   query.
5. **Delete the first message.** Click the trash button on the
   FIRST user message. Read the transcript and the drawer.
6. **Disabled mid-send.** The thread is always empty after step 5,
   so this is a two-send step: (a) send a throwaway prompt and let
   its reply finish; (b) send another prompt and, while it streams,
   hover the trash button on the step-(a) user message.

## Expected

- (1) Every user message has the trash button; no assistant reply
  or auxiliary card does. Assistant replies have regenerate.
- (2) The hovered user message and every row below it are
  red-outlined; rows above stay normal. Leaving clears all
  outlines, and the count is unchanged - hovering deletes nothing.
- (3) The count drops by exactly the outlined-row count; the
  transcript now ends at the turn before the deleted message.
  Turn one is intact.
- (4) Before the delete the query shows the attachment row with a
  storage path. After the delete it returns zero rows, and the
  transcript shows neither the message nor the attachment.
- (5) The transcript is empty but the THREAD still exists - it
  remains in the drawer with its title, and the composer accepts a
  new message.
- (6) The trash button renders with the disabled attribute (still
  present, not hidden) while the send is in flight, and becomes
  active again when the reply settles.

## Cleanup

Delete the thread (drawer kebab, Delete).

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-08-21 | local (mise run dev-start) | f5e6c90b | PASS | All six steps verified incl. storage-object removal from the bucket (stronger than the doc's link-row check). Doc gaps found: every trash click fires a confirm() dialog the steps never mention, and step 6's parenthetical is the mandatory path after step 5 (thread is always empty then). Model: Mistral Small (deepseek-v4-flash was guard-failing all prompts this run). |
| 2026-08-21 | local (mise run dev-start) | 8abfe2bc | PASS (step 6 spot-check) | Position assignment after delete works correctly: deleting from the middle (positions 3-7 removed) left positions 1-2; the next send got position 3 (trigger assigned floor(max(2))+1). Gap-tolerant. Trash-disabled-mid-send behavior unchanged (gated on activeSlot.sending, not position). The two-send path over a thread with prior deletes produces correct monotonically-increasing positions. |
