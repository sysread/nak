# Attachments: intake, compression, rendering, and manual delete

## Covers

Composer attachment entry points and send gating
([dev: attachments](../../dev/attachments.md),
[dev: chat](../../dev/chat.md)), on-upload image compression
([dev: attachments](../../dev/attachments.md)), extracted-text drawers
([dev: attachments](../../dev/attachments.md)), and the Artifacts tab -
cross-thread file listing, filters, and per-file delete - plus the
deleted-file placeholder it leaves behind
([dev: file storage](../../dev/file-storage.md),
[dev: attachments](../../dev/attachments.md)).

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A thread with no pending reply.
- Local files ready to attach:

  ```sh
  printf 'Nak attachment QA text fixture\n' > /tmp/nak-attachment-qa.txt
  cp public/icon.svg /tmp/nak-attachment-qa.svg
  ```

- One image larger than 1 MB on the long edge (a phone photo or a
  full-resolution screenshot works) at `/tmp/nak-attachment-qa-big.jpg`,
  to exercise the on-upload compressor.

## Steps

1. In the thread composer, attach `/tmp/nak-attachment-qa.txt` with the
   paperclip button.
2. Before sending, remove the text attachment with the chip's `×` button.
3. Attach `/tmp/nak-attachment-qa.txt` again, then drag
   `/tmp/nak-attachment-qa.svg` onto the composer.
4. Attach `/tmp/nak-attachment-qa-big.jpg` and watch its chip.
5. Wait for every attachment chip to leave its dashed `processing`
   state.
6. Send `Attachment QA` with the attachments.
7. In the sent message, click the text file's `Text` button.
8. In the same message, click the image preview to open it full-size.
9. Open the **Artifacts** tab in the left drawer.
10. Use the type filter (All / Images / Files) and the sort toggle
    (Newest / Largest). Confirm the search box filters by filename.
11. Click the big image's row in the Artifacts list.
12. Back in the Artifacts tab, click the trash button on the big image
    and confirm the prompt.
13. Reload the thread and inspect the previously sent message.
14. Send `still works` in the same thread.

## Expected

- (1-2) The paperclip adds a chip above the textarea, and the chip's
  `×` control removes it before send.
- (3) Both files render as chips above the textarea.
- (4) The big image's chip briefly shows a "Compressing large image"
  spinner, then a `Reduced from <X> to <Y>` note (the result is smaller
  than the original; the exact figure depends on the source).
- (5) Send remains blocked until every chip's dashed `processing`
  styling clears.
- (6) The sent message shows the images as large previews and the text
  file as a download chip with the original filename.
- (7) The `Text` button opens the extracted-text drawer and shows the
  fixture line `Nak attachment QA text fixture`.
- (8) Clicking the image preview opens the full-size image in a new
  browser tab (there is no in-app lightbox); the thread is unaffected.
- (9) The Artifacts tab lists every file from this thread (and any
  others), newest-first, each with a thumbnail (images) or file glyph
  and the conversation title it belongs to.
- (10) `Images` hides the text file; `Files` hides the images; `Largest`
  orders the big image above the small ones; the search box narrows the
  list by filename substring.
- (11) The row navigates to this conversation and closes the drawer on
  a narrow viewport.
- (12) After confirming, the big image disappears from the Artifacts
  list immediately.
- (13) The message stays readable; the deleted image now shows the
  greyed clock placeholder, and the text file's `Text` button still
  opens the extracted text.
- (14) The new reply succeeds normally; the thread remains usable after
  the delete dirtied attachment storage state.

## Cleanup

- Delete the QA thread if it is not otherwise useful.
- Remove the local fixtures:

  ```sh
  rm -f /tmp/nak-attachment-qa.txt /tmp/nak-attachment-qa.svg /tmp/nak-attachment-qa-big.jpg
  ```

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
