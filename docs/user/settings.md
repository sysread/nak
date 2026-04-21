# Settings overview

Everything configurable lives behind the gear icon in the drawer
footer. The Settings modal has six panes, each with its own Save
behavior.

## Opening settings

## The six panes

### API keys

See [Security model](./security.md) for how keys are stored.

### AI

Covered in detail on [Models & reasoning](./models.md).

### Appearance

Covered in detail on [Appearance](./appearance.md).

### Export

Covered in detail on [Export & import](./export-import.md).

### Security

Covered in detail on [Security model](./security.md).

### About

Shows which build of Nak your browser is running — a short commit
fingerprint plus the date and time the build was produced — and
whether a newer deploy is available.

- **Version** is the seven-character commit hash of the build you're
  running. The same string that identifies the commit on GitHub.
- **Built** is the timestamp the build step ran (not when you
  installed it). Useful for answering "is this build from today?".
- **Status** shows "Up to date" most of the time and flips to
  "Update available" when a new deploy has landed.
- **Check for updates** asks the service worker to look for a fresh
  deploy without reloading. If one's found, the button flips to
  **Reload to update** and a matching banner appears in the
  top-right of the window.

You don't usually need to open this pane to get the prompt — the
top-right banner appears on its own when a new version is ready.
This pane is just the way to check on demand, or to confirm which
build you're actually running if a feature seems missing.

Clicking **Reload to update** swaps in the new build and reloads
the page. Any unsent message in the composer is lost, but your
conversation history (stored in Supabase) is not affected.

## Where to go next

- [Models & reasoning](./models.md)
- [Appearance](./appearance.md)
- [Security model](./security.md)
- [Export & import](./export-import.md)

---
Back to the [index](./README.md).
