# Cookbook

Nak's Cookbook is a personal store for recipes you want to keep on
hand. Recipes live in your Supabase project alongside your threads and
memories, so they follow you across browsers the same way the rest of
your data does.

The cookbook is a staging area — ideal for collecting recipes you
find on the web and cleaning them up before you move them into
whichever app actually runs your kitchen (AnyList, Paprika, a
pinned browser tab). Nak isn't a shopping-list app; it's the place
where you ask the model to fetch a recipe, edit out the prose, and
hand you a clean version to copy elsewhere.

## Format

Recipes are stored in [Cooklang](https://cooklang.org/docs/spec/), a
plain-text DSL for recipes. The shape is readable at a glance:

```cooklang
>> servings: 4
>> source: NYT Cooking

Bring a large pot of @water{} to a boil. Season generously with @salt{}.

Add the @spaghetti{400%g} and cook until al dente — check the box,
but usually ~{8%minutes}.

Whisk @eggs{3} with grated @pecorino{60%g} in a #bowl{}. Crack plenty
of @black pepper{} in.
```

Three kinds of reference:

- `@ingredient{qty%unit}` — a named ingredient, optionally with a
  quantity and unit.
- `#cookware{}` — a piece of cookware (pot, bowl, pan).
- `~timer{30%minutes}` — a timer step.

Plus `>> key: value` metadata lines for things like servings, source,
and prep time.

Single-word references can omit the braces — `@salt` is the same as
`@salt{}`.

### Optional ingredients

Mark an ingredient as optional with a `?` right after the `@`:

```cooklang
Top with @?feta{50%g} and a little @?fresh dill{} before serving.
```

Optional ingredients show up in the ingredient list with an
*(optional)* tag, and the tag carries into the plain-text and
Markdown copies. In the instruction text the ingredient reads
plainly - the sentence around it is where you say "if using."

The `@?` form isn't in the core Cooklang spec (which has no notion
of optionality), but it's the optional-ingredient modifier used by
the official Cooklang parser's extensions, so recipes you copy out
of nak stay readable by other Cooklang tools.

### Sections and long steps

Long recipes (soups with a garnish, breads with a starter and a dough,
anything that runs past one phase) can be split into sections and
rendered with sub-headings under both the ingredients and the
instructions. Two forms work, pick whichever reads better to you:

```cooklang
== Soup ==
Simmer @lentils{200%g} with @onion{1} in @water{1%L}.
> Add a pinch of @salt partway through.

# Finishing
Stir in @butter{2%tbsp} and serve.
```

- `== Section Name ==` is the canonical form (also accepted by other
  Cooklang tools like CookCLI).
- `# Section Name` (with a space after `#`) is a markdown-style alias
  — handy if you're used to writing headers that way. `#cookware` with
  no space still means cookware, so the two don't collide.
- A line starting with `>` (followed by a space and the rest of the
  text) is a **continuation** of the previous step. Use it to break a
  long instruction across two or three lines in the source without
  fragmenting it in the rendered recipe.

### Cookbook-style: declarations plus flat instructions

Pure Cooklang references ingredients inline in the instruction prose.
Cookbook-style recipes often do it the other way around: list the
ingredients first, then write the instructions. Nak supports that shape
directly.

```cooklang
# Soup
@chicken thighs{1%lb}, bone-in for richer broth
@red lentils{1%cup} rinsed
@chicken broth{6%cups}

# Finishing
@fresh parsley{1/4%cup} chopped
@sumac{1%tbsp}

--

Add @chicken thighs{1%lb}, @red lentils{1%cup}, and @chicken broth{6%cups}
to the #crock pot{}.
> Cook on low for ~{6%hours}.

Ladle into bowls and top with @fresh parsley{1/4%cup} and @sumac{1%tbsp}.
```

- Any line whose first non-whitespace character is `@` is an
  **ingredient declaration**. The ingredient goes into the ingredients
  list and the per-section grouping, but the line itself is not
  numbered as an instruction.
- A line made up of only dashes (e.g. `--`, `---`) is a **section
  reset**. It ends the current `# Section` so the prose below it
  renders as a flat numbered instruction list without inheriting the
  last section heading.
- The two styles can be mixed. When declarations exist, the ingredient
  list is authored from them alone — references inside instruction
  prose are treated as cross-references, not as new ingredients, so
  they don't double-count.

