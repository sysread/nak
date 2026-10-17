# Cookbook: recipe_save refuses text that would not render

## Covers

The save-time checks `recipe_save` runs before writing
([dev: cookbook](../../dev/cookbook.md), "Save-time validation"
gotcha): a note written as a `#` heading (empty section), a `##`
heading, a `--` glued to a range, and literal `\n` escapes. Each must
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

## Cleanup

```sh
mise run dev-sql "delete from recipes where title = 'ZZQA Save Validation'"
```

On the hosted app, delete the recipe from the Cookbook panel.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
