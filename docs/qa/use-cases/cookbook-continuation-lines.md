# Cookbook: `>` continuation lines

## Covers

The `>` continuation extension on the recipe detail pane and the
copy exports ([dev: cookbook](../../dev/cookbook.md)): plain prose
continuations rejoining the step text, bullet continuations
(`-` / `*`) rendering as a sub-list inside the numbered step, the
trailing prose after a sub-list starting its own line, step
tap-highlight resolving through sub-bullets to the parent step, no
step badges on sub-list items, the timer context reading the step's
first prose block, and the Markdown / plain-text export nesting.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user
  (auto-login seam). QA against a worktree checkout: start a second
  Vite from the worktree (`mise run dev-frontend`, next free port) —
  the stack's :5173 serves the main checkout, not the worktree.
- Recipe `ZZQA Continuation Lines` with body:

  ```text
  Enrich the dough, then tune hydration.
  > - **Juicier than usual:** estimate proportionally less - e.g. ~4/5 of baseline.
  > - **Overcooked:** let it rehydrate before the pour.
  > Starting light is the reversible direction - water goes in, it does not come out.
  Shape and proof overnight.
  > Bulk ferment ~{12%hours} in the fridge.
  Bake at 475F.
  ```

## Steps

1. Open the recipe in the detail pane. Find step 1 in Instructions.
2. Click the first sub-bullet (**Juicier than usual**), then click it
   again.
3. Override `navigator.clipboard.writeText` to capture writes, then
   click **Copy as Markdown** and **Copy as plain text** and read the
   captured strings.

## Expected

- (1) Step 1 renders three blocks in order: the prose lead, a
  `ul.cook-substeps` with two `<li>` items carrying `<strong>` on the
  lead-in phrases, then the trailing prose on its own line. The sub
  items' `::before` computed content is `none` (no step badges); the
  step's own badge counts it as step 1 of 3. The Timers block shows
  **Total: 12 hr** with context
  *Shape and proof overnight. Bulk ferment 12 hours in the fridge.*
  (the second step's prose rejoined, no raw newlines).
- (2) The first click highlights step 1 (the parent `<li>` gains
  `is-active`; the sub item itself does not). The second click clears
  it.
- (3) Markdown: `1. Enrich the dough, then tune hydration.` then the
  two bullets at a four-space indent, then a blank line and the
  trailing prose at the same indent (a sibling paragraph of the
  sub-list, not a lazy continuation). Plain text: the same shape with
  three-space indents. Steps 2 and 3 stay single lines.

## Cleanup

```sh
mise run dev-sql "delete from recipes where title = 'ZZQA Continuation Lines'"
```

Stop the worktree's second Vite if one is still running.

## Results log

| Date       | Env                              | Commit    | Result | Notes                                                                                          |
| ---------- | -------------------------------- | --------- | ------ | ---------------------------------------------------------------------------------------------- |
| 2026-10-16 | worktree Vite :5174, local stack | 9e109d38  | PASS   | First run; all three steps verified via Playwright against the worktree bundle (see git log).  |
| 2026-10-16 | prod (GitHub Pages deploy)       | 6569eef2  | PASS   | Confirmed by Jeff after the deploy chain landed.                                               |
