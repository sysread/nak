# Grocery list: recipe bridge, shopping flow, sections, photos

## Covers

The Groceries tab end to end
([dev: grocery list](../../dev/grocery-list.md)): the ingredient
checkboxes on recipes and the name-aware recipe-edit invalidation
trigger ([dev: cookbook](../../dev/cookbook.md)), the main panel's
on-list / acquired shopping flow with the collapsed history, the
add-input's catalog suggestions and (Other)/(Auto) create pair,
LLM auto-sectioning on both surfaces (steps 24-26; needs a Venice
key), section management (add / rename / delete / drag reorder),
the item photo path
([dev: file storage](../../dev/file-storage.md)), the sidebar's
all-items browse (search + status/section filters + checkbox
toggles), and the realtime relay between the Cookbook pane and an
open Groceries tab.

Data-model note: a row on either surface is a durable
`grocery_products` variant; being "on the list" is an open
`grocery_list_entries` row, and each purchase closes one. The
panel's row tap records a purchase; the sidebar's and the recipe
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
   Save. Then tap the `flour` row anywhere outside the pencil
   (name, padding, check slot), expand the **Acquired** disclosure
   at the bottom, and tap the `flour` row there to revive it.
7. In the main panel, tap the `eggs` row (simulate buying it) -
   it should leave the list immediately, with a spinner where its
   check mark was - then expand the **Acquired** disclosure at the
   bottom.
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
20. In the main panel, put `salt` back on the list (its recipe
    checkbox), then press and hold the `salt` ROW for about a
    second - it should visibly lift (accent ring, raised shadow,
    background change) - slide onto the `Bakery` card and release.
    With a mouse, drag the row onto the card directly. Then open
    **Sections** and drag `Pharmacy` over another row, watching the
    row edges before dropping.
21. Back in the list, tick **Show empty sections** and drag the
    `Bakery` CARD by the handle in its title bar to another spot;
    untick the toggle and look at the title bars again.
22. Look at the **In cart** section, then click **Start shopping**
    and tap the `salt` row from the list - it should drop into
    **In cart** immediately, with a spinner in its check slot until
    the save lands. Tap the `salt` row in the cart to put it back
    on the list, then tap it off again, then click **Finish
    shopping**. Set
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
24. In the main panel's add input, type `frozen waffles` (a name
    not in the catalog) and look at the dropdown. Click
    **Add "frozen waffles" (Auto)** and watch the list for a few
    seconds.
25. Type `frozen waffles` again and look at the dropdown. Click
    **Add "frozen waffles" (Other)**, then check the DB:

    ```sh
    mise run dev-sql "select name, section_id, section_source from grocery_products where name ilike 'frozen%'"
    ```

26. Create a recipe `Corn Chowder QA` with body
    `Simmer @corn{1%can} with @heavy cream{1%cup}.`, check the
    `corn` checkbox, and watch it while the section is decided.
    Then, in the main panel, drag the `heavy cream` row (still
    classifying or already filed) into a section of your choice and
    re-check the DB's `section_source` for both rows.
27. With a shopping trip active and at least two items still on
    the list, mark two items off back-to-back - tap one, then the
    other within a second or two. On real store wifi the timing
    window appears naturally; an agent run can force the worst
    case deterministically by holding the FIRST list reload that
    follows the first tap for ~700ms before letting its response
    through, so it lands after the second tap's reload (a stale
    snapshot arriving last).
28. While a check-off is still saving, tap the same row again.
29. Tap an item row on its photo thumbnail, then on the row's
    padding under the name - not the checkbox, not the name text,
    not the pencil.
30. Press and hold an aisle item anywhere on the ROW (not the
    grip) for about a second, then slide onto another section
    card and release. Repeat the same gesture starting from an
    In-cart row. Then press-and-hold and release in place, and
    immediately tap any row afterward.
31. Swipe to scroll the list starting from an item row; then
    press-and-hold an item and turn the hold into a scroll.
32. (agent run) While an item is lifted mid-drag, force a grocery
    reload (toggle another item from a second tab or the DB
    console); complete the drag.

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
  Tapping the `flour` row anywhere outside the pencil purchases it
  (it leaves the card instantly, spinner in its check slot), and
  tapping it in the expanded Acquired list revives it - only the
  pencil opens the editor.
