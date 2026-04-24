# Help

In-app Help modal that renders the user-facing docs under
`docs/user/`. GitHub-renderable markdown bundled at build time,
rendered through the shared Markdown pipeline, with link
interception so internal `.md` links navigate in-place and
external links open in a new tab.

## Role in the app

The **Help** button in the conversation drawer footer (leftmost
icon) opens a modal that loads `docs/user/README.md` as the
landing page. Clicks on internal `.md` links navigate within
the modal with a KITT Scanner during the transition; external
links open in a new browser tab. Heading anchors (`#section`)
scroll within the current doc.

Dev-facing docs under `docs/dev/` are **not** rendered in-app —
they're GitHub-only as far as the Help modal is concerned. The
Help modal's glob at the top of `docs.ts` is scoped to
`docs/user/**/*.md` for that reason. A parallel non-Help glob in
the same file (`docs/dev/**/*.md`, exposed via `listDevDocs` /
`loadDevDoc`) feeds the `research_docs` tool's
`include_internal_dev_docs` opt-in path — that's a flat-corpus
bundle for a sub-completion, not rendered anywhere. See
`./tools.md`.

## Files

- `src/lib/docs.ts` — bundle loader. `import.meta.glob` maps
  every `/docs/user/**/*.md` file into a lazy string-loader
  thunk; exports `hasDoc`, `loadDoc`, `resolveDocPath`,
  `isExternalHref`. A parallel glob for `docs/dev/**/*.md`
  with matching `listDevDocs` / `loadDevDoc` exports is not
  used by the Help modal — it exists for the `research_docs`
  tool's dev-docs opt-in path.
- `src/screens/Help.svelte` — the modal. Renders via
  `<Markdown>`, intercepts internal link clicks, shows
  `<Scanner>` during transitions, assigns heading ids for
  hash navigation, demotes unreachable anchors to `<code>`.
- `src/screens/Chat.svelte` — button + phase branch
  (`{:else if showHelp} <Help onClose={...} />`).
- `docs/user/**/*.md` — the content.
- `src/styles.css` — `.help-shell`, `.help-header`,
  `.help-content`, `.help-close`, `.help-loading` (parallel
  to `.settings-*`).

## Entry points

- **Help button click** — `Chat.svelte` flips `showHelp =
  true`. The modal mounts on the current path (`README.md`)
  and loads via `loadDoc`.
- **Internal link click** — delegated handler on the
  `.help-content` wrapper. The handler classifies hrefs:
  `#hash` → preventDefault + scroll; external (scheme or
  protocol-relative) → let browser open new tab; relative →
  preventDefault + `resolveDocPath` + navigate within modal.
- **Back button** — pops the `history` stack; navigates to
  the previous doc. Disabled when history is empty.
- **Escape / backdrop click / close button** — all call
  `onClose()`, which `Chat.svelte` sets to
  `() => (showHelp = false)`.

## Data model

- **Glob map** — `import.meta.glob('/docs/user/**/*.md',
  { query: '?raw', import: 'default' })` returns
  `Record<string, () => Promise<string>>`. Non-eager — each
  doc is its own lazy chunk, so a doc only lands on the main
  thread when the user navigates to it.
- **Current doc state** — `currentPath` (relative to
  `docs/user/`), `history` (back stack), `content` (raw
  markdown), `loading`, `error`, `pendingHash`. All `$state`
  runes.
- **Rendered DOM** — held via `bind:this={contentEl}` on the
  content wrapper. A post-render `$effect` walks headings
  (assigns slug ids), walks anchors (demotes unreachable
  ones), and performs the scroll-to-hash.

## Contracts

- `hasDoc(path): boolean` — `path` is relative to
  `docs/user/` (e.g. `'memory.md'`, `'README.md'`). True iff
  the glob map has that key.
- `loadDoc(path): Promise<string>` — returns raw markdown.
  Throws `Error` if `!hasDoc(path)`. Callers are expected to
  have classified via `resolveDocPath` first; a miss here
  indicates a bug, not user-input error.
- `isExternalHref(href): boolean` — true if `href` has a
  scheme (matches `/^[a-z][a-z0-9+\-.]*:/i`) or starts with
  `//`. Classifies before `resolveDocPath`.
