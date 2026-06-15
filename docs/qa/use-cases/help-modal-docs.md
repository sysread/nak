# Help modal: renders user docs and intercepts links

## Covers

The in-app Help modal ([dev: help](../../dev/help.md)): it renders the
end-user manual under `docs/user/`, opens on `README.md`, navigates
internal `.md` links in-place (with a KITT Scanner transition), opens
external links in a new browser tab, and scrolls to heading anchors
within a doc.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user
  (`dev@nak.local` / `devpass123`).
- The conversation drawer is reachable (the leftmost footer icon is the
  Help button).
- No special data seeding needed - the docs are bundled at build time,
  so the Help content is identical in every environment.

## Steps

1. Open the conversation drawer and click the leftmost footer icon
   (titled `Help`).
2. Observe the doc that loads first and the header breadcrumb.
3. In the rendered page, click the internal link
   `Getting started` (an `./getting-started.md` link in the Contents
   list).
4. Use the browser Back button once.
5. Navigate to the `Cookbook` page (click the `Cookbook` link in the
   Contents list), then click the external `Cooklang` link
   (`https://cooklang.org/...`) in that page's body.
6. Return focus to the Help modal, then click any in-page heading link
   or a link of the form `./page.md#section` so the target is an anchor
   within a doc.
7. Close the modal with the top-right `×` button.
8. Re-open Help, then press the `Escape` key.
9. Re-open Help, then click the dimmed backdrop area outside the modal
   shell.

## Expected

- (1-2) The Help modal opens over the chat view and lands on the manual
  index; the header reads `Help > README.md` and the body renders the
  "Nak - User Guide" content (formatted markdown, not raw text).
- (3) The modal stays open and the content swaps in-place to the
  Getting started page; a Scanner animation plays during the
  transition and the breadcrumb updates to `Help > getting-started.md`.
  No new browser tab opens.
- (4) Browser Back returns the modal to the index page in-place; the
  breadcrumb returns to `Help > README.md`.
- (5) The Cookbook page loads in-place (breadcrumb `Help >
  cookbook.md`), and clicking the Cooklang link opens cooklang.org in a
  NEW browser tab; the Help modal itself stays open and unchanged on
  the Cookbook page.
- (6) Clicking an anchor link scrolls the current doc to the matching
  heading without swapping the page or opening a tab; the breadcrumb
  doc name does not change for a same-page `#section` click.
- (7) The `×` button closes the modal and returns to the chat view.
- (8) Pressing `Escape` closes the modal and returns to the chat view.
- (9) Clicking the backdrop outside the modal shell closes the modal;
  clicking inside the shell (on text, links, or the header) does NOT
  close it.

## Cleanup

- Close the Help modal if it is still open.
- Close the cooklang.org browser tab opened in step 5.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
