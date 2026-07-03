# Cookbook: recipe lifecycle (author, version, photos, bookmarks, rating, LLM tools)

## Covers

The full recipe lifecycle in the Cookbook panel and its LLM tool path
([dev: cookbook](../../dev/cookbook.md)): authoring in Cooklang, the
immutable version log + revert, photo attach/reorder/caption + the
lightbox, the Upcoming / Favorites bookmark flags, click-to-rate, the
plain-text / Markdown / Cooklang copy exports (AnyList-transfer
framing), and a model-driven `recipe_save` landing live via the
realtime relay ([dev: tools](../../dev/tools.md),
[dev: chat](../../dev/chat.md)).

Out of scope - covered elsewhere: drawer recipe SEARCH (the semantic
embed plus substring path) is
[search-cross-tab](./search-cross-tab.md); the
DELETE-replication replica-identity mechanics are
[realtime-relays](./realtime-relays.md); recipe-image orphan GC is
[background-maintenance](./background-maintenance.md). This case
exercises the relay only far enough to prove a tool write refreshes an
open panel.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user
  (`dev@nak.local` / `devpass123`).
- The `cooking` toolbox exists in the registry; the model enables it
  itself via `toggle_toolbox` before reaching for a write tool, so no
  manual toggle is needed for the LLM-path step.
- Two small image files on disk to use as recipe photos (any
  `image/*` under the attachment size cap; a downscale pass runs on
  add).
- Start from a clean slate for the title this case uses. The recipe
  is authored by hand in step 3, but if a prior run left it behind,
  clear it first so the create path is exercised, not an update:

  ```sql
  delete from recipes
   where user_id = (select id from auth.users where email = 'dev@nak.local')
     and title in ('QA Skillet Cornbread', 'QA Agent Soup');
  ```

## Steps

1. Open the `Recipes` drawer tab. Note the listing (Upcoming /
   Favorites sections at the top, then the main "All recipes" list).
2. Click `+ New recipe` (the top-bar button above the panel). In the
   edit form, set `Title` to `QA Skillet Cornbread`, leave `Source`
   and `Source URL` empty, leave `Rating` unset, and replace the
   seeded Cooklang with a sectioned recipe that has at least two
   ingredients and two instruction steps, e.g.:

   ```text
   >> servings: 8

   == Ingredients ==
   @cornmeal{1.5%cups}
   @buttermilk{1%cup}
   @?honey{2%tbsp}

   --

   == Instructions ==
   Heat the #skillet{} and whisk the @cornmeal{} with the
   @buttermilk{}.
   Bake for ~{25%min} until golden.
   ```

3. Watch the `Preview` pane while typing, then clear the `What
   changed?` field and click `Save`. Re-enter a message
   (`create qa cornbread`) and click `Save` again.
4. On the resulting detail pane, expand `History`.
5. Click the cart (Upcoming) icon, then the thumbs-up (Favorite)
   icon in the action bar. Re-open the `Recipes` drawer tab and look
   at the Upcoming and Favorites sections.
6. Back on the detail pane, click the 4th star in the rating row.
   Re-expand `History`.
7. Click `Edit`. In the `Photos` row, add the two image files via
   `Add photo`. Set a caption on the first photo. Reorder the two
   with the `‹` / `›` controls. Enter `add photos` in `What
   changed?` and click `Save`.
8. On the detail pane, click the first photo thumbnail to open the
   lightbox, page with the `›` arrow (or arrow key) and the swipe if
   on touch, confirm the caption + counter, then press `Escape`.
9. Click `Copy as plain text`, then `Copy as Markdown`, then
   `Copy Cooklang source`, pasting each into a scratch buffer to
   inspect.
10. Expand `History`, click the oldest version row (the initial
    create), inspect the read-only banner, then click
    `Revert to this version` and accept the prompted change message.
11. In a chat thread, enable the cooking tools if the composer
    surfaces a toolbox control, then ask the assistant: "Save a
    recipe called QA Agent Soup with a couple of ingredients and two
    steps." Leave the `Recipes` drawer tab open (or open it after).
