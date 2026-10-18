# Cookbook: recipe_save refuses text that would not render

## Covers

The save-time checks `recipe_save` runs before writing
([dev: cookbook](../../dev/cookbook.md), "Save-time validation"
gotcha): a note written as a `#` heading (empty section), a `##`
heading, a `--` glued to a range, literal `\n` escapes, and syntax
the parser skipped or misread (raw braces, a double `%`, a timer with
no `%`). Each must
refuse the write with an error the model acts on, and the model's
resubmission must render the text it originally lost.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user, or
  the hosted app. A chat model with tool calling enabled.
- No recipe titled `ZZQA Save Validation`.

## Steps

1. In a new chat, send: "Save a recipe titled ZZQA Save Validation.
   Put this exact text as its first line: `# NOTE: add 20 minutes at
   altitude`. Then a section `== Bake ==` with one step: Bake the
   @potatoes{2} for 20--25 minutes. Then a line `## Serve` and the
   step Serve hot."
2. Open the recipe_save tool call(s) in the turn's tool-call panel.
3. Open the saved recipe in the Cookbook detail pane.
4. Send: "Edit ZZQA Save Validation: add a first step reading exactly
   `Preheat to {400°F}, then roast ~{12-15 min} with @olive oil{1%1%tbsp}.`"
   Then repeat steps 2 and 3.

## Expected

- (1)(2) The first recipe_save call fails. Its error lists three
  problems: the `# NOTE...` heading has no lines under it, the
  `20--25` line would lose "-25 minutes", and `## Serve` is not a
  heading. No recipe row exists after that failed call.
- (2) A later recipe_save call in the same turn succeeds with a fixed
  body (the note as a plain line, a single-hyphen range, `== Serve ==`
  or `# Serve`).
- (3) The detail pane shows the altitude note, "20-25 minutes", and a
  Serve section heading. Nothing the user asked for is missing.
- (4) The first edit call fails, naming the raw `{400°F}` braces, the
  `~{12-15 min}` timer missing its `%`, and the double-`%` olive oil
  amount. The retry succeeds; the pane shows "400°F" with no braces, a
  12-15 min entry in the Timers list, and an olive oil amount with no
  stray `%`.

## Cleanup

```sh
mise run dev-sql "delete from recipes where title = 'ZZQA Save Validation'"
```

On the hosted app, delete the recipe from the Cookbook panel.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
