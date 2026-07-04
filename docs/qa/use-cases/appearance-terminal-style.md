# Appearance: terminal UI style across themes, reload, and sync

> Written alongside the feature's first implementation. Not yet
> executed - run it and start the results log.

## Covers

The third theme axis ([dev: settings](../../dev/settings.md),
"Theme lifecycle"): the Style picker in Settings > Appearance,
the `data-style` attribute on `<html>`, live-apply + rollback,
the localStorage boot cache (including legacy two-field blobs),
and Supabase persistence of `profiles.settings.uiStyle`.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev
  user (`dev@nak.local` / `devpass123`).
- A thread with at least one user message, one assistant reply,
  and one assistant error bubble visible (send a message with the
  network cut to manufacture the error, or reuse an old thread
  that has one).
- Browser devtools open on the Elements panel, `<html>` node
  pinned, plus Application > Local Storage for `nak:theme:v1`.

## Steps

1. Open Settings > Appearance. Confirm a **Style** section sits
   between Mode and Accent with two options, Soft (selected) and
   Terminal.
2. Click **Terminal**. Watch the app restyle live, no reload.
3. Inspect `<html>`: `data-style="terminal"`. Inspect
   `nak:theme:v1`: three `|`-separated fields ending `terminal`.
4. Visual sweep in dark mode: corners square everywhere (buttons,
   cards, inputs, pills); chat bubbles have no box border but a
   2px left bar (accent on user, grey on assistant, red on the
   error bubble); the page is true black with visibly stepped
   sidebar/card fills; the sidebar search input reads as a lighter
   block, not an invisible field; spinners and status dots stay
   round.
5. Flip color mode Light and Dark; flip through a couple of
   accents. Terminal styling holds in both modes, accents recolor
   the user-bubble bar.
6. Open a floating layer (thread-row overflow menu, a settings
   modal over chat): flat, no drop shadow, crisp 1px edge.
7. Reload the page. No flash of rounded-then-square: terminal
   styling is present from first paint (boot script).
8. In a second browser (or profile), sign in fresh: terminal
   arrives via Supabase settings sync.
9. Legacy-cache path: in devtools set `nak:theme:v1` to
   `dark|red` (two fields), reload. App boots dark/red/Soft, no
   errors.
10. Switch back to **Soft**. Everything rounds again; both
    storage locations update.

## Expected

- Style applies live on click and survives reload with no flash
  of the other style.
- `data-style` mirrors the picker; cache carries three fields;
  `profiles.settings.uiStyle` holds `terminal` (check via the
  Supabase SQL editor or `mise run dev-sql`:
  `select settings->>'uiStyle' from profiles;`).
- Terminal + light and terminal + dark both keep text readable
  (muted text included) on every surface.
- No layout shift when toggling styles: bordered elements keep
  their 1px slot (borders go transparent, not zero-width); chat
  bubbles shift at most 1px from the 2px left bar.
- Soft remains the default for fresh accounts and legacy caches.

## Cleanup

- Set Style back to Soft if the dev profile is shared.
- Restore `nak:theme:v1` by picking any theme in Settings.

## Results log

| Date | Env | Commit | Result | Notes |
|---|---|---|---|---|
| - | - | - | - | Feature just built; no runs. |