## Opening the Cookbook

Two entry points:

- **The book icon in the sidebar footer.** Opens the full Cookbook
  modal: list of every recipe you've saved, with detail and edit
  panes.
- **The Recipes tab in the conversation drawer.** Shows the same list
  next to your threads. Clicking a recipe opens it in the Cookbook
  modal on the detail pane.

## Adding a recipe

**By hand**: click **+ New recipe**. Fill in a title, optionally a
source (URL or provenance note), and the Cooklang source. A live
preview renders as you type so you can check the structure. On the
detail pane the source shows as a short labeled link - the source
name if you gave one, otherwise just "Source" - so a long URL no
longer stretches the line across the whole width.

**Via the model**: ask Nak in chat. "Save this chicken piccata recipe
to my cookbook" followed by the URL, or just paste the recipe text —
the model will call the `recipe_save` tool and store the result in
Cooklang form.

The Cookbook tools live inside the `cooking` toolbox. If Nak tells
you it can't save a recipe, open the composer's toolbox popover and
enable Cooking, then try again.

## Jumping around a recipe

The detail pane shows a small **contents** box above the recipe with
links to **Ingredients** and **Instructions**. Click one to scroll
straight to that part - handy on a long recipe where the instructions
sit well below the ingredient list.

If the recipe uses sections (see "Sections and long steps" above), each
section shows as a sub-link under both Ingredients and Instructions, so
you can jump directly to "Finishing" or "For serving" without
scrolling past the rest.

The box only appears when there's more than one place to jump to - a
short recipe with just an ingredient list and a few steps doesn't get
one, since there's nothing to navigate.

## Following along while you cook

On the detail pane, click (or tap) any instruction step to highlight
it with a soft wash in your theme's accent colour — a visual
bookmark for the step you're on. Clicking another step moves the
highlight; clicking the highlighted step again clears it. The
highlight is local to your current view; switching to another recipe
clears it automatically, and nothing is saved to the server.

## Rating recipes

Each recipe carries an optional 1-5 star rating. New recipes start
unrated; the rating belongs on the "did this work?" pass after you
actually cook it.

- **In the detail pane**, click any star to set the rating. Clicking
  the highest currently-set star clears it back to unrated. The change
  saves immediately and lands in the recipe's history with an
  auto-generated message ("Rated 4 stars." / "Cleared rating.") so
  you can scan rating changes alongside content edits.
- **In the edit form**, the rating control sits between the source URL
  and the change-message field. The rating saves with the rest of the
  edit, so a single change-message covers the whole edit including
  the rating change.
