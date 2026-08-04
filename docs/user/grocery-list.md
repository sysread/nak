# Grocery list

The **Groceries** tab in the conversation drawer (right above
Recipes) is a shopping list built to be driven one-handed from your
phone in the store aisle. It has two surfaces:

- the **sidebar** lists every item you've ever added - your whole
  purchase history, alphabetically - with a search box and two
  filters (status:
  All / On list / Acquired; and section). Items you added yourself
  appear first under **Staples**; items that came from recipe
  checkboxes live under **Ingredients**, hidden until you tick
  **Show recipe ingredients**. Each row has a checkbox:
  checked means it's on the current shopping list, so restocking a
  past purchase is just "search it, check it". Rows read the same
  way as the ones in the main panel - name on its own line, details
  underneath. Searching a name
  you've never bought offers an **Add** action instead.
- the **main panel** shows the current shopping list itself, grouped
  by store section - that's where you add, edit, check things off,
  and manage sections.

The list fills two ways: ingredient checkboxes on recipes, and
direct adds.

## Adding from a recipe

Open any recipe - every ingredient row carries a checkbox, and
tapping anywhere on the row (the box or the ingredient text)
toggles it. Checking one puts that ingredient on the grocery list
with its quantity carried over verbatim and a note naming the
recipe; unchecking it removes it again. An **Add all to grocery
list** button above the recipe checks everything at once (items
already on the list are left alone).

Every ingredient you check gets its own permanent entry, scoped to
that recipe: file this recipe's "corn" into Frozen once and it
lands there every time you cook the recipe again, even after
unchecking or buying it. The same ingredient name in a different
recipe (or added by hand) is a separate entry with its own section -
canned corn for the chowder and fresh corn for the salad never
fight over one memory.

The first time an ingredient goes on the list, the app files it
into one of your sections for you, reading the recipe to tell
forms apart (the chowder's corn is canned; the salad's is fresh).
The ingredient's checkbox spins briefly while that happens - the
item is already on the list, in Other, and hops into its section a
moment later. If no section fits, it stays in Other. Any section
you set yourself sticks permanently; the app never second-guesses
you.

Two things to know:

- The checkbox means "this is on my list right now." Removing the
  item from the list (or checking it off during a shopping trip)
  unchecks it on the recipe too; re-checking it puts the same item
  back on the list, in its remembered section.
- **Editing a recipe removes its renamed or deleted ingredients
  from the grocery list.** Ingredients whose names survive the edit
  keep their entries (and sections); ones that disappear from the
  recipe text are dropped. Quantity-only changes remove nothing,
  and bookmark toggles and rating changes never touch the list.

## Adding directly

The **Add to list** input at the top of the main panel searches
your staples - items you've added by hand before - as you type.
Pick a suggestion to put that item back on the list; it keeps its
section, note, and photo from last time. If you keep variants of
the same thing (say, canned and fresh corn as separate items with
different notes and sections), each shows as its own suggestion,
with its section in grey so you can tell them apart. Recipe
ingredients don't appear here - they're managed from their recipes.

Above the suggestions sit two create actions:

- **Add "..." (Other)** - always available (Enter triggers it):
  the item lands unfiled in the Other card, for you to file
  yourself. This is also how you create a new variant of a name
  you already have.
- **Add "..." (Auto)** - shown when the name doesn't match
  anything you have: the item lands in Other and then hops into
  the section the app picks for it a moment later, judging by your
  own sections and what you've filed where. If it can't decide,
  the item just stays in Other. Filing it yourself - now or ever -
  always wins and is never overwritten.

The same pair appears in the sidebar when a search matches nothing.

## Shopping

The list renders one card per store section - **Other** always
first (it's the inbox: new adds and recipe ingredients land there
until you file them), then your sections in your order. The section
name is the card's title and items stack one per row inside it,
alphabetically by name. Sections with nothing on the list stay
hidden until you tick **Show empty sections** at the top - handy
when you're filing items and want the full store layout. Every
item on the list shows a **checked** box - as you
put things in your cart, uncheck them. Unchecked items drop into the
greyed-out **Acquired** section at the bottom, which stays collapsed
until you open it (it keeps your whole purchase history). Re-check
an acquired item to put it back on the list.

Each row reads top to bottom: the item **name** on its own line,
then a smaller grey line under it with the count and unit, your
note, and the recipe the item came from (separated by dots).
Both lines wrap onto as many lines as they need, so a long name or
a wordy note is never cut off mid-word - the name in particular is
always shown in full.

Tapping anywhere on an item's row toggles its checkbox - the whole
row is the tap target, not just the little box. To edit instead,
tap the pencil at the row's right edge: name, count, unit, a
free-form note, its section, and an optional photo (handy for "this
exact brand" label shots). Delete lives in the same editor. You can also drag an
item by its handle onto another section's card to re-file it - the
target card highlights as you hover, and the item keeps that
section from then on. On a phone, press and hold the handle
for a second (a small vibration confirms where supported), then
slide to the target card and release; the same hold-and-slide works
for reordering sections in the Sections manager.

To rearrange whole sections right in the list - say, to match the
order you walk the aisles - tick **Show empty sections** first: each
section card's title bar then grows a drag handle on the left. Drag
(or press-and-hold, then slide, on a phone) to where the accent line
shows, and release. The handles only appear with all sections
visible so a drag can't skip past a hidden one.

## Shopping trips

Hit **Start shopping** (top of the main panel) when you walk into
the store. From then on, everything you mark off drops into the
**In cart** section just below your list, so you can see the current
trip's haul at a glance - re-check anything to put it back on the
list. Hit **Finish shopping** when you're done (or just forget - a
trip ends automatically at midnight), and the cart's contents settle
into the acquired history. When no trip is running, the In-cart
section explains itself and stays empty.

## Sections

Click **Sections** at the top of the main panel to manage your store
sections: add new ones, rename or delete (a deleted section's items
move to Other), and drag rows to match the order you walk the store.
**Other** is permanent - it's where anything without a section lands.
A fresh account starts with a canned set (Produce, Bread, Deli,
Meats, Dairy, Frozen, Snacks, Pantry, Beverages, Household); change
them freely.
