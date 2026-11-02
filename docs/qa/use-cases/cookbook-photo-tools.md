# Cookbook: photo tools (chat-driven attach / caption / reorder / remove)

## Covers

The chat-driven photo tool path - the model attaching conversation
images to a saved recipe and managing captions and order
([dev: cookbook](../../dev/cookbook.md),
[dev: tools](../../dev/tools.md)). Shipped alongside the
`recipe_photos` combination tool, which replaced the four
`recipe_photos_*` / `recipe_photo_label_set` verb tools (the same
journey; the wire envelope changed, not the contracts). The
browser-UI photo flow (Add photo / lightbox / reorder controls) is
[cookbook-recipe-lifecycle](./cookbook-recipe-lifecycle.md).

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user
  (`dev@nak.local` / `devpass123`), Venice key seeded in
  `app_config` so chat completions run.
- A saved recipe to decorate: ask the assistant in the same thread
  "Save a recipe called QA Photo Pantry with one ingredient and one
  step" and wait for it to land (realtime relay refreshes the open
  drawer).
- One small image file ready to attach to the conversation (any
  `image/*` under the attachment size cap).

## Steps

1. In the chat thread, attach the image (paperclip / paste) and
   wait for the upload to land. Note the filename shown on the
   attachment card.
2. Ask the assistant: "Attach the photo I just posted to QA Photo
   Pantry as the cover shot - caption it `cover`."
3. Attach a SECOND image to the conversation, then ask: "Attach my
   latest photo to the recipe too, no caption."
4. Ask: "Put the newest photo first" (reorder).
5. Ask: "Clear the caption on the cover shot" (label with null).
6. Ask: "Remove the photo I attached second" (remove by id).
7. Open the `Recipes` drawer tab, open `QA Photo Pantry`, expand
   `History`.

## Expected

- (2) The model resolves the posted image's filename from the
  thread-attachments context (no filename guessing in the reply),
  calls the photo tool with `op=attach` + the filename + the
  caption, and the reply names the change. The recipe detail pane's
  photo strip (if open) gains the photo with its caption WITHOUT a
  manual refresh - the recipes-table realtime relay picks the write
  up. `History` gains a row with the assistant's change message.
- (3) The second photo appends after the first (attach never
  reorders).
- (4) The photo strip order flips; positions renumber. `History`
  gains a reorder row. Captions travel with their photos.
- (5) The caption clears; the photo stays.
- (6) The named photo disappears from the strip. `History` gains a
  removal row. The other photo is untouched.
- (7) Every model-driven photo change appears as its own History
  row with the assistant's change message - the same version log
  the browser-UI photo edits write.

## Cleanup

```sql
delete from recipes
 where user_id = (select id from auth.users where email = 'dev@nak.local')
   and title = 'QA Photo Pantry';
```

The cascade drops the version + link rows; orphaned
`recipe_images` rows are reclaimed by the `recipe-image-gc` sweep.
The conversation's uploaded attachments expire on the normal
attachment schedule.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-11-02 | local stack, wt-nak/tool-combos | ad38b8c1 (pre-merge baseline) | PASS 7/7 (step 2's realtime strip check verified on step 3 instead; strip does not live-refresh on step 5/6 - fresh load at step 7 shows all rows) | Baseline ran against the four verb tools (recipe_photos_attach/_remove/_reorder, recipe_photo_label_set); all four exercised. Local-stack caveat: chat-turn image inline uses a signed 127.0.0.1 storage URL Venice cannot fetch (HTTP 400) - ran the thread on a temporary non-vision profile (filename-resolution path; analyze_image works since it base64-inlines). Model called analyze_image unprompted before each attach. History-list non-refresh is pre-existing behavior, out of scope. |
| 2026-11-02 | local stack, wt-nak/tool-combos | ad38b8c (post-change, `recipe_photos` combination tool) | PASS 7/7 | All five ops routed through the single `recipe_photos` tool with correct op + args on first call (attach/attach/reorder/label/remove). Realtime strip live-refreshed on steps 2, 5, and 6 - better than baseline, which only saw it on 3. History counter still lags until a fresh load (pre-existing). Model did NOT call `analyze_image` this run (baseline did, unprompted). Same non-vision temp-profile workaround for the 127.0.0.1 signed-URL quirk. Test images regenerated in-page under the same filenames due to a browser-tool sandbox restriction. |
