# Cookbook: cooking mode (Make this now)

## Covers

The cooking-mode session on the recipe detail pane
([dev: cookbook](../../dev/cookbook.md), "Cooking mode"; session map
in [`../../dev/grocery-list.md`](../../dev/grocery-list.md) and
[`../../dev/settings.md`](../../dev/settings.md)): the
Make-this-now/Done-cooking toggle, checkbox-taps-become-used-marks,
the N-of-M counter, the hidden add-all button, per-recipe sessions
(main + side at once), persistence across reload, expiry at
midnight / after 6 hours, the read-side legacy migration of the
shopping trip onto the same settings map, and that the grocery
bridge is untouched while cooking and fully intact after.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user
  (auto-login seam).
- Recipe `Cooking Mode QA` with body:

  ```text
  # Soup
  @eggs{3}
  @flour{200%g}
  @milk{1%cup}

  Whisk @eggs with @flour.
  > Rest 10 minutes.
  ```

- Clean session map (`settings - 'activeSessions'` via
  `mise run dev-sql`) so the first toggle starts fresh.

## Steps

1. Open the recipe's detail pane. Note the row above the rendered
   body: **Add all to grocery list** + **Make this now**.
2. Click **Make this now**.
3. Click the `eggs` checkbox.
4. Reload the page (same deep link).
5. Create a second recipe `Cooking Mode QA Side`
   (`@butter{2%tbsp}` + `@garlic{2 cloves}`), click **Make this
   now** on it, check `garlic`.
6. Navigate back to the first recipe.
7. Check the DB:

   ```sh
   mise run dev-sql "select key, value->>'used' from profiles, jsonb_each(settings->'activeSessions') as t(key,value) order by key"
   ```

8. Back on the side recipe: uncheck `garlic`, then click **Done
   cooking**.
9. With cooking OFF, click the `butter` checkbox, watch the Groceries
   tab rows, then uncheck it.
10. Check grocery rows:

    ```sh
    mise run dev-sql "select p.name, p.recipe_id, (e.acquired_at is null) as open_entry from grocery_products p left join grocery_list_entries e on e.product_id = p.id and e.acquired_at is null"
    ```

11. On the Groceries tab, click **Start shopping**; uncheck a list
    row and confirm it lands in **In cart**; click **Finish
    shopping**. Re-run step 7's query.
12. Simulate a pre-migration blob and reload the Groceries tab:

    ```sh
    mise run dev-sql "update profiles set settings = settings || jsonb_build_object('groceryShoppingStartedAt', to_jsonb(now()::text))"
    ```

    Then click **Finish shopping** again and re-check
    `settings ? 'groceryShoppingStartedAt'`.
13. Force the cooking session stale and reload the recipe:

    ```sh
    mise run dev-sql "update profiles set settings = jsonb_set(settings, '{activeSessions,cooking:<recipe-id>,startedAt}', to_jsonb((now() - interval '7 hours')::text))"
    ```

14. Consistency: cooking mode ON, tap `eggs`, `flour`, `milk` in
    quick succession (under a second apart). Watch all three rows
    and the counter.
15. Navigate away and back mid-cook. Re-check the three rows.
16. Consistency: cooking OFF, list empty. Double-click the `eggs`
    checkbox fast (two clicks under ~300 ms). Check the grocery
    rows with step 10's query.
17. Consistency: clean the list (step-10 query to verify), tap
    `flour`, then IMMEDIATELY click **Add all to grocery list**.
    Check the rows for duplicates.
18. Consistency: clean the list, click **Add all**, and while its
    writes run tap the `eggs` checkbox. Check the rows.
19. Consistency: with the list empty, tap `eggs` (bridge mode) and
    immediately open the OTHER recipe and switch back. Check the
    eggs box state and that no foreign items rendered.
20. Consistency: cooking mode ON, browser offline, tap `eggs`;
    wait out the request bound; back online, tap again. (The mark's
    optimistic flip may strand until the retry - note which.)
21. Consistency: cooking OFF, browser offline, tap `eggs`; wait;
    back online, tap again. Watch the box revert and the spinner.

## Expected

- (1) Both buttons render; three ingredient rows with grocery
  checkboxes.
- (2) Toggle flips to **Done cooking** (accent border), a
  "0 of 3 used" counter appears, **Add all to grocery list** HIDES,
  and the checkboxes' aria labels become "Mark <name> as used".
- (3) Counter reads "1 of 3 used"; the `eggs` row gains a
  strikethrough (`.cook-used`); the DB gains
  `activeSessions['cooking:<id>'].used = ["eggs"]` and gains NO
  grocery rows for the recipe.