- `resolveDocPath(currentPath, href): ResolvedDoc | null` —
  resolves a relative href against the current doc's
  directory via `new URL(href, 'https://nak.docs.invalid' +
  DOC_PREFIX + currentPath)`. Returns `null` if the resolved
  path escapes `docs/user/` (`pathname` doesn't start with
  `/docs/user/`) or isn't a known doc (`!hasDoc`). The host
  check is belt-and-braces: `isExternalHref` is expected to
  catch anything with a scheme before this function runs.
- `listDocs(): string[]` — every known doc path, sorted.
  Not used by the modal today; exposed for test + future
  uses.

## Interactions with other features

- **Components** — uses `<Markdown>` for rendering and
  `<Scanner>` for the transition state. No shared code path
  beyond those components. See `./components.md`.
- **Chat** — `Chat.svelte` hosts the Help button + phase
  branch. No other coupling — Help is self-contained. See
  `./chat.md`.
- **Build-deploy** — `import.meta.glob` causes Vite to
  emit one lazy chunk per doc file in the build. The PWA
  precache automatically covers those chunks, so the Help
  modal works offline. See `./build-deploy.md`.

## Gotchas

- **Internal links MUST start with `./` or `../`.** Bare
  relative hrefs (`[page](foo.md)`) fail DOMPurify's
  `ALLOWED_URI_REGEXP` and get their href stripped silently.
  The anchor still renders (styled like a link) but clicks
  do nothing. This convention is documented in the repo's
  `CLAUDE.md` under "User-facing documentation" — enforce it
  in review. The post-render demotion pass (see next bullet)
  catches the failure mode as a usability fix, but authors
  should still prefix correctly.
- **Unreachable anchors are demoted to `<code>`.** The
  post-render effect walks every `<a>` in `.md` and
  replaces any whose href is absent (DOMPurify-stripped), or
  whose relative href doesn't resolve to a bundled doc, with
  a `<code>` carrying the same text. Keeps the path reference
  visible in prose but removes the false navigation
  affordance. Without this pass, a stray `../dev/foo.md`
  link would wipe the modal content with an error banner and
  lock out the back button.
- **DOMPurify sets `target="_blank"` on every `<a>`.** The
  internal-link interception works by preventDefault'ing the
  click before the new tab opens. Without preventDefault a
  relative `.md` click would open a new browser tab with an
  unresolved URL.
- **Heading ids are assigned post-render.** `marked`'s
  default renderer doesn't add ids to `<h1>`-`<h6>`; the
  post-render effect walks them, slugifies `textContent`,
  and assigns a unique id. `CSS.escape` wraps the hash
  before `querySelector` to survive slugs with unusual
  characters.
- **`pendingHash` is cleared after one scroll.** Otherwise
  a late-arriving highlight.js grammar (which re-fires the
  render effect) would re-scroll to the hash after the user
  had scrolled away. One scroll per navigate is the
  contract.
- **Scroll-to-top on doc change.** When a navigate lands with
  no hash, the post-render effect calls
  `contentEl.scrollTo({top:0, left:0})` so the new doc
  starts from the top instead of inheriting the previous
  doc's scroll position.
- **Modifier-clicks fall through.** Ctrl / Cmd / Shift / Alt
  on an internal link returns from the handler early so the
  browser's native "open in new tab" / "save link as"
  behavior works for users who want it.
- **The docs tree is in `docs/user/`, not `src/`.** Vite
  resolves `/`-prefixed glob patterns against the project
  root, which is what makes this work. If you move the docs
  into `src/`, the glob pattern changes accordingly (and the
  paths in `hasDoc` / `loadDoc` need the new prefix).
- **`docs/dev/` is intentionally excluded.** The glob is
  `/docs/user/**/*.md`. Dev docs are GitHub-only. If you
  ever want dev docs in-app, it's a new feature (new glob,
  new modal entry point, new resolver logic) — not a tweak
  to this one.

## Where to go next

- `./components.md` — `<Markdown>` is the renderer; `<Scanner>`
  is the transition spinner.
- `docs/user/README.md` — the landing page this modal opens
  on.
- `./chat.md` — where the Help button is hosted.
