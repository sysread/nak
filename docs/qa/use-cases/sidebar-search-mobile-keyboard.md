# Sidebar: drawer search stays usable above the mobile keyboard

## Covers

- The drawer nav collapse while a sidebar search box has focus, its
  delayed restore, and the keyboard lift on the mobile drawer - see
  the mobile keyboard Gotcha in [chat](../../dev/chat.md).

## Preconditions

- A real phone (emulation does not reproduce the OS keyboard
  overlay). Ideally one iOS Safari run and one Android Chrome run.
- The app deployed somewhere the phone can reach, signed in, with
  at least a few conversations and recipes so the lists have rows.

## Steps

1. Open the drawer on the Chats tab. Tap the search box.
2. Type a word that matches several conversations.
3. Tap one of the results.
4. Reopen the drawer, switch to Recipes, tap its search box, then
   tap an empty part of the drawer below the list (or "done" on iOS).
5. Tap the search box again, then quickly tap it a second time.
6. On a desktop-width window, click into any drawer search box.

## Expected

- (1) The section buttons disappear and the search box sits at the
  top of the drawer, fully visible above the keyboard. The page
  does not zoom in.
- (2) Results fill the space between the search box and the
  keyboard; the drawer's bottom edge meets the top of the keyboard.
- (3) The tapped conversation opens - not a neighboring row. This
  is the regression the delayed restore exists for.
- (4) The section buttons come back a moment after focus leaves.
- (5) The buttons stay hidden; no flash of the nav in between.
- (6) Nothing changes - the nav stays put on desktop.

## Cleanup

None - the case mutates no data.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-09-25 | - | - | not run | Authored in a cloud session (no phone attached). Baseline per the user's report after the keyboard-lift fix alone: the search input was still under the keyboard because the nav stack left less room than the input's height. |
