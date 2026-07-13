# Grocery list: recipe bridge, shopping flow, sections, photos

## Covers

The Groceries drawer tab end to end
([dev: grocery list](../../dev/grocery-list.md)): the ingredient
checkboxes on bookmarked recipes and the recipe-edit invalidation
trigger ([dev: cookbook](../../dev/cookbook.md)), the needed /
acquired shopping flow with the collapsed history, the add-input's
acquired-history suggestions, section management (add / rename /
delete / drag reorder), the item photo path
([dev: file storage](../../dev/file-storage.md)), and the realtime
relay between the Cookbook pane and an open Groceries tab.

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
5. Switch to the Groceries tab.
6. In the list, tap the `eggs` item's name, set its section to
   **Dairy** in the editor, and Save.
7. Uncheck `eggs` (simulate buying it), then expand the **Acquired**
   disclosure at the bottom.
8. In the **Add to list** input, type `egg` and wait a beat.
9. Click the `eggs` suggestion.
10. Type `paper towels` in the add input and click the
    `Add "paper towels"` action.
11. Tap `paper towels`, add a photo via **Add photo** with
    `/tmp/nak-grocery-qa.jpg`, and Save.
12. Click **Sections**: rename `Bread` to `Bakery`, add a section
    `Pharmacy`, drag `Pharmacy` above `Produce`, then delete
    `Dairy`.
13. Back on the recipe (Recipes tab), uncheck `flour`.
14. Re-check `flour`, then edit the recipe (pencil), change `3` eggs
    to `4`, and save the edit.
15. Return to the Groceries tab.
16. In the DB, confirm the trigger really fired:

    ```sh
    mise run dev-sql "select name, needed, recipe_id from grocery_items order by created_at"
    ```

## Expected

- (1) The tab renders an empty list plus the canned starter
  sections in the Sections manager (verify via step 12 or
  `grocery_sections` in the DB): Produce, Bread, Deli, Meats,
  Dairy, Frozen, Snacks, Pantry, Beverages, Household.
- (2) No checkboxes on the ingredient rows (recipe not bookmarked).
- (3) After marking upcoming, every ingredient row gains an
  unchecked checkbox.
- (4) Both boxes stay checked. Groceries tab (5) shows `eggs` (with
  `3`) and `flour` (with `200 g`), each noting `For <recipe title>`,
  under **Other**.
- (6) `eggs` moves under a **Dairy** group header; **Other** keeps
  `flour`.
- (7) `eggs` drops out of the needed list into the greyed
  **Acquired (1)** section (collapsed until clicked; name shown
  struck through). On the recipe, the `eggs` checkbox is STILL
  checked - buying does not un-plan.
- (8-9) The suggestion list shows `eggs`; picking it returns the
  same row to the needed list under **Dairy** (section survived the
  round trip).
- (10) `paper towels` appears under **Other**; the suggestion panel
  offered "Add" because no acquired item matches.
- (11) A thumbnail renders on the `paper towels` row after Save.
- (12) Rename, add, drag order (Pharmacy first), and delete all
  stick after closing/reopening the manager. Deleting `Dairy` moves
  `eggs` to **Other** - the item survives.
- (13) Unchecking `flour` on the recipe removes it from the
  Groceries tab (open in another window to watch the realtime
  refresh) - a recipe-side uncheck DELETES the row rather than
  moving it to acquired.
- (14-15) After the recipe edit, ALL of this recipe's items
  (`flour` from the re-check, and `eggs` regardless of its needed
  state) are gone from the Groceries tab; `paper towels` (manual,
  no recipe link) survives.
- (16) Only rows with `recipe_id is null` remain.

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
