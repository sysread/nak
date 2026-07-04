# Intent inspector: the pill, the modal, the read-only surfacing

> **Behavior change (post first execution):** the seedling pill is
> no longer gated on `app.intentsEnabled` - the modal now also hosts
> the follow-ups section
> ([followup-inspector](./followup-inspector.md)), which every
> account has, so the pill is always present and the toggle switches
> only its copy and whether the Working intentions SECTION renders.
> The 2026-06-25 pass below is the pre-change baseline; steps 1-2
> and expectations 1-3 describe the new behavior and need a fresh
> execution.

## Covers

The read-only "surfaced" surface of intents
([dev: intents](../../dev/in-progress/intents.md)): the seedling
pill (the `intents` entry in the shared diagnostic-pill column,
`src/lib/ui/diagnostic-pills.ts`, always present), the intents
section of the shared inspector modal (`Intents.svelte`, route
`modal: 'intents'`) listing intents grouped active / paused /
let-go via the `listIntents()` read, and the honest label
primitives in `src/lib/ui/intents-inspector.ts`. Proves the user
can SEE what Nak is working toward but cannot edit it, and that
the off-by-default majority sees no intentions section at all.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev
  user. `$UID` is the signed-in user.
- Some intents to view. Forge a representative spread directly:

  ```sql
  insert into intents (user_id, statement, status, target_kind, target_ref, target_direction, efficacy)
  values
    ('$UID', 'help them name a contrary view before committing', 'active', 'bias', 'confirmation_bias', 'reduce', 0.72),
    ('$UID', 'lean on their knack for reframing when stuck',      'active', 'none', null, null, null),
    ('$UID', 'ease them off all-or-nothing framing',              'dormant','bias', 'black_and_white_thinking', 'reduce', 0.30),
    ('$UID', 'an approach that did not land',                     'retired','none', null, null, null);
  ```

## Steps

1. **Section hidden when off.** Ensure the toggle is off
   (`update profiles set settings = settings - 'intentsEnabled' where user_id = '$UID';`),
   reload the chat view, hover the seedling pill, and open it.
2. **Section appears when on.** Settings -> AI -> check "Working
   intentions". Return to chat; hover the seedling pill again (bottom
   of the pill column, directly above the scroll-to-bottom arrow; on
   a narrow viewport it is the last tile in the diagnostics menu).
3. **Open the inspector.** Click the seedling pill.
4. **Read the groups.** Confirm the three sections and the per-card
   content.
5. **Empty state.** Delete the forged rows
   (`delete from intents where user_id = '$UID';`), reopen the
   inspector.

## Expected

- (1) With intents OFF, the seedling pill STILL renders (it hosts
  follow-ups), but its tooltip reads follow-ups-only ("View
  follow-ups - questions Nak saved to ask you later") and the opened
  modal is titled "Follow-ups" with NO Working intentions section
  and no `intents` query fired.
- (2) With intents ON: the pill tooltip covers both features, and on
  mobile (<=720px) the column is hidden, so the pill must NOT appear
  there - it lives only as the matching tile in the composer
  diagnostics menu. (Regression guard: the intents pill once leaked
  onto mobile by being absent from the column's mobile-hide rule in
  `styles.css`.)
- (3) The modal opens titled "Working intentions & follow-ups" with
  the read-only blurb and a "Working intentions" section above the
  follow-ups section. There are NO edit/delete controls anywhere.
- (4) Three sections render in order - **Active** (the two active
  rows), **Paused** (the dormant row), **Let go** (the retired row,
  visually dimmed). Each card shows: the statement; a target label
  ("easing confirmation bias" for the active targeted row, "easing
  black-and-white thinking" for the paused row, "no specific target"
  for the free-form rows); an
  efficacy badge that is honest - `0.72` reads "landing", `0.30`
  reads "not landing", the free-form active row reads "open-ended"
  (never a number), and a targeted row with null efficacy would read
  "too new to tell"; the "updated ..." relative time.
- (5) With no rows, the modal shows the empty-state copy ("No
  intentions yet ... Nak reviews your patterns once a day ..."), not
  an error or a blank panel.

## Cleanup

```sql
delete from intents where user_id = '$UID';
update profiles set settings = settings - 'intentsEnabled' where user_id = '$UID';
```

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-25 | — | (this commit) | not run | Authored with the inspector. The cloud authoring env has no browser/stack; first execution (the pill visibility, the modal grouping, the empty state) is pending a live `mise run dev-start` + a browser, or the CLI's Playwright pass. The label/grouping logic is unit-covered in `tests/intents-inspector.test.ts`; this case proves the render + the toggle-gated pill, which units cannot reach. |
| 2026-06-25 | local (dev-start) | 9a914fd | pass | First execution, CLI Playwright pass against the live stack (signed in as dev@nak.local). (1) Toggle off -> no seedling pill; column starts at samskara/intuition/bias/recall (no `intents` query path, since the pill is the only entry to the modal that calls listIntents). (2) Toggled on via Settings -> AI checkbox -> persisted `intentsEnabled=true`, inline "Intents enabled..." confirmation appeared, seedling pill (U+1F331) rendered at the visual TOP of the column (verified by bounding box: top=402 above recall=435 - the column is bottom-anchored/reversed, so the DOM-last pill is visually topmost) plus a matching narrow-viewport diag-tile. (3) Modal opened with the "Working intentions" header + read-only blurb; only control is Close (no edit/delete). (4) Three sections in order Active/Paused/Let go; honest badges confirmed - 0.72 "landing", 0.30 "not landing", free-form "open-ended" (no number); retired card visually dimmed (opacity 0.62, `.retired`); headline "Nak is working toward 2 intentions with you". (5) Empty state copy rendered, no error/blank. Fixed a use-case data defect found this run: the forged dormant row's `target_ref` was `black_and_white` (not a bias-catalog key), so the inspector correctly fell back to the generic "easing a cognitive pattern" instead of the intended named bias; corrected to `black_and_white_thinking` (catalog label "Black-and-white thinking"). Not exercised live (conditional, unit-covered): a targeted row with null efficacy reading "too new to tell". |
