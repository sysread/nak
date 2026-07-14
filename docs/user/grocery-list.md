# Grocery list

The **Groceries** tab in the conversation drawer (right above
Recipes) is a shopping list built to be driven one-handed from your
phone in the store aisle. It has two surfaces:

- the **sidebar** lists every item you've ever added - your whole
  purchase history - with a search box and two filters (status:
  All / On list / Acquired; and section). Each row has a checkbox:
  checked means it's on the current shopping list, so restocking a
  past purchase is just "search it, check it". Searching a name
  you've never bought offers an **Add** action instead.
- the **main panel** shows the current shopping list itself, grouped
  by store section - that's where you add, edit, check things off,
  and manage sections.

The list fills two ways: ingredient checkboxes on bookmarked
recipes, and direct adds.

## Adding from a recipe

Open any recipe you've marked **upcoming** (the cart icon) or
**favorite** (the thumbs-up). Each ingredient row now carries a
checkbox. Checking one puts that ingredient on the grocery list with
its quantity carried over verbatim and a note naming the recipe;
unchecking it removes it again.

Two things to know:

- The checkbox means "this is on my list right now." Removing the
  item from the list (or checking it off during a shopping trip)
  unchecks it on the recipe too; re-checking it puts the same item
  back on the list.
- **Editing a recipe's ingredients clears that recipe's items from
  the grocery list.** Ingredients live inside the recipe text, so
  after an edit the app can't tell which list items still match -
  re-check the ones you still need. Bookmark toggles and rating
  changes don't do this; only changes to the recipe body.

## Adding directly

The **Add to list** input at the top of the main panel searches
everything you've bought before (by name) as you type. Pick a suggestion to put that
item back on the list - it keeps its section, note, and photo from
last time. If nothing matches, an "Add" action creates a fresh item.

## Shopping

The list renders one card per store section, in your order, with
**Other** always last - the section name is the card's title and
items stack one per row inside it. Every section shows up even when
it's empty, so the cards mirror your walk through the store. Every
item on the list shows a **checked** box - as you
put things in your cart, uncheck them. Unchecked items drop into the
greyed-out **Acquired** section at the bottom, which stays collapsed
until you open it (it keeps your whole purchase history, which is
also what powers the add-input suggestions). Re-check an acquired
item to put it back on the list.

Tap an item's name to edit it: name, count, unit, a free-form note,
its section, and an optional photo (handy for "this exact brand"
label shots). Delete lives in the same editor.

## Sections

Click **Sections** at the top of the main panel to manage your store
sections: add new ones, rename or delete (a deleted section's items
move to Other), and drag rows to match the order you walk the store.
**Other** is permanent - it's where anything without a section lands.
A fresh account starts with a canned set (Produce, Bread, Deli,
Meats, Dairy, Frozen, Snacks, Pantry, Beverages, Household); change
them freely.
