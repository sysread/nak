# Wiki: browse, edit, and per-article agent updates

## Covers

Wiki article CRUD and search ([dev: wiki](../../dev/wiki.md)) and the
per-article `Ask agent to update` workflow ([dev: wiki](../../dev/wiki.md)).

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user.
- The `Wiki` tab is enabled and reachable.
- If no safe test article exists, prepare one title to use for this case:
  `QA Wiki Article`.

## Steps

1. Open the `Wiki` tab with no article selected.
2. Click `+ New article`.
3. Create `QA Wiki Article` with a short Markdown body and a change
   message `create qa article`.
4. Search for `QA Wiki Article`, open it, then click `Edit`.
5. Change the body, try to save without a change message, then add
   `edit qa article` and save.
6. Try to create another article with the exact same title.
7. In `QA Wiki Article`, click `Ask agent to update`, enter a precise
   instruction that adds one clearly verifiable sentence, and run it.
8. In the preview state, click `Try again`, then run a second preview and
   click `Cancel`.
9. Run `Ask agent to update` once more, wait for the preview, and click
   `Accept`.
10. In the article's `Records` section, click the `+` to add a record
    dated today with content `QA baseline record`, and save.
11. Click `Ask agent to update` and instruct it to `log a record dated
    today: "QA agent-logged event"` (no body change). Wait for the
    preview.
12. Confirm the preview shows an `Add record` row and a "body is
    unchanged" note, then click `Accept`. Confirm the new record appears
    in the Records section.
13. Click `Ask agent to update` and instruct it to `delete the record
    that says "QA baseline record"`. Confirm the preview shows a
    `Delete record` row, then click `Accept` and confirm that record is
    gone from the Records section.
14. Open the article's `Delete` flow, enter `qa cleanup`, then click
    `Cancel`.
15. Re-open `Delete`, enter `qa cleanup`, and confirm the delete.

## Expected

- (1) With no article selected, the main panel shows the Wiki empty-state
  hint and its inline create affordance.
- (2-3) `+ New article` opens the inline form; save requires a change
  message and persists the new article into the drawer list.
- (4-5) Search finds the article, `Edit` flips to the form, save is
  blocked without a change message, and a successful save returns to the
  rendered view with the updated body.
- (6) Duplicate title creation fails with a clear title-uniqueness error;
  the original article remains intact.
- (7-9) `Ask agent to update` produces a preview state instead of writing
  immediately; `Try again` requests another preview, `Cancel` leaves the
  stored article unchanged, and `Accept` replaces the article body with the
  previewed update.
- (10-13) The agent can also propose record changes: a records-only request
  previews an `Add record` (or `Edit`/`Delete record`) row with a
  body-unchanged note and writes no body changelog row; `Accept` applies the
  record change and the Records section refreshes to match. The agent only
  acts on records it was shown - a delete/edit targets the named existing
  record, and a hallucinated record id never reaches the preview.
- (14-15) Delete uses an inline confirmation strip; `Cancel` dismisses it,
  and the confirmed delete removes the article from the drawer while
  leaving the app usable.

## Cleanup

- If `QA Wiki Article` still exists, delete it from the Wiki tab.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
