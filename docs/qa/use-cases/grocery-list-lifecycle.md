# Grocery list: recipe bridge, shopping flow, sections, photos

## Covers

The Groceries tab end to end
([dev: grocery list](../../dev/grocery-list.md)): the ingredient
checkboxes on recipes and the name-aware recipe-edit invalidation
trigger ([dev: cookbook](../../dev/cookbook.md)), the main panel's
on-list / acquired shopping flow with the collapsed history, the
add-input's catalog suggestions, section management (add /
rename / delete / drag reorder), the item photo path
([dev: file storage](../../dev/file-storage.md)), the sidebar's
all-items browse (search + status/section filters + checkbox
toggles), and the realtime relay between the Cookbook pane and an
open Groceries tab.

Data-model note: a row on either surface is a durable
`grocery_products` variant; being "on the list" is an open
`grocery_list_entries` row, and each purchase closes one. The
panel's uncheck records a purchase; the sidebar's and the recipe
view's uncheck un-plan (no purchase). Product rows - and their
learned sections - survive all of it.

Layout note: the SIDEBAR (drawer) is the all-items browse over the
full catalog; the MAIN PANEL is the current shopping list. Steps
below name which surface they mean.

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
6. In the main panel, tap the pencil at the right edge of the
   `eggs` row, set its section to **Dairy** in the editor, and
   Save. Then tap the `flour` row's TEXT and tap it again.
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
15. Re-check `flour`, then edit the recipe (pencil) TWICE: first
    change `3` eggs to `4` and save; then rename `@flour{200%g}` to
    `@bread flour{200%g}` and save again.
16. Return to the Groceries tab.
17. In the DB, confirm the trigger's name matching:

    ```sh
    mise run dev-sql "select p.name, p.recipe_id, e.acquired_at from grocery_products p left join grocery_list_entries e on e.product_id = p.id order by p.created_at, e.added_at"
    ```

18. On the recipe, click **Add all to grocery list**, then tap the
    `salt` ingredient's TEXT (not the box).
19. In the main panel, file `eggs` into `Bakery` via the editor,
    then uncheck `eggs` on the recipe (deleting the row), then
    re-check it.
20. In the main panel, drag the `salt` row's handle onto the
    `Bakery` card. Then open **Sections** and drag `Pharmacy` over
    another row, watching the row edges before dropping.
21. Back in the list, tick **Show empty sections** and drag the
    `Bakery` CARD by the handle in its title bar to another spot;
    untick the toggle and look at the title bars again.
22. Look at the **In cart** section, then click **Start shopping**
    and uncheck `salt` from the list. Re-check `salt` in the cart,
    uncheck it again, then click **Finish shopping**. Set
    `groceryShoppingStartedAt` to yesterday and reload to check the
    midnight expiry:

    ```sh
    mise run dev-sql "update profiles set settings = settings || jsonb_build_object('groceryShoppingStartedAt', to_jsonb((now() - interval '1 day')::text))"
    ```

23. Edit `paper towels` (pencil) and give it a deliberately long
    name - `extra absorbent select-a-size paper towels 12 mega
    rolls` - a count of `2`, a unit of `packs`, and a long note
    (`the bulk pack from the back aisle, not the shelf ones`).
    Save, then read the row in the main panel AND in the sidebar
    drawer, at desktop width and at a phone-narrow viewport. Repeat
    with a name containing no spaces at all
    (`extraabsorbentselectasizepapertowels12megarolls`).

## Expected

- (1) The main panel shows the "Nothing on the list" hint and NO
  section cards (empty cards are hidden by default). Ticking **Show
  empty sections** reveals one empty card per section - **Other**
  first, then the canned starters in order (Produce, Bread, Deli,
  Meats, Dairy, Frozen, Snacks, Pantry, Beverages, Household), each
  showing "No items".
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
  Tapping the `flour` row's text toggles its checkbox (acquired,
  then back) rather than opening the editor - only the pencil opens
  the editor.
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
  only previously-bought off-list rows (muted). Unchecking `eggs`
  in the sidebar drops it from the main panel's list WITHOUT adding
  a new purchase to the Acquired history (the sidebar un-plans, it
  never "buys"); re-checking restores it, section intact.
- (14) Unchecking `flour` on the recipe removes it from the main
  panel's list (open in another window to watch the realtime
  refresh), but its product survives: the sidebar (with recipe
  ingredients shown) still lists `flour`, unchecked. A recipe-side
  uncheck un-plans; it does not forget the ingredient.
- (15-16) The amount-only edit (3 -> 4 eggs) removes NOTHING -
  quantity is not part of identity. The rename edit drops `flour`
  (its name no longer parses from the source) from both surfaces
  while `eggs` keeps its row AND its section; `paper towels`
  (standalone, no recipe link) is never touched.
- (17) `flour` has no `grocery_products` row; `eggs` still has one
  (with its entry history); `paper towels` remains with
  `recipe_id is null`.
- (18) Add-all puts every ingredient on the list (checkboxes all
  checked; `bread flour` is a NEW product - the rename dropped old
  `flour`); tapping the `salt` TEXT unchecks it - the whole row is
  the toggle target.
- (19) The re-checked `eggs` lands directly under **Bakery** - the
  product row survived the uncheck, so its section came back with
  it.
- (20) While dragging `salt`, the hovered card shows an accent
  outline + tinted title; dropping files `salt` into Bakery (and
  sticks for future adds). In the section manager, an accent
  insertion line rides the hovered row's top or bottom edge
  matching where the dragged section will land. On a touch device,
  both drags activate by holding the handle ~1s (haptic tick where
  supported), then sliding and releasing - with the same visuals.
- (21) With empty sections shown, each real section card (not
  Other) carries a title-bar drag handle; dragging shows an accent
  line on the landing edge and the drop persists the new order
  (verify in the Sections manager). Titles are left-aligned with
  the handle inline before the text. Unticking the toggle removes
  the handles - card reorder is only available in full-layout mode.
  In light mode + terminal style, the card titles and other muted
  grocery text read clearly against the beige title bar (the muted
  tone follows the theme, not a hardcoded grey).

- (22) Idle: the In-cart section shows the explainer message and no
  items. After **Start shopping**, unchecking `salt` moves it into
  In cart (not the Acquired history); re-checking returns it to the
  list. After **Finish shopping** the cart empties back to the
  explainer and `salt` shows under Acquired. With the trip
  timestamp forced to yesterday, a reload shows the trip inactive -
  it expired at midnight without any explicit finish.
- (23) On BOTH surfaces the full name is visible: it wraps onto as
  many lines as it needs, with no ellipsis and nothing else sharing
  its line. Directly beneath it, one muted block reads
  `2 packs . the bulk pack from the back aisle, not the shelf ones`
  (middle dots between parts), also wrapping in full. Neither line
  is clipped at phone-narrow width, and the space-free name breaks
  mid-word rather than pushing the row wider than its card or the
  drawer. A recipe-sourced row whose note is exactly
  `For <recipe title>` shows that note ONCE, without the recipe
  title repeated after it.

## Cleanup

Delete the leftover manual items from the Groceries tab (editor ->
Delete), un-bookmark the test recipe, and optionally reset sections:

```sh
mise run dev-sql "delete from grocery_products; delete from grocery_sections"
```

(Entries cascade with their products.)

(The canned set re-seeds on the next Groceries-tab load.)

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
