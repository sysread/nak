# Cookbook: the recipes save op refuses text that would not render

## Covers

The save-time checks the recipes tool (op=save) runs before writing
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
2. Open the recipes tool call(s) in the turn's tool-call panel.
3. Open the saved recipe in the Cookbook detail pane.
4. Send: "Edit ZZQA Save Validation: add a first step reading exactly
   `Preheat to {400°F}, then roast ~{12-15 min} with @olive oil{1%1%tbsp}.`"
   Then repeat steps 2 and 3.

## Expected

- (1)(2) The first save call fails. Its error lists three
  problems: the `# NOTE...` heading has no lines under it, the
  `20--25` line would lose "-25 minutes", and `## Serve` is not a
  heading. No recipe row exists after that failed call.
- (2) A later save call in the same turn succeeds with a fixed
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
| 2026-11-03 | local (dev@nak.local, glm-5-3-flash) | 3235f2d (pre-M3 baseline) | PASS (4/4) | All 4 refusal/retry pairs behaved as specified: first-call failures listed all three problems each (heading-with-no-lines, `--` comment eating the range, `##` not a heading; then raw `{400°F}`, missing `%` in the timer, double-`%` olive oil), nothing written by failed calls, both retries passed first-try, rendered pane correct (note plain-ish, `20-25 minutes` live timer, clean amounts). 4 tool calls, all `recipe_save`; no read verb used at any point; the edit re-sent the full cooklang document with id (reconstructed from the model's own earlier turn). Model pre-diagnosed the second refusal set in prose and made the failing call deliberately - if the post-change run skips failing calls entirely, that is model behavior, not validator drift. Out of scope, unverified: the detail header showed five filled stars while `rating` was null (likely the unrated control's styling in this theme). |
| 2026-11-03 | local (dev@nak.local, glm-5-3-flash) | de7fddc5 (post-M3, recipes combo) | PASS (4/4) | Validator identical to baseline: both refusal sets open with "cooklang validation failed:" + three bullets, contents line-by-line matching (only bullet ORDER differed in set B - content identical). 6 calls, all `recipes` + op (list, save x3 incl. the forced probe, get); ZERO op-omissions this run; the read ops appeared naturally (list opened, get opened the edit) - the combo making reads cheap to reach is a favorable side effect. Deviations all model-behavior: the model asked "save fixed or leave empty?" instead of auto-retrying (ask_user card); it skipped the failing edit call and pre-corrected (baseline note pre-authorizes that classification); a forced verbatim probe produced the full expected refusal set and wrote nothing; it chose `=== Serve ===` over `== Serve ==` (renders fine). Rating-stars quirk carried (out of scope). |
