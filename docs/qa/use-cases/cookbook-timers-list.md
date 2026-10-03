# Cookbook: Timers list

## Covers

The Timers block on the recipe detail pane
([dev: cookbook](../../dev/cookbook.md), "The Timers total is
all-or-nothing"): the summed **Total** row, the timers nested under
it as a breakdown, range totals, the flat fallback when a duration is
unreadable, inline emphasis in an unnamed timer's step text, step
text clamped to two lines, timer labels linking to their steps, and
the ingredient-row checkbox layout.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user
  (auto-login seam).
- Recipe `Timers QA` with body:

  ```text
  Simmer the sauce **gently**, _uncovered_, stirring now and then so the bottom does not catch, for ~{30%minutes}.
  Braise ~{2-3%hours}.
  Let it ~rest{10%minutes}.
  ```

- `Timers QA` is bookmarked as upcoming, so its ingredient rows
  carry grocery checkboxes. Add one long ingredient line to its body:
  `@dried porcini{1%oz} (if substituting baby bellas: 8 oz, quartered - cremini and portobello are the same species)`.
- Recipe `Timers QA Flat` with body:

  ```text
  Simmer ~{30%minutes}.
  Rest ~{a while%minutes}.
  ```

## Steps

1. Open `Timers QA` in the detail pane and find the Timers block.
2. Narrow the window to phone width (under 720px).
3. Tap the **30 minutes** timer label.
4. Open `Timers QA` in edit mode, switch to the Preview tab, and tap
   the **rest: 10 minutes** label.
5. Open `Timers QA Flat`.

## Expected

- (1) The block's only top-level row reads
  **Total: 2 hr 40 min - 3 hr 40 min**. The three timers are
  indented under it. The 30-minute timer's step text shows *gently*
  in bold and *uncovered* in italics, with no literal `**` or `_`.
- (2) The 30-minute timer's step text wraps to two lines and ends in
  an ellipsis. The page does not scroll sideways. Each ingredient row
  shows its checkbox on the same line as the text, with no accent
  dot. The long porcini line wraps, and its second line sits under
  the text, not under the checkbox.
- (3) The pane scrolls to the Simmer step and highlights it. The URL
  does not gain a `#cook-step-...` fragment.
- (4) The preview pane scrolls to the rest step. The URL does not
  change.
- (5) No Total row. The two timers render as a plain top-level list.

## Cleanup

```sh
mise run dev-sql "delete from recipes where title like 'Timers QA%'"
```

Then stop the stack (`Ctrl-C` / SIGTERM to the dev-start process).

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
