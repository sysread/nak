# Chat: mobile keyboard keeps the composer visible

## Covers

- The mobile on-screen keyboard handling: the
  `interactive-widget=resizes-content` viewport meta key (Android)
  and the visual-viewport inset listener (iOS) - see the mobile
  keyboard Gotcha in [chat](../../dev/chat.md).

## Preconditions

- A real phone, or a desktop browser in device-emulation mode with
  a virtual keyboard (emulation does not reproduce the OS keyboard
  overlay faithfully - a real device is the only trustworthy
  environment for this case).
- The app deployed somewhere the phone can reach (hosted project,
  or the local stack exposed on the LAN). Signed in, with a
  conversation open.
- Ideally run once on Android (Chrome) and once on iOS (Safari).
  The two platforms take entirely different code paths.

## Steps

1. Open a conversation and tap the composer textarea so the
   on-screen keyboard opens.
2. Observe the composer position while the keyboard is up.
3. Type a few words, then switch to another app (or another
   browser tab) WITHOUT dismissing the keyboard.
4. Switch back to nak. If the OS restored the keyboard, observe
   the composer; if it dismissed the keyboard, tap the textarea
   and observe again.
5. Dismiss the keyboard (back gesture on Android, "done"/tap-away
   on iOS). Observe the layout.
6. Rotate the device to landscape and back with the keyboard open.

## Expected

- (1-2) The composer sits fully visible directly above the
  keyboard. The message list shrinks; the keyboard never paints
  over the textarea or the send button.
- (3-4) On return with the keyboard restored, the composer is
  above the keyboard - not hidden underneath it - without needing
  to re-tap the textarea. This is the regression this case exists
  for.
- (5) The layout returns to full height with no dead band where
  the keyboard was, and no lingering upward shift of the top bar.
- (6) After the rotation round-trip the layout is correct for the
  final orientation; no half-height or over-height shell.

## Cleanup

None - the case mutates no data.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-08-24 | - | - | not run | Authored in a cloud session (no phone attached). Baseline before the fix, per the bug report: returning to the app with the keyboard open left the keyboard drawn over the composer on Android Chrome. iOS behavior unverified - the author has no iOS device. |