- **Asking the model**: tell Nak how you feel about the recipe ("that
  ground-pork ragu was a 5", "drop the chickpea curry to 2 stars")
  and it will call `recipe_update` to set or clear the rating. Nak
  will not invent a rating on its own; it only writes a rating when
  you've explicitly told it what to set.

Sort the list by rating with the **Sort** selector at the top of the
Cookbook list pane. Highest-rated recipes appear first, ties broken
by most-recent edit; unrated recipes sink to the bottom so the
sort is honest about which recipes you've actually tried.

The same selector also offers **A-Z**, which sorts the list by
title. Useful when you remember the name of a recipe but not when
you last opened it.

The list loads in pages as you scroll - the first batch of recipes
appears right away, and more load automatically as you reach the
bottom, so a large cookbook never silently stops at a fixed cap.
Switching the sort or the topic filter reloads from the top in the
new order. Search is separate: typing in the box replaces the list
with the closest matches (it does not page), and clearing the box
returns to the scrollable browse list.

## Marking recipes as "upcoming"

When you're planning the next grocery run, you can mark recipes as
**upcoming** - a bookmark for the things you intend to cook during
the current shopping cycle. Upcoming recipes appear in an **Upcoming**
section at the top of the Recipes listing so you can scan "what's on
deck" without scrolling.

- **To mark a recipe**: open it in the detail pane and click the cart
  icon in the action bar (left of the pencil). The icon fills in and
  tints to your accent colour to show the recipe is now bookmarked.
- **To unmark**: click the cart again. The recipe stays where it was
  in the list; only the bookmark goes away.
- **Where they show up**: in the **Upcoming** section at the top of
  the Recipes drawer tab, AND in their natural spot in the main list
  below. The duplication is intentional - you can see "what's coming
  up" at a glance without losing the recipe from its usual position.
  A small cart glyph appears at the right edge of upcoming recipes'
  rows in the main list too, so you can tell at a glance which of the
  regular entries are also bookmarked.
- **Stable sort**: toggling the upcoming flag does NOT bump the
  recipe to the top of the recency sort - the flag is a workflow
  bookmark, not an edit. The recipe stays in whatever spot the
  "Recent", "Rating", or "A-Z" sort puts it.
- **Manual clear**: the flag stays on until you turn it off. There
  is no automatic "reset at end of week" - turn upcoming off when
  you've shopped (or cooked) the recipe.

The upcoming flag is yours - it does not appear in the recipe's edit
history and the model does not toggle it on its own. It's a personal
"do not forget this for this shopping trip" marker.

## Favorites

A favorite is a long-lived bookmark for recipes you love and want
one click away - independent of "upcoming," which is the
shopping-cycle bookmark. A recipe can be a favorite, upcoming, both,
or neither.

- **To favorite a recipe**: open it in the detail pane and click the
  thumbs-up icon in the action bar (just right of the cart). The
  icon fills and tints to the accent colour when the recipe is
  favorited.
- **To unfavorite**: click the thumbs-up again.
- **Where they show up**: in a **Favorites** section right below
  **Upcoming** and above the main listing. As with Upcoming, the
  favorited row ALSO continues to appear in its natural position in
  the main list, marked with a small thumbs-up glyph at the right
  edge of the row so you can spot favorites at a glance.
- **Stable sort**: toggling favorite does not bump the recipe in the
  recency sort - it's a bookmark, not an edit.

Same as upcoming, the favorite flag is yours and the model does not
toggle it on its own.

## Filtering by topic

Below the search box in the Recipes drawer, a **Topics ▾** dropdown
narrows the listing to recipes about a particular ingredient,
cuisine, course, or technique - "chicken", "italian", "dessert",
"no-cook". A background worker tags each recipe with up to six short
topic strings spanning those four dimensions as you accumulate them;
the dropdown shows the topics you've collected so far, plus an
**untagged** row that filters to recipes the worker hasn't reached
yet.

- **Each row shows a count.** `chicken (12)` means twelve recipes
  carry that topic; the untagged row's count is how many recipes are
  still waiting on the worker.
- **Multi-select is OR semantics.** Picking "chicken" + "dessert"
  shows recipes tagged with either - useful for "what are my
  chicken or dessert options."
- **The filter narrows everything uniformly.** Upcoming, Favorites,
  the main listing, and any active search all narrow to the same
  predicate, so "filter to italian" really means "italian
  everywhere on this tab."
- **The worker focuses on PRIMARY ingredients.** It deliberately
  skips pantry staples (salt, oil, butter, garlic, common spices) -
  those are too ubiquitous to differentiate one recipe from
  another. Tags are the headline protein or vegetable, plus
  cuisine, course, and technique when each applies.
- **Cuisine is tagged generously.** Any dish with a cultural lean
  gets a cuisine tag, and a fusion dish gets one for each cuisine it
  draws on - Korean-Mexican tacos land under both "korean" and
  "mexican".
- **Tags are managed for you.** No manual tagging UI; any edit to a
  recipe re-queues it, and the worker re-tags it on its next pass.

The pill row below the dropdown carries the active selection; each
pill's × clears just that one tag, and a "clear" link appears when
you have two or more selected.

## Photos

Each recipe can carry up to 12 photos that show as thumbnails at the
top of the detail pane, just above the servings line. Click any
thumbnail to open it full-size. In the viewer you can page between
photos with the on-screen arrows pinned to the left and right edges,
the Left/Right arrow keys, or - on a touchscreen - by swiping
left/right (pinch-to-zoom still works). Paging loops, so going past
the last photo wraps back to the first. Escape (or a click outside
the image) dismisses it.

Photos can also carry an optional **caption** (or label) - a short
note that renders in italics below the thumbnail in the strip and as
a caption beside the full-size image in the viewer. Captions also
become the photo's alt text and hover title, so screen readers and
mouse-hover tooltips pick them up. Captions are optional and don't
have to be unique - two photos on the same recipe can share the
same caption, or none at all.

- **In the edit form**, the **Photos** field sits between the rating
  and the Cooklang source. Click **+ Add photo** to pick one or
  more files; the per-cell controls move a photo left or right or
  remove it, and the **Caption** input under each photo lets you
  add or change the label. Images are downscaled to 2048 pixels on
  the long edge before upload, so a 12-megapixel phone photo doesn't
  bloat the recipe row. Caption edits stay in memory until you click
  **Save** - the entire photo set (additions, removals, reorders,
  and caption changes) lands in one save with one change message,
  not one save per keystroke. Photo edits land in the History panel
  under the same change message as everything else in the save.
- **Asking the model**: tell Nak which photos to add and it will call
  `recipe_photos_attach`, optionally with a caption per photo
  ("attach the cookies photo with the caption 'finished plate'").
  The photos must be live in this conversation (not yet expired -
  see the conversation drawer for the per-thread attachment list).
  Nak can also remove photos (`recipe_photos_remove`), reorder them
  (`recipe_photos_reorder`), or set captions on photos already on
  the recipe (`recipe_photo_label_set`) when you ask. Each tool
  call lands its own row in the History panel with the message Nak
  wrote.

Captions and photos round-trip through the History panel like every
other field: revert restores the exact photo set, order, and
captions that were on the recipe at the moment that version was
saved, even if you've added, removed, or relabelled photos since.

## Editing and deleting

- **Edit** from the detail pane. Changes save in place; the list
  reorders with the most-recently-edited recipe at the top.
- **Delete** from the detail pane. Confirmation is required and the
  delete is permanent — Nak doesn't keep a trash bin for recipes.

Every save (create or edit) prompts you for a one-line **What
changed?** note. It's required and lands in the recipe's history so
you can scan past edits by intent rather than by content. Examples
of useful messages: `Imported from NYT Cooking`, `Doubled the
recipe`, `Fixed step 3 typo`, `Removed tahini per pantry note`.

## History

Every save creates a version. Each version is an immutable snapshot
of the title, source, source URL, Cooklang, and rating at the moment
of the save, plus the change message you wrote. Versions are kept
indefinitely - the cookbook is small and your edit log is the point.

Open the **History** panel at the bottom of any recipe's detail
pane to see the full edit log, newest first. Each row shows when
the version was saved and the change message. The latest row is
labelled **current** - what you're looking at on the page.

Click any past row to view that snapshot read-only. The recipe
above swaps to the version's content, and a banner at the top tells
you which version you're viewing. Two controls appear:

- **Back to current** returns you to the live recipe.
- **Revert to this version** rolls the recipe back: the live state
  becomes whatever the snapshot held. The revert itself is recorded
  as a new version (with its own change message), so a misclick is
  recoverable - just revert again to the version you came from.

Nak (the model) creates versions too. When you ask the model to
edit a recipe, it provides its own change message describing what
it changed and why; that message appears in the History panel
alongside your hand-written ones.

## Copying for another app

Three copy buttons on every detail pane:

- **Copy plain text** — a structured plain-text version (title,
  ingredients list, numbered instructions). This is what you want
  to paste into AnyList's "add multiple items" text area, or into
  any app that accepts "one ingredient per line".
- **Copy as Markdown** — the same structure rendered as Markdown,
  with headings, list bullets, a clickable source link, and cookware
  included. For pasting into a notes app (Obsidian, Notion, an
  Apple Note that renders markdown) or a GitHub issue. If you (or
  the model) left inline markdown in the recipe text — emphasis,
  backticks, links — it round-trips verbatim; nak doesn't escape it.
- **Copy Cooklang** — the raw source, for backup or for pasting into
  another Cooklang-aware app.

Nak doesn't send your recipes anywhere; the copy happens entirely in
your browser.

## Limits

- Recipe source is capped at 20 000 characters. A typical recipe
  runs 1-3 KiB, so this is comfortable even for long multi-stage
  breads. If you hit the ceiling, trim the prose — Cooklang's
  structured references already encode most of what prose adds.
- Titles are capped at 160 characters.

## Related pages

- [Memory](./memory.md) — long-term notes Nak writes about you
  across conversations (different scope: a memory is something
  *about you*; a recipe is a thing you own).
- [Settings overview](./settings.md) — where the rest of your
  preferences live.
