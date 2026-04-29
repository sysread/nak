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
preview renders as you type so you can check the structure.

**Via the model**: ask Nak in chat. "Save this chicken piccata recipe
to my cookbook" followed by the URL, or just paste the recipe text —
the model will call the `recipe_save` tool and store the result in
Cooklang form.

The Cookbook tools live inside the `cooking` toolbox. If Nak tells
you it can't save a recipe, open the composer's toolbox popover and
enable Cooking, then try again.

## Following along while you cook

On the detail pane, click (or tap) any instruction step to highlight
it with a soft wash in your theme's accent colour — a visual
bookmark for the step you're on. Clicking another step moves the
highlight; clicking the highlighted step again clears it. The
highlight is local to your current view; switching to another recipe
clears it automatically, and nothing is saved to the server.

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
of the title, source, source URL, and Cooklang at the moment of the
save, plus the change message you wrote. Versions are kept
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

Two copy buttons on every detail pane:

- **Copy plain text** — a structured plain-text version (title,
  ingredients list, numbered instructions). This is what you want
  to paste into AnyList's "add multiple items" text area, or into
  any app that accepts "one ingredient per line".
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
