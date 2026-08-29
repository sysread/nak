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

## Cleanup

```sh
mise run dev-sql "delete from grocery_products; delete from recipes where title like 'Cooking Mode QA%'; update profiles set settings = settings - 'activeSessions'"
```

Then stop the stack (`Ctrl-C` / SIGTERM to the dev-start process).

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-08-29 | local stack | 0acaf4ca | PASS | All steps as expected. Note: step 13's expiry is read-side only (the stale map entry persists until the next session-map write prunes it) - observed behavior matches the design. |
