# Grocery chat tool: read, add, remove, update from a conversation

## Covers

The `grocery` combination tool
([dev: grocery list](../../dev/grocery-list.md), "The grocery chat
tool"; [dev: tools](../../dev/tools.md)): the chat model reading
and searching the list (op=list with the sections payload), batch
idempotent adds with revive-before-create and section filing
(op=add), un-planning without a purchase (op=remove), and item
edits including the entry-quantity gate and the recipe-linked
rename refusal (op=update). Also covers the realtime refresh of an
open Groceries tab on an edge-side write, and the no-purchase
boundary (there is deliberately no op that stamps `acquired_at`).

Needs a working Venice key (real completions): the model must
actually choose and call the tool.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user
  (`dev@nak.local`) in the browser the case drives.
- Venice key seeded: `app_config.venice_api_key` non-empty (see
  AGENTS.md "API keys in direnv" for the seed command).
- At least one section beyond the canned set is NOT required - the
  case reads the section names from the tool's own list result and
  uses one of those, so it works on any account.
- psql access to the local stack:
  `psql -h 127.0.0.1 -p 54322 -U postgres -d postgres`.

## Steps

1. Open the Groceries drawer tab and note the current list (may be
   empty). Keep the tab open for the whole case.
2. In a chat thread, ask: `What's on my grocery list right now?`
3. Ask: `Add 2 kg of flour to the list, and also add paper towels.`
   (Do not name a section.)
4. Look at the Groceries tab (no manual reload).
5. Ask: `Add flour to the list again.`
6. Ask: `Take paper towels off the list.`
7. Check the DB for paper towels' entries:

   ```sh
   psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
     "select p.name, e.acquired_at from grocery_products p
      left join grocery_list_entries e on e.product_id = p.id
      where p.user_id = (select id from auth.users where email = 'dev@nak.local')
        and p.name ilike 'paper towels' order by e.added_at desc;"
   ```

8. Ask: `Change the flour's quantity to 3 and its unit to kg.`
9. Ask: `What section is the flour in? Move it to <one of the
   section names the model reported in step 2 or the panel shows>.`
10. Ask: `Mark the flour as purchased - check it off the list.`
11. In the Groceries panel, tap the flour row (a real purchase),
    then ask: `What did I just buy?` or check the DB:

    ```sh
    psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
      "select p.name, e.acquired_at from grocery_products p
      join grocery_list_entries e on e.product_id = p.id
      where p.user_id = (select id from auth.users where email = 'dev@nak.local')
        and p.name ilike 'flour' and e.acquired_at is not null
      order by e.acquired_at desc limit 3;"
    ```

12. Ask: `Rename the paper towels to "kitchen roll".` (paper towels
    is standalone, so this should SUCCEED). Then, from any recipe
    with ingredients, ask: `Add the eggs from <that recipe> to my
    list`, wait for the reply, then ask:
    `Rename the eggs to "farm eggs".`

## Expected

- **2** - the transcript shows a `grocery` tool-call card with
  `**Op:** list` (expandable detail), and the reply names the
  on-list items (or says the list is empty) - not a guess from
  training data.
- **3** - a `grocery` add call carrying both items (the card's
  pretty view lists `- **flour** x 2 kg` style bullets); the reply
  reports both as added/created. Both land on the list. Sections:
  the prompt names none, so the model may either leave both
  unfiled (Other/intake card) or file them into sections it knows
  from the step-2 result - BOTH are spec-legal (the model is the
  classifier for chat adds); if sections were passed, they must be
  existing ones and the reply must say where each item landed.
- **4** - the tab shows both new items WITHOUT a manual reload
  (the realtime relay fired `nak:grocery:changed`).
- **5** - the tool reports flour as already on the list; the panel
  still shows exactly one flour row (idempotent, no duplicate
  product).
- **6** - paper towels leaves the list; the product row survives
  (findable later in the sidebar's all-items browse or Acquired
  history search).
- **7** - every `grocery_list_entries` row for paper towels has
  `acquired_at` NULL (an un-plan deletes the open entry; nothing
  fake entered the purchase history).
- **8** - the tool updates the entry; the panel row now shows
  `3 kg`.
- **9** - the tool files the flour; the panel moves the row into
  the named section's card on the next relay refresh.
- **10** - CRITICAL: no op stamps a purchase. Either the model
  explains that checking off is the user's own tap (the toolbox
  description teaches this), or it attempts a workaround the tool
  refuses - either way the DB check in step 11's shape shows NO
  new `acquired_at` for flour before the manual tap.
- **11** - exactly ONE `acquired_at` stamp for flour, from the
  manual tap (timestamp ~= now); the In-cart / Acquired surface
  shows it.
- **12** - the standalone rename succeeds (row renamed in the
  panel); the recipe-linked rename is REFUSED with the trade named
  (recipe checkbox + cleanup depend on the name), and the eggs row
  keeps its name.

## Cleanup

```sh
psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
  "delete from grocery_products where user_id = (select id from auth.users where email = 'dev@nak.local')
     and name ilike any (array['flour','paper towels','kitchen roll','eggs']);"
```

(The cascade removes their entries; recipe-linked eggs rows are
covered by the name filter. If the test recipe's other products
were touched, they were created by this case too - same delete.)

## Results

Append-only. Every row: date, environment, commit, deviations.

| Date | Environment | Commit | Result |
| --- | --- | --- | --- |
| 2026-11-12 | local stack (Vite [::1]:5173, dev@nak.local, real completions) | grocery-tool b4d9f19b (+ docs) | 12/12 PASS. Step 3 deviation: the model filed both items into sections unprompted (Pantry / Household - existing sections, reported in the reply), spec-legal model-chosen filing per the updated expected text. Step 10: the model refused the purchase request unprompted with the boundary reasoning; DB confirmed no `acquired_at` before the manual tap. Step 12: recipe-linked rename refused with the trade named; standalone rename succeeded. DB checks ran as PostgREST through the signed-in session (sandbox had no psql) - same joins and filters. Cleanup left zero rows. |