- (4) Cooking is STILL active after reload: "1 of 3 used", `eggs`
  still checked. (This is the point of settings over
  sessionStorage - a PWA eviction mid-cook must not lose marks.)
- (5-7) Both sessions coexist in the map, one key per recipe, each
  with its own used list. Switching recipes restores each pane's own
  progress.
- (8) Unchecking clears the mark ("0 of 2 used"); Done cooking
  removes the `cooking:<side-id>` map entry entirely and restores
  "Make this now" + "Add all to grocery list".
- (9-10) Normal-mode checking creates a `grocery_products` row
  (recipe-linked) with an OPEN entry; unchecking deletes the open
  entry, no purchase stamp. The grocery bridge is fully intact.
- (11) Start shopping writes the `shopping` key alongside the
  cooking session (the map write must not clobber it); the unchecked
  row moves to **In cart**; Finish shopping stamps the purchase and
  removes the `shopping` key.
- (12) The legacy `groceryShoppingStartedAt` field reads as an
  ACTIVE trip (migration seed on read); finishing shopping clears
  BOTH the legacy key and the map entry.
- (13) A session older than 6 hours reads inactive on reload:
  toggle back to "Make this now", counter gone, aria labels back to
  the grocery verb, Add-all visible.
- (13) A session older than 6 hours reads inactive on reload:
  toggle back to "Make this now", counter gone, aria labels back to
  the grocery verb, Add-all visible.
- (14) Rapid cooking marks (three taps under a second apart): all
  three rows end checked, counter 3 of 3. Pre-consistency baseline:
  the first mark(s) could be silently unchecked by the last write.
- (15) Navigate away and back mid-cook: all marks still checked.
- (16) Bridge double-tap (two clicks under ~300 ms): exactly one
  eggs product on the list. Baseline: two products, each with an
  open entry.
- (17) Single-tap flour then Add all immediately: every ingredient
  exactly once, no duplicate flour. Baseline: duplicate flour
  possible when the batch probe races the tap's write.
- (18) Add all, then tap eggs mid-batch: the tap is ignored
  (spinner/disabled) and no duplicate eggs appears. Baseline: a
  duplicate was possible.
- (19) Tap eggs (bridge mode) then immediately switch recipe and
  back: eggs reads its server truth; no items from recipe A render
  under recipe B.
- (20) Cooking mode, browser offline, tap a checkbox: the row
  reverts (or the error line shows) inside the request bound, never
  stuck checked; back online, the tap lands.
- (21) Bridge mode, offline, tap a checkbox: the box reverts to
  unchecked inside the bound; online, the tap lands. Baseline: the
  revert could stick or the spinner could hang on a hung request.

## Cleanup

```sh
mise run dev-sql "delete from grocery_products; delete from recipes where title like 'Cooking Mode QA%'; update profiles set settings = settings - 'activeSessions'"
```

Then stop the stack (`Ctrl-C` / SIGTERM to the dev-start process).

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-08-29 | local stack | 0acaf4ca | PASS | All steps as expected. Note: step 13's expiry is read-side only (the stale map entry persists until the next session-map write prunes it) - observed behavior matches the design. |
| 2026-11-17 | local stack | 75262865 (pre-change baseline) | FAIL (as designed) | Steps 14 + 17 reproduced the races: flour's mark silently vanished under rapid taps (counter 2 of 3, row unchecked and stable); Add-all racing a single tap left TWO eggs products (SQL-confirmed: eggs x2, flour x2 rows). Steps 16 (fast double-tap) and 18 (revert race) did not reproduce under one attempt each - timing-dependent, as expected. Steps 1-6, 8-9, 15, 19, 20, 21 PASS. |
| 2026-11-18 | local stack | 28b96465 (post-change) | PASS (after one fix) | Steps 1-6, 8-9, 14-17, 19-21 PASS. Step 14: three taps in 47 ms, all landed, counter optimistic. Step 18 FAILED on the first post-change run and the failure was REAL: an instrumented same-tick probe (add-all click + eggs tap dispatched back-to-back) double-created eggs - the pending guard read a separate controller's internal set that never learned about batch registrations. Fixed (guard reads the same reactive set the batch registers into, synchronously in the click's tick); re-probed: same-tick tap refused, exactly one product per ingredient. Two false symptoms documented along the way: a failed HMR hot update left a poisoned module whose batch handler threw ReferenceError (phantom "batch loses all writes" - a clean page load does not reproduce), and the Groceries tab's default recipe-ingredients filter hides rows (an empty-looking list with items present). |
