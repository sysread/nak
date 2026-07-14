# Grocery list: recipe bridge, shopping flow, sections, photos

## Covers

The Groceries tab end to end
([dev: grocery list](../../dev/grocery-list.md)): the ingredient
checkboxes on recipes and the recipe-edit invalidation
trigger ([dev: cookbook](../../dev/cookbook.md)), the main panel's
needed / acquired shopping flow with the collapsed history, the
add-input's acquired-history suggestions, section management (add /
rename / delete / drag reorder), the item photo path
([dev: file storage](../../dev/file-storage.md)), the sidebar's
all-items browse (search + status/section filters + checkbox
toggles), and the realtime relay between the Cookbook pane and an
open Groceries tab.

Layout note: the SIDEBAR (drawer) is the all-items browse over the
full purchase history; the MAIN PANEL is the current shopping list.
Steps below name which surface they mean.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- At least one recipe in the cookbook with 3+ ingredients. If none
  exists, create one from the Recipes tab (`+ New recipe`) with body:

  ```text
  Whisk @eggs{3}, @flour{200%g}, and @?salt together.
  ```

- The recipe NOT marked upcoming or favorite at start.
- Any small image file at `/tmp/nak-grocery-qa.jpg` for the photo
  step.

## Steps

1. Open the drawer and click the **Groceries** tab (directly above
   Recipes). First-ever open on this account.
2. Open the test recipe from the Recipes tab and look at its
   ingredient list.
3. In the recipe's action bar, click the cart icon (mark upcoming),
   then look at the ingredient list again.
4. Check the checkboxes for `eggs` and `flour`.
5. Switch to the Groceries tab and look at the MAIN PANEL.
6. In the main panel, tap the `eggs` item's name, set its section to
   **Dairy** in the editor, and Save.
7. In the main panel, uncheck `eggs` (simulate buying it), then
   expand the **Acquired** disclosure at the bottom.
8. In the main panel's **Add to list** input, type `egg` and wait a
   beat.
9. Click the `eggs` suggestion.
10. Type `paper towels` in the add input and click the
    `Add "paper towels"` action.
11. Tap `paper towels`, add a photo via **Add photo** with
    `/tmp/nak-grocery-qa.jpg`, and Save.
12. Click **Sections** (main panel): rename `Bread` to `Bakery`, add
    a section `Pharmacy`, drag `Pharmacy` above `Produce`, then
    delete `Dairy`.
13. In the SIDEBAR, search `paper`, then clear the search and set
    the status filter to `Acquired`. Set it back to `All`, tick
    **Show recipe ingredients**, uncheck `eggs` in the sidebar, then
    re-check it.
14. Back on the recipe (Recipes tab), uncheck `flour`.
15. Re-check `flour`, then edit the recipe (pencil), change `3` eggs
    to `4`, and save the edit.
16. Return to the Groceries tab.
17. In the DB, confirm the trigger really fired:

    ```sh
    mise run dev-sql "select name, needed, recipe_id from grocery_items order by created_at"
    ```

## Expected

- (1) The main panel renders one empty card per section: **Other**
  first, then the canned starters in order (Produce, Bread, Deli,
  Meats, Dairy, Frozen, Snacks, Pantry, Beverages, Household), each
  showing "No items"; the "Nothing on the list" hint sits above
  them.
- (2) Every ingredient row carries an unchecked checkbox even
  though the recipe is not bookmarked - the grocery bridge is not
  gated on upcoming/favorite.
- (3) Marking upcoming changes nothing about the checkboxes (it
  only files the recipe in the sidebar's Upcoming bucket).
- (4) Both boxes stay checked. The Groceries main panel (5) shows
  `eggs` (with `3`) and `flour` (with `200 g`), each noting
  `For <recipe title>`, under **Other**; the sidebar lists both rows
  with checked boxes.
- (6) `eggs` moves into the **Dairy** card; the **Other** card keeps
  `flour`. Within a card, items order alphabetically by name.
- (7) `eggs` drops out of the needed list into the greyed
  **Acquired (1)** section (collapsed until clicked; name shown
  struck through). On the recipe, the `eggs` checkbox is now
  UNCHECKED - the box mirrors "on the list right now". (Steps 8-9
  revive the same row via the add-input; checking the recipe box
  again would revive it identically.)
- (8-9) The suggestion list shows `eggs`; picking it returns the
  same row to the needed list under **Dairy** (section survived the
  round trip).
- (10) `paper towels` appears under **Other**; the suggestion panel
  offered "Add" because no acquired item matches.
- (11) A thumbnail renders on the `paper towels` row after Save.
- (12) Rename, add, drag order (Pharmacy first), and delete all
  stick after closing/reopening the manager. Deleting `Dairy` moves
  `eggs` to **Other** - the item survives.
- (13) Sidebar: searching `paper` narrows to `paper towels` under a
  **Staples** header; `eggs` / `flour` are absent until **Show
  recipe ingredients** is ticked, after which they appear under an
  **Ingredients** header below Staples. The `Acquired` filter shows
  only bought rows (muted). Unchecking `eggs` in the sidebar drops
  it from the main panel's needed list into Acquired; re-checking
  restores it, section intact - the sidebar checkbox and the panel
  are two views of the same flag.
- (14) Unchecking `flour` on the recipe removes it from both
  Groceries surfaces (open in another window to watch the realtime
  refresh) - a recipe-side uncheck DELETES the row rather than
  moving it to acquired.
- (15-16) After the recipe edit, ALL of this recipe's items
  (`flour` from the re-check, and `eggs` regardless of its needed
  state) are gone from both surfaces; `paper towels` (manual, no
  recipe link) survives.
- (17) Only rows with `recipe_id is null` remain.

## Cleanup

Delete the leftover manual items from the Groceries tab (editor ->
Delete), un-bookmark the test recipe, and optionally reset sections:

```sh
mise run dev-sql "delete from grocery_items; delete from grocery_sections"
```

(The canned set re-seeds on the next Groceries-tab load.)

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
