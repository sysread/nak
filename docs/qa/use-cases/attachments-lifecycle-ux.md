# Attachments: intake, rendering, and expiry surfaces

## Covers

Composer attachment entry points and send gating
([dev: attachments](../../dev/attachments.md),
[dev: chat](../../dev/chat.md)), extracted-text drawers
([dev: attachments](../../dev/attachments.md)), and the 30-day storage
reclaimer's visible end state ([dev: file storage](../../dev/file-storage.md),
[dev: attachments](../../dev/attachments.md)).

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A thread with no pending reply.
- Two local files ready to attach:

  ```sh
  printf 'Nak attachment QA text fixture\n' > /tmp/nak-attachment-qa.txt
  cp public/icon.svg /tmp/nak-attachment-qa.svg
  ```

- For the expired-file expectation, note the thread id after the send.

## Steps

1. In the thread composer, attach `/tmp/nak-attachment-qa.txt` with the
   paperclip button.
2. Before sending, remove the text attachment with the chip's `×` button.
3. Attach `/tmp/nak-attachment-qa.txt` again, then drag
   `/tmp/nak-attachment-qa.svg` onto the composer.
4. Wait for both attachment chips to leave their dashed `processing`
   state.
5. Send `Attachment QA` with both attachments.
6. In the sent message, click the text file's `Text` button.
7. In the same message, click the image preview to open it full-size.
8. Force the thread's attachment lease to expire:

   ```sql
   update threads
      set updated_at = now() - interval '31 days'
    where id = '<thread>';
   ```

9. Run the attachment expiry job:

   ```sh
   export SERVICE_ROLE_KEY="$(supabase status -o json | jq -r '.service_role_key')"
   curl -s -X POST \
     http://127.0.0.1:54321/functions/v1/expire-attachments \
     -H "Authorization: Bearer $SERVICE_ROLE_KEY"
   ```

10. Reload the thread and inspect the previously sent message.
11. Send `lease reset` in the same thread.

## Expected

- (1-2) The paperclip adds a chip above the textarea, and the chip's
  `×` control removes it before send.
- (3-4) Both files render as chips above the textarea; send remains
  blocked until the dashed `processing` styling clears.
- (5) The sent message shows the SVG as a large preview and the text
  file as a download chip with the original filename.
- (6) The `Text` button opens the extracted-text drawer and shows the
  fixture line `Nak attachment QA text fixture`.
- (7) Clicking the image preview opens the full-size image in a new
  browser tab (there is no in-app lightbox); the thread is unaffected.
- (8-10) After the expiry run, the message stays readable. The expired
  attachment surface shows a clock icon / expired state, and the text
  file's `Text` button still opens the extracted text.
- (11) The new reply succeeds normally; the thread remains usable after
  the expiry path dirties attachment storage state.

## Cleanup

- Delete the QA thread if it is not otherwise useful.
- Remove the local fixtures:

  ```sh
  rm -f /tmp/nak-attachment-qa.txt /tmp/nak-attachment-qa.svg
  ```

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
