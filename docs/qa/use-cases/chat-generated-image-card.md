# Chat: generated-image card renders without a reload

## Covers

The dedicated generated-image card and its by-filename resolution
([dev: components](../../dev/components.md),
[dev: attachments](../../dev/attachments.md)), the `generate_image`
tool's server-side per-round attach
([dev: tools](../../dev/tools.md)), and the regression this fixes:
before the card, a freshly generated image only appeared after a full
page reload because the per-round `message_attachments` insert never
echoes over the messages realtime channel.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A Venice key seeded in `app_config` (image generation calls the live
  Venice image model; without a key the tool errors and no card is
  expected).
- A thread with no pending reply. Note its thread id for the SQL check.

## Steps

1. In the thread, enable the **Images** toolbox via the composer
   toolbox popover (or let the model enable it in step 2).
2. Send: `Please create an image of a watercolor fox in a snowy
   forest.`
3. Watch the turn WITHOUT reloading. Observe the `generate_image`
   tool-call card while it runs, then the area directly below it once
   the tool card shows its success check.
4. After the image renders, click its preview.
5. Confirm the attachment exists on the round's assistant row:

   ```sql
   select ma.filename, ma.mime_type, ma.storage_path is not null as live
     from message_attachments ma
     join messages m on m.id = ma.message_id
    where m.thread_id = '<thread>'
    order by ma.created_at desc
    limit 5;
   ```

6. Reload the page and reopen the thread.
7. (Optional, regression anchor) In a second browser tab signed in as
   the same user, open the same thread and confirm the image is present
   there too.

## Expected

- (2-3) While `generate_image` runs, the tool-call card shows the live
  duration ticker. Once it completes, a NEW card appears directly below
  the tool-group card showing a loading placeholder (the K.I.T.T.-style
  Scanner pulse) sized to the image's aspect ratio, which then resolves
  into the image preview - all WITHOUT a page reload. The image is NOT
  rendered above the tool card.
- (4) Clicking the preview opens the full-resolution image in a new
  browser tab (same behavior as an uploaded image; no in-app lightbox).
- (5) Exactly one new image attachment row exists, `live = true`, with a
  `generated-<timestamp>.webp`-style filename, hung off the assistant
  row that issued the tool call.
- (6) After reload, the image still renders in the same dedicated card
  position below the tool-group card (no duplicate copy above it).
- (7) The observer tab shows the image in the same card without a manual
  reload.

## Cleanup

- Delete the QA thread if it is not otherwise useful (cascades the
  generated `message_attachments` row and frees the bucket object on the
  next expiry sweep).

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
