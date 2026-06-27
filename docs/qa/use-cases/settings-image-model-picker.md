# Settings: image-generation model picker drives generate_image

## Covers

The Settings -> AI -> **Image generation** picker
([dev: settings](../../dev/settings.md)), the `?type=image` catalog
fetch through the venice `models` route, the `profiles.settings.imageModel`
round-trip, and the server-side resolution in `generate_image`
([dev: tools](../../dev/tools.md)): the tool reads the configured id at
generation time and falls back to the built-in default
(`venice-sd35`) when unset.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- A Venice key seeded in `app_config` (the picker fetches the live
  Venice image catalog through the edge function; image generation
  calls the live model).
- A thread with no pending reply, with the **Images** toolbox available.

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

5. In a thread with the **Images** toolbox enabled, send: `Please
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
  absence, and `generate_image` falls back to `venice-sd35`.

## Cleanup

- Clear any leftover override so the dev user returns to the default:
  re-select the default model in the picker (step 7) if you haven't.
- Delete the QA thread if it is not otherwise useful.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
