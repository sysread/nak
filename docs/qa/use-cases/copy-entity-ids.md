# copy-entity-ids

The top-bar copy-ID buttons: with a conversation, recipe, or wiki
article open, a copy button beside the logs toggle puts the open
entity's UUID on the clipboard, for pasting into anything that needs
to reference the exact row (typically an AI agent with database
access). Covers the per-tab gating and the chats tab's mobile
overflow duplicate.

## Covers

- Top-bar copy-ID buttons for chats / recipes / wiki
  ([chat](../../dev/chat.md), `src/screens/Chat.svelte`)
- `<CopyButton>` bar sizing via the `class` + `size` props
  ([components](../../dev/components.md), `CopyButton.svelte`)

## Preconditions

- Local stack running via `mise run dev-start`; signed in as
  `dev@nak.local` / `devpass123`.
- At least one conversation, one recipe, and one wiki article exist.
- A way to inspect the clipboard (paste target), and the browser
  serving over localhost or HTTPS (the async clipboard API requires
  a secure context).

## Steps

1. Open a conversation on a desktop-width window (>720px). Find the
   copy button (two overlapping pages) at the top right, between
   the download-transcript button and the logs toggle. Click it and
   paste somewhere.
2. Compare the pasted value against the `cid` query parameter in
   the address bar.
3. Narrow the window below 720px. Confirm the standalone copy
   button is gone, then open the three-dot overflow menu and choose
   **Copy conversation ID**. Paste.
4. Restore desktop width. Switch to the Recipes tab without opening
   a recipe. Observe the top bar. Open a recipe and click the copy
   button next to the logs toggle. Paste, and compare against the
   `recipe` query parameter.
5. Switch to the Wiki tab without opening an article (the changelog
   landing view). Observe the top bar. Open an article and click
   the copy button next to the logs toggle. Paste, and compare
   against the `wiki_article_id` query parameter.
6. On any of the three, click the copy button and watch it: the
   glyph should flip to a checkmark for about 1.5 s, then flip
   back.
7. Eyeball the button against its top-bar neighbors (download
   button, logs toggle): same box size, same border treatment.

## Expected

- Step 1-2: the paste is a UUID matching the `cid` parameter
  exactly.
- Step 3: no standalone copy button below 720px; the overflow entry
  copies the same UUID.
- Step 4: no copy button while no recipe is open; with one open,
  the paste matches the `recipe` parameter.
- Step 5: no copy button on the changelog view; with an article
  open, the paste matches the `wiki_article_id` parameter.
- Step 6: checkmark flash on success. (No flash = the clipboard
  write failed; that's the only failure signal by design.)
- Step 7: the copy button reads as one family with its neighbors -
  30px box, matching border. A visibly smaller button means the
  bar-sizing props (`class="secondary icon-btn"`, `size={16}`)
  were dropped.

## Cleanup

- None. The buttons only read state.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-08-14 | local dev-start stack | af0c96d9 (+ uncommitted feature tree) | pass | Playwright-driven: all three tabs copy the exact route UUID; chats overflow entry works at 400px and the standalone hides; no button on recipe-list / wiki-changelog views; 30x30 box parity confirmed after the class/size fix (initial 23px undersize caught and fixed in the same session). |