12. Return to the detail pane for `QA Skillet Cornbread` and click
    the trash (Delete) icon; cancel the browser confirm once, then
    re-click and confirm.

## Expected

- (1) The drawer renders the `Recipes` tab listing; with nothing
  bookmarked yet the Upcoming / Favorites sections are absent or
  empty and the main list shows existing recipes.
- (2-3) The `Preview` pane re-renders live as Cooklang is typed
  (ingredients grouped under the `==` section headings, the `--`
  dash line ending the declaration block so the instructions don't
  inherit the Ingredients heading). The `@?honey` row carries a
  muted *(optional)* tag after its name in the ingredient list.
  `Save` is blocked with an inline
  error until `What changed?` is non-empty; with a message it
  persists and the panel flips to the detail pane. The saved row
  appears at the top of the drawer's "All recipes" list (updated
  sort).
- (4) `History` lazy-loads on first detail open and shows exactly one
  row - the create - badged `current`. Its `change_message` is the
  `create qa cornbread` message you typed (the tool-path default
  `Initial version` only applies to model saves, not the modal).
- (5) The cart and thumbs-up icons fill / accent on activation. The
  recipe now appears in BOTH the `Upcoming` and `Favorites` drawer
  sections AND in its natural slot in the main list (the duplication
  is intentional). Toggling does NOT reorder the main list - the
  recency sort is stable because the bookmark write skips
  `updated_at`.
- (6) The detail rating row fills to 4 stars and persists. `History`
  gains a new row whose message reads `Rated 4 stars.` - a rating
  change writes a version like any content edit.
- (7) Photos upload (downscale + dedup), `Save` is disabled while an
  upload is in flight, the caption and the new order persist, and
  `History` gains an `add photos` row. The detail pane shows a photo
  strip above the rendered recipe with the caption under the first
  thumbnail.
- (8) The lightbox opens to the clicked photo, pages with the arrow /
  key / swipe and loops at the ends, shows the caption and an `N / M`
  counter, and `Escape` (or a click on the dim surround) dismisses
  it. A click on the image itself does NOT dismiss.
- (9) Plain text is title + ingredients + numbered instructions with
  NO cookware line (the skillet is omitted - AnyList-transfer
  framing); the honey bullet reads `- 2 tbsp honey (optional)`.
  Markdown includes the cookware list and any source link,
  and passes recipe content through verbatim (no escaping). Cooklang
  is the raw source you authored. Each copy flashes a `Copied.` /
  `Markdown copied.` / `Cooklang source copied.` confirmation.
- (10) Clicking the initial-create row swaps the body to that
  read-only snapshot with a `Viewing version from ...` banner and
  `Back to current` / `Revert to this version` controls; the photos
  and the 4-star rating are gone in that snapshot (they came later).
  `Revert to this version` requires a change message and writes a NEW
  `History` row carrying the restored (photo-less) content - the
  revert is itself a version, so it is recoverable.
- (11) The assistant flips the `cooking` toolbox on (visible in the
  tool-call trace) and calls `recipe_save`; the saved `QA Agent Soup`
  row appears in the open `Recipes` drawer tab WITHOUT a manual
  refresh, via the realtime relay. Its `History` shows one row -
  `Initial version` if the model omitted a change message, otherwise
  the model's own message.
- (12) The browser confirm gates the delete; `Cancel` leaves the
  recipe intact, confirming removes it from the listing and lands the
  panel on the empty / list pane. Unrelated recipes (including
  `QA Agent Soup`) are untouched.

## Cleanup

- Delete the two QA recipes if they survived the run:

  ```sql
  delete from recipes
   where user_id = (select id from auth.users where email = 'dev@nak.local')
     and title in ('QA Skillet Cornbread', 'QA Agent Soup');
  ```

  The cascade through `recipe_versions` -> `recipe_version_images`
  drops the version and link rows; the uploaded `recipe_images` rows
  become orphans reclaimed by the `recipe-image-gc` sweep (see
  [background-maintenance](./background-maintenance.md)) - no manual
  bucket cleanup needed.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
