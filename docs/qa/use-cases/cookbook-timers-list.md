# Cookbook: Timers list

## Covers

The Timers block on the recipe detail pane
([dev: cookbook](../../dev/cookbook.md), "The Timers total is
all-or-nothing"): the summed **Total** row, the timers nested under
it as a breakdown, range totals, the flat fallback when a duration is
unreadable, inline emphasis in an unnamed timer's step text, and long
step text wrapping instead of clipping.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user
  (auto-login seam).
- Recipe `Timers QA` with body:

  ```text
  Simmer the sauce **gently**, _uncovered_, stirring now and then so the bottom does not catch, for ~{30%minutes}.
  Braise ~{2-3%hours}.
  Let it ~rest{10%minutes}.
  ```

- Recipe `Timers QA Flat` with body:

  ```text
  Simmer ~{30%minutes}.
  Rest ~{a while%minutes}.
  ```

## Steps

1. Open `Timers QA` in the detail pane and find the Timers block.
2. Narrow the window to phone width (under 720px).
3. Open `Timers QA Flat`.

## Expected

- (1) The block's only top-level row reads
  **Total: 2 hr 40 min - 3 hr 40 min**. The three timers are
  indented under it. The 30-minute timer's step text shows *gently*
  in bold and *uncovered* in italics, with no literal `**` or `_`.
- (2) The 30-minute timer's step text wraps onto several lines and
  is readable to the end. Nothing is cut off, and the page does not
  scroll sideways.
- (3) No Total row. The two timers render as a plain top-level list.

## Cleanup

```sh
mise run dev-sql "delete from recipes where title like 'Timers QA%'"
```

Then stop the stack (`Ctrl-C` / SIGTERM to the dev-start process).

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
