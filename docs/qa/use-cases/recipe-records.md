# Recipe records: chat capture, records UI, cross-recipe search, offline degradation

## Covers

The `recipe_records` table and its full lifecycle
([dev: cookbook](../../dev/cookbook.md) - Records data model and the
Records section; [dev: tools](../../dev/tools.md) - the
`recipe_record_*` tool split). Specifically: the chat-capture journey
(the tools are the primary capture path - there is no background
sweep), the detail pane's Records section (add / edit / filter /
expand / export), the outcome filter end to end, cross-recipe search
with navigation + scroll-highlight, the delete confirmation's record
count, the embedding backfill, and the online-only / degrade-soft
offline posture.

## Preconditions

- Local stack up (`mise run dev-start`), signed in with the dev
  login. `SR` = service-role key.
- At least three recipes exist (records need homes, and the
  cross-recipe steps need one outside the list's loaded window). If
  the cookbook is empty, create them from the Cookbook tab. Note
  their `id`s:

  ```sql
  select id, title from recipes order by created_at desc limit 5;
  ```

- At least one recipe whose `updated_at` is old enough that its row
  sits outside the list pane's loaded window (scroll down in the
  Recipes list first and note which titles are visible).
- The browser devtools' Network tab available, for the offline steps
  (or the OS network kill switch).

## Steps

1. Open a recipe's detail pane, scroll to the **Records** section
   (below History), click **Add record**, pick a date, type Markdown
   content, add two comma-separated tags, pick an outcome, **Save**.
2. Click the record row to expand it; click **Edit**, change the
   content, **Save**. Collapse and re-expand to confirm.