- (7) `eggs` leaves the list the moment it is tapped and the
  greyed **Acquired (1)** disclosure counts it (collapsed until
  clicked; name shown struck through). On the recipe, the `eggs`
  checkbox is now UNCHECKED - the box mirrors "on the list right
  now". (Steps 8-9 revive the same row via the add-input; checking
  the recipe box again would revive it identically.)
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
- (20) Pressing and holding the `salt` row anywhere lifts it
  (accent ring, raised shadow, elevated background - NOT the old
  dimming); the hovered card shows an accent outline + tinted
  title; dropping files `salt` into Bakery (and sticks for future
  adds), and the lift never toggles the row. A mouse drag from
  anywhere on the row files identically. In the section manager, an
  accent insertion line rides the hovered row's top or bottom edge
  matching where the dragged section will land. On a touch device,
  the section drags activate by holding ~1s (haptic tick where
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
  items. After **Start shopping**, tapping `salt` moves it into
  In cart (not the Acquired history) the moment it is tapped, with
  the spinner until the save lands; tapping it there returns it to
  the list. After **Finish shopping** the cart empties back to the
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
- (24) The dropdown leads with BOTH create actions - (Other) and
  (Auto) - since the name matches nothing. After clicking (Auto),
  `frozen waffles` appears under **Other** immediately with a small
  spinning ring beside its name (also visible on the sidebar's row
  while the drawer is open), then hops into a sensible section
  (Frozen, with the canned starters) within a few seconds and the
  ring disappears. If the model declines or errors, the ring still
  stops and the item simply stays in Other - either way the add
  itself never blocks.
- (25) With a matching product now in the catalog, the dropdown
  shows the `frozen waffles` suggestion (section name in grey at
  the row's right edge) and ONLY the (Other) create action - (Auto)
  hides on a matched name. Clicking (Other) creates a SECOND
  variant that lands in Other and stays there (no model call). The
  DB shows two rows: one with `section_source = 'auto'` (step 24)
  and one unfiled (`section_id` and `section_source` null).
- (26) While the section is being decided, the `corn` checkbox
  renders as a small spinner and ignores clicks; when it settles,
  `corn` sits in a canned-goods-appropriate section (the recipe
  context - `1%can` - is what steers it away from Produce/Frozen;
  exact section depends on your section names). Dragging
  `heavy cream` to a section of your choice stamps
  `section_source = 'user'` for it, and that filing is never
  overwritten even if the classifier answers afterwards; `corn`
  reads `'auto'` (or null if the model declined).
- (27) Both rows leave their cards the moment they are tapped,
  each showing a small spinner in its check slot while the save
  is in flight; both land in In cart (or the collapsed Acquired
  history, without a trip) and STAY after every reload settles.
  Neither row ever returns to its aisle card as if never tapped,
  and no second tap is needed. Added by the shopping-gestures
  change; the pre-change baseline logged the failure (the second
  row returning to its aisle card when the stale reload lands
  last).
- (28) The mid-save tap is ignored: no opposite write is queued,
  and no extra purchase row appears in the acquired history or
  the DB (the open entry is stamped at most once).
- (29) Every tap on the row - photo, padding, name - toggles the
  item. Only the pencil button and the lift gesture do not.
- (30) The held row visibly lifts: accent border, raised shadow,
  background shift, full opacity (haptic tick on a phone); the
  hovered card highlights; release files the item into that
  section without toggling it. The same gesture from an In-cart
  row re-files it the same way. A hold released in place does
  nothing, AND the very next tap still toggles - the click
  suppression cannot outlive its touch gesture.
- (31) Scrolling never toggles or lifts; a hold that turns into
  a scroll cancels the lift. (The touch paths need a real device
  or touch emulation; the mouse run covers the pointer path.)
- (32) The drag completes or safely no-ops; no stuck lifted
  styling; the list is consistent after the next reload.

## Cleanup

Delete the leftover manual items from the Groceries tab (editor ->
Delete), delete the `Corn Chowder QA` recipe, un-bookmark the test
recipe, and optionally reset sections:

```sh
mise run dev-sql "delete from grocery_products; delete from grocery_sections"
```

(Entries cascade with their products.)

(The canned set re-seeds on the next Groceries-tab load.)

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-08-29 | local stack | 0acaf4ca | PARTIAL (step 22) | Regression pass limited to the shopping-trip step (22) after the trip moved onto the shared `activeSessions` map (cooking-mode change): Start/Finish through the map, In-cart purchase stamp, midnight expiry, and the legacy `groceryShoppingStartedAt` read-side migration all verified; the legacy field is cleared on the next trip write. Steps 1-21, 23-26 not re-executed this run - untouched surfaces (checkbox bridge itself exercised via cooking-mode QA + step 9 of cookbook-cooking-mode). |
| 2026-11-11 | local stack | c3976ee0 | PARTIAL (M0 baseline, shopping-gestures) | Baseline for the shopping-gestures change (branch grocery-shopping-gestures; app code unchanged from main c3976ee0, only plan/use-case docs ride the branch). Steps 1-7 PASS - auto-sectioning had already filed eggs to Dairy and flour to Pantry before the step-6 manual filing (existing behavior), and step 6's "tap it again" was completed from the expanded Acquired row because the purchased row is otherwise invisible (doc wording gap; the M4 reword covers it). Step 12 partial: Bread renamed to Bakery only. Step 18 partial: Add-all run, the salt-text tap skipped so salt stayed on the list for step 20. Step 20 PASS: salt filed into Bakery via the grip drag (the drop-target accent highlight was not visually asserted, only the filing result). Step 22 PASS: full trip cycle - start, purchase into In cart, cart-row revival, uncheck again, finish back to idle. Step 27 REPRODUCED THE BUG: with the first on-list reload held ~700ms (route-fulfill delay; its snapshot was read before the second write committed), both taps looked correct in In cart at +400ms, then the stale reload resolved last and flour RETURNED to the Pantry aisle card rendered checked/on-list - while the DB shows the flour purchase stamped at 17:39:05.521Z. Evidence screenshot parked untracked at .playwright-mcp/gsg-m0-race-after.png. Steps 29/30 pre-change absence confirmed: a click on the row padding is a dead zone (no toggle), and a 1.2s hold on the row body never lifts (no lifted class, no toggle). Steps 8-11, 13-17, 19, 21, 23-26, 28, 31, 32 not run this pass. |
| 2026-11-11 | local stack | 150e7120 | PASS (M4 post-change, shopping-gestures) | Post-change pass on the implemented branch (agent-driven Playwright, same route-hold technique as the baseline row above). Steps 6-7 PASS under the reworded wording: a click on the row PADDING (the baseline's dead zone) purchases immediately; revival from the expanded Acquired row works. Step 18 partial (Add-all; salt-text tap skipped as before). Step 20 PASS on BOTH paths: the touch long-press lift from the row shows the full lift styling (accent ring rgb(207,112,66) + 0 6px 16px shadow + z-promotion + full opacity on --bg-2 - verified via computed styles, plus .playwright-mcp/gsg-m4-light-lift.png) and files the item (salt Pantry to Bakery to Dairy across two lifts); a mouse drag from the row files identically (flour Other to Bakery). Step 22 PASS: purchase lands in In cart the moment it is tapped with the busy spinner visibly turning in the check slot while the write is held ~700ms (route delay), cart-row revival works, tap-off-again works, Finish returns the cart to idle. Step 27 PASS - THE RACE IS DEAD: with the identical stale-reload interleaving that un-did flour in the baseline (first on-list GET held 700ms, snapshot predating the second write, resolving last), BOTH writes survive - flour stays in In cart and the concurrent revival stands, because the generation guard discards the superseded load's results. Step 28 PASS: a re-tap during a held write is ignored and the DB shows exactly one purchase stamp (eggs: 2 purchases for exactly 2 real taps). Step 29 PASS: padding/name/check-slot taps all toggle; only the pencil is exempt. Step 30 PASS with one observed nuance: lift styling + drop + in-place cancel all work, and the next TOUCH tap toggles (the touchstart disarm); a MOUSE click immediately after a touch lift is swallowed once - the documented hybrid-device edge from the plan's matrix, observed live in automation (a real phone's next interaction is a touch, which disarms). Title-bar radii verified via computed styles in soft (6px 6px 0 0 matching the card) and terminal (0px by design) styles; the Help modal renders the updated user doc (lift + spinner copy confirmed by click-through). QA FOUND AND FIXED TWO REAL BUGS: (1) commit 4bdbf1b3 - Svelte 5's event delegation made the row's touch listeners passive by default, so the lift's preventDefault calls were silently ignored ("Unable to preventDefault inside passive event listener" console errors) - fixed with a non-passive action; the latent half predates this change (the old grip path had the same problem). (2) commit de42b96f - the QA cleanup's external wipe of the sections table exposed a pre-existing positive-feedback reload storm in the seed path (each realtime echo triggers a reload; each reload observing zero sections re-seeded; 201 batches / 2010 rows until the connection pool died) - fixed with a non-reentrant seed guard plus a regression test, and re-verified live (a fresh seed converges to exactly 10 sections with zero failing requests). Steps 8-11, 13-17, 19, 21 full, 23-26, 31 (real-device scroll), 32 (mid-drag reload) not run this pass; real-device touch verification (haptics, scroll interplay) remains for a phone. |
