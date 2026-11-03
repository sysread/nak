# Settings: image-generation model picker drives the image tool

## Covers

The Settings -> AI -> **Image generation** picker
([dev: settings](../../dev/settings.md)), the `?type=image` catalog
fetch through the venice `models` route, the `profiles.settings.imageModel`
round-trip, and the server-side resolution in the `image` tool
([dev: tools](../../dev/tools.md)): the tool reads the configured id at
generation time and falls back to the built-in default
(`venice-sd35`) when unset.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A Venice key seeded in `app_config` (the picker fetches the live
  Venice image catalog through the edge function; image generation
  calls the live model).
- A thread with no pending reply.

## Steps

1. Open **Settings -> AI** and scroll to **Image generation**.
2. Observe the dropdown while the image catalog loads, then once it
   populates. Note the option labels.
3. Pick a non-default model from the dropdown (any entry other than the
   one shown selected on first open). Watch for the confirmation line.
4. Confirm the choice persisted:

   ```sql
   select settings->>'imageModel' as image_model
     from profiles
    where user_id = auth.uid();
   ```

5. In a thread, send: `Please
   create an image of a watercolor fox in a snowy forest.`
6. After the image renders, confirm which model served it - check the
   venice function logs for the `image/generate` request body's `model`
   field (`mise run dev-sql` / the function logs), or the Usage pane's
   per-model spend after the run.
7. Return to **Settings -> AI -> Image generation** and re-select the
   **default** model (the built-in `venice-sd35`).
8. Re-run the SQL from step 4.

## Expected

- (2) While loading, the picker is disabled and a "Loading image
  models from Venice..." line shows. Once loaded, each row left-aligns
  the model name (with `beta` / `retiring` tags where applicable) and
  right-aligns the per-image price in a pill; the pills line up in a
  column. Every listed model has a real price - models Venice prices
  per resolution tier or doesn't price at all are filtered out, so no
  "n/a" row ever appears. The currently-effective model is selected.
- (3) A confirmation line appears ("Image generation now uses
  `<name>`."). No page reload needed.
- (4) `image_model` equals the id you picked.
- (5-6) An image is generated and attached (same card behavior as the
  generated-image-card use-case), and the model that served it is the
  one you selected in step 3 - NOT `venice-sd35`.
- (7) Selecting the default clears the override rather than storing it.
- (8) `image_model` is now NULL (absent) - "default" is represented as
  absence, and the image tool falls back to `venice-sd35`.

## Image editing picker (Settings -> AI)

The **Image editing** picker works the same round-trip for the `edit`
op: it lists the `?type=inpaint` catalog slice, writes
`profiles.settings.editImageModel`, and the image tool's edit op reads
it at call time (default `firered-image-edit`). Verify by switching to
a non-default edit model, asking the model to change an existing
picture, and confirming the venice function logs' `/image/edit` body
carried the picked id. Returning to **default** clears the override
(absence = default), the mirror of the generation picker's steps 7-8.

## Hidden models: the price-cap filter

Both pickers hide models over the deployment's `maxImageUsd` cap
(`filterImageCatalogByCap` for generation, `filterEditCatalogByCap`
for editing) - an over-cap model is never offered, so the picker never
tempts a pick the tool-side 403 would refuse. Unpriced models
(per-resolution-tier pricing or no pricing block) are dropped too: the
picker only shows rows with a flat price. A stale stored id the cap
now forbids is caught by the tool-side 403 backstop, not the picker.

## Cleanup

- Clear any leftover override so the dev user returns to the default:
  re-select the default model in the picker (step 7) if you haven't.
- Delete the QA thread if it is not otherwise useful.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-11-03 | local (dev@nak.local) | 82078d9 | PARTIAL | Tool rename clean: all calls `image` + op=generate. Steps 1,2,4,7,8 PASS. Step 3 FAIL: confirmation line renders at pane bottom, off-screen. Steps 5-6 FAIL on qwen-image (tool always sends width/height; model rejects them), PASS on default venice-sd35. Doc drift: Image editing section + price-cap filter undocumented. |
| 2026-11-03 | local stack, worktree Vite :5174 ([::1] origin), realtime-delivery-fixes branch | ce0926d9 (+plan commits) | pass (1,2,4,7,8) / FAIL (3, rider-c baseline) | M0 baseline. Step 2: catalog loads, rows carry left-aligned name + right-aligned price pill. Step 3 MEASURED FAIL (rider c): "Image generation now uses `Chroma`." renders at y=1104 in an 817px viewport - 287px below the fold and 588px below the picker (y=516) - and the line carries NO aria-live. Steps 5-6 not re-run this pass (Chroma live turn skipped; behavior covered by the 82078d9 row above). Step 7: re-selecting Venice SD35 shows "Image generation now uses Venice SD35." Step 8: imageModel absent (default = absence). Concurrent garrick QA activity: none. |
| 2026-11-03 | local stack, worktree Vite :5174 ([::1] origin), realtime-delivery-fixes branch | branch HEAD (fixes applied) | PASS (3, post-change) | M8 post-change re-run. Step 3: "Image generation now uses `Chroma`." now renders at y=739 - 223px below the picker (y=516), IN the 817px viewport, and carries aria-live=polite. Default restored after (imageModel absent). |
| 2026-11-03 | local (dev@nak.local) | 13f48e2f | PASS | Steps 1-8 all pass on the fixed branch: qwen-image picked via the Image generation model combobox (persisted to profiles.settings), generate on qwen-image SUCCEEDED where the pre-fix run failed (aspect_ratio on the wire, no dimensions; descriptor dims decoded from the output), default re-select cleared the override (imageModel NULL). Image editing + price-cap hidden-models sections now documented in this file. The qwen-image 400 body was never observed post-fix (the proactive constraint lookup prevented it) - the reactive matcher stays broad per plan D2 accepted risk. |