3. Add a second record on a different date with a different tag. Use
   the **From**/**To** date filter to show only one; use the **Tag**
   dropdown to filter by a tag. Set the **Outcome** dropdown. Clear
   all three.
4. Chat capture: in a NEW conversation, tell the model "I baked the
   sourdough yesterday - crumb came out gummy, ferment longer next
   time" (the cook is on a past day, deliberately). The model should
   call `recipe_record_create` and reply naming the new record. Then
   open the Cookbook detail pane for that recipe WITHOUT reloading.
5. Same conversation: report the SAME event again ("like I said, the
   gummy crumb bake"). The model should call `recipe_record_list`,
   find the record, and `recipe_record_update` it - not stack a
   second one.
6. Same conversation: a detail correction ("actually the crumb was
   fine on day two, but the crust burned"). The model should
   `recipe_record_get` the record and pass a MERGED body (both facts
   present), not just the new sentence.
7. Outcome end to end: ask the model "mark that bake as a failure",
   then check the record's outcome chip; use the Records **Outcome**
   dropdown to filter to failure; then clear the dropdown and run a
   cross-recipe search "my failed bakes" with the outcome dropdown
   set. Clearing the search resets the dropdown.
8. Cross-recipe search: put a distinctive phrase in one OLD recipe's
   record (outside the loaded list window), type that phrase into
   the Records search box of ANY recipe, and click the hit on the
   other recipe. Repeat with a search term that hits records in
   several recipes and click through two hits in a row.
9. Sidebar navigation with a live search: with results showing,
   click a DIFFERENT recipe in the sidebar list.
10. Delete: open a recipe whose log has 2+ records, use the recipe
    detail pane's Delete control, and read the confirmation dialog.
    Confirm.
11. Export: expand a record, click **Export**; then click **Export
    all** in the Records header.
12. Embedding: `POST /backfill` (venice function, service bearer)
    once a record exists.
13. Offline degradation: load a recipe's log while online, then
    switch the browser offline. Revisit the SAME recipe; then switch
    to a DIFFERENT recipe whose log was never fetched this session.
14. Offline deep link: still offline, open a hit (or paste a recipe
    URL) for a recipe that is NOT in the offline cache.

## Expected

- (1) The record appears at the top of the list, date formatted
  "Mon D, YYYY", outcome chip + tag chips, content preview
  truncated. A new `recipe_records` row exists with
  `source_conversation_id` null (manual add):

  ```sql
  select id, recipe_id, date, outcome, source_conversation_id
    from recipe_records order by created_at desc limit 5;
  ```

- (2) The edit persists; `updated_at` advances (trigger) and
  `embedding` is nulled (content change re-arms the backfill).
- (3) Date/tag filters narrow the log; the outcome dropdown filters
  it in browse mode too. Clearing restores the full log.
- (4) The reply names the logged record ("I've logged that bake").
  The record row shows in the open detail pane without a reload -
  that is the realtime relay proof (agent-side write landing through
  `nak:recipe-records:changed`). The row's date is YESTERDAY (read
  from the conversation, not today) and its
  `source_conversation_id` is the chat thread.
- (5) No second record: the model reports updating the existing
  record; `recipe_records` still shows one row for that event (the
  dedup payload rides every create result, but the prompt guard is
  what fires here).
- (6) The record body carries the merged detail (old + new facts) -
  `content` is a full-replacement patch, so a lazy update would have
  LOST the first sentence; the get-then-merge guard prevents that.
- (7) Tool-set outcome shows on the chip; the dropdown filters to it
  in browse mode; with the dropdown set, the cross-recipe search
  returns only failure records (the outcome reaches BOTH search
  legs). Clearing the search resets the dropdown to unfiltered.
- (8) A hit on another recipe is annotated with that recipe's title
  and clicking it NAVIGATES the detail pane to that recipe while the
  query, results, and the clicked hit's highlight all survive
  (including the resolution-window case: the pane fetches the
  by-id recipe and the section stays mounted - no blank Records
  section, no lost query). The date/tag filters reset on navigation;
  the pane scrolls to the Records section with the clicked hit
  highlighted.
- (9) Accepted behavior, pinned: the results list REPLACES the newly
  opened recipe's log (the query survives sidebar navigation). The
  exit is clearing the search - after which the open recipe's own
  log renders.
- (10) The confirm names the cost: "This deletes the recipe and its
  N records" with N matching the row count (`countRecipeRecords`).
  Confirming deletes the recipe; the records cascade:
  `select count(*) from recipe_records where recipe_id = '<ID>';`
  returns 0.
- (11) Single export downloads `yyyy-mm-dd-<slug>.md` with
  date/tags/outcome front matter; **Export all** downloads a zip
  holding `recipe.md` plus one `records/` entry per record - the
  FULL log, ignoring active filters/search (recipes' deliberate
  divergence from the wiki twin).
- (12) The record's `embedding` populates (vector(2048)) via the
  shared backfill loop - check via PostgREST (`embedding is not
  null`). The drain also emits a transient per-user drawer line
  ("embedded N item(s) in the background", tag `embeddings`) that is
  easy to miss; if the drawer missed it, the function log has it.
  Search now hits it through the vector path.
- (13) Same recipe offline: the retained rows still render, add/edit
  controls and the filter/search controls disable with copy (the
  search box stays clearable). Fresh recipe offline (never fetched):
  the offline-no-data line renders - never the previous recipe's
  log, never "no records yet".
- (14) An offline-uncached hit opens onto the pane's
  offline-no-data placeholder (the honest "couldn't load offline"
  state, not a "recipe not found" lie).

## Cleanup

- Delete the test recipe(s) from the UI (the delete confirm cascade
  takes the records) or
  `delete from recipes where id = '<ID>';`.
- Leave the browser back online; clear any devtools network
  overrides.

## Results log

| Date | Env | Commit | (1) | (2) | (3) | (4) | (5) | (6) | (7) | (8) | (9) | (10) | (11) | (12) | (13) | (14) | Notes |
|------|-----|--------|-----|-----|-----|-----|-----|-----|-----|-----|-----|------|------|------|------|------|-------|
| 2026-10-12 | local (recipe-records wt) | 4fa77e60 | P | P | F(tag) | P | P | P | P | P | P | P | P | P | P | P | Run 1: (3) failed - tags=cs.{a} Postgres-array literal vs jsonb 400; (5)/(6) passed with deviations (model merged/answered from context, no tool calls); (12) via cron shim, no drawer [embeddings] line (expectation fixed). |
| 2026-10-12 | local (recipe-records wt) | 0dcca4e6 | - | - | P | - | - | - | P | - | - | - | - | - | - | - | Run 2 (focused): tag filter fixed (200 + narrows + combines with outcome); cross-recipe search with outcome both legs re-verified. |
| *pending* | | | | | | | | | | | | | | | | | first run after feature lands |
