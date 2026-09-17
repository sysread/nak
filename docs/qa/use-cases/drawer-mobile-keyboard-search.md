# Drawer: mobile keyboard keeps the tab search box visible

## Covers

- The drawer's short-viewport mode: when the on-screen keyboard
  shrinks the viewport, the sidebar scrolls as one region so the
  tab search box can be brought above the keyboard - see the
  drawer keyboard Gotcha in [chat](../../dev/chat.md).
- The iOS-only `--keyboard-inset` rule on the mobile `.sidebar`
  (the same inset mechanism the composer uses, see
  [chat-mobile-keyboard-inset](./chat-mobile-keyboard-inset.md)).
- Typing into a drawer search box on a phone at all: the original
  bug report paired the hidden box with text arriving in reverse
  order, so this case checks both.

## Preconditions

- A real phone. Desktop device emulation does not reproduce the OS
  keyboard's viewport resize or its text composition, and both are
  the point of this case.
- The app deployed somewhere the phone can reach (hosted project,
  or the local stack exposed on the LAN). Signed in, with at least
  a few recipes saved so the Recipes tab has something to search.
- Ideally run once on Android (Chrome) and once on iOS (Safari).
  Android relies on the viewport resize plus the short-viewport CSS
  mode; iOS relies on the inset variable, which the author has never
  been able to test on hardware.

## Steps

1. Open the drawer (hamburger) and pick the **Recipes** tab. Note
   that the eight tab rows sit above the search box and that only
   the list below the tabs scrolls.
2. Tap the **Search recipes** box so the on-screen keyboard opens.
   Observe where the box is.
3. Type a word slowly, one character at a time, e.g. `chili`.
   Observe the box contents after each character.
4. Wait for the results to replace the list. Observe the box.
5. Dismiss the keyboard (back gesture on Android, "done"/tap-away
   on iOS). Observe the drawer.
6. Repeat steps 2-5 on the **Chats** tab (search conversations) and
   the **Groceries** tab (its list is styled inside its own
   component and mirrors the drawer rule separately).
7. Rotate the phone to landscape with the drawer open and no
   keyboard. Observe the drawer.

## Expected

- (2) The search box is fully visible above the keyboard, with the
  caret in it. The tab rows have scrolled up out of view or partly
  out of view; the drawer as a whole scrolls if you drag it.
- (3) Characters appear in the order typed, at the end of the text
  (`c`, `ch`, `chi`, ...). Never reversed, never inserted at the
  front.
- (4) The scanner and then the results render below the box; the
  box stays visible and keeps its text.
- (5) The drawer returns to its normal shape: tabs fixed at the
  top, list scrolling on its own, nothing cut off at the bottom.
- (6) Same results on the other two tabs.
- (7) In landscape the drawer scrolls as one region (the tab rows
  alone are taller than a landscape viewport), and the search box
  is reachable by scrolling.

## Cleanup

None - the case mutates no data.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-09-17 | - | - | not run | Authored in a cloud session (no phone attached). Baseline before the fix, per the bug report on Android Chrome: tapping the Recipes search box brought up the keyboard with the box out of sight, and the typed text came out reversed. |
