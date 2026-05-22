# Settings overview

Everything configurable lives behind the gear icon in the drawer
footer. The Settings modal has seven panes, each with its own Save
behavior.

## Opening settings

## The seven panes

### API keys

Update your Supabase and Venice credentials, and download a JSON
copy of those credentials for re-import on another browser. See
[Security model](./security.md) for how keys are stored locally,
and [Export & import](./export-import.md) for the export/import
workflow itself.

### AI

Covered in detail on [Models & reasoning](./models.md).

### Appearance

Covered in detail on [Appearance](./appearance.md).

### Usage

A date-ranged snapshot of what your Venice API key has been
spending. Pick a **From** and **To** date, hit **Refresh**, and the
pane pulls your billing ledger from Venice and groups it by model.
Each row shows a horizontal bar scaled by total tokens
(prompt + completion), the token count as a compact label (e.g.
`72k`, `1.2M`), and a pill with the raw billed amount.

- The bars are measured in **tokens**, not money. A cheap-but-chatty
  model shows a long bar with a small pill; an expensive-but-concise
  model shows a short bar with a bigger pill.
- Bar colors shade from blue (a quiet model) through green
  (typical) to red (your heaviest hitter for this range) based on
  each row's token count relative to the median of the rows
  shown. The gradient is driven by how each bucket compares to
  the median on a log scale, so one runaway workload stands out
  in red without flattening everything else into a single shade.
- The last 7 days are refreshed in the background while the app
  is unlocked, so opening the pane usually shows numbers right
  away. If the cached view is more than 15 minutes old when you
  land on the pane, Nak kicks off a fresh fetch automatically.
  Change the dates and click **Refresh** to re-fetch a custom
  range. While a refresh is in flight, a thin progress bar appears
  below the controls. It animates as an indeterminate marching
  pill until Venice returns the first page of data (the slow
  step - the server computes the page count there), then flips to
  a determinate fill and the **Refresh** button label adds a
  `Loading… N/M` page counter as the rest of the pages arrive.
- Next to each currency's total spend pill sits a dashed-outline
  `$X/day` pill that divides the total by the inclusive day count
  of the picked range. A weeklong window's spend reads both as the
  headline figure and as the daily run rate it implies.
- Spend is always dollar-formatted, e.g. `$0.07`. Rows billed in
  credits instead of cash (VCU, DIEM, or bundled credits) render
  as muted/grey pills so your eye skips past them to the cash
  charges — hover for a tooltip that spells out which kind of
  credit paid for the row. If you're on a mixed plan, a given
  model can show up twice, once per currency.
- Models that rounded to under a cent in this range are hidden —
  the dust rows didn't add signal and produced `$0.00` cells that
  looked like bugs.
- Numbers come from Venice's beta billing endpoint. The ledger can
  lag live traffic by a few minutes, so a just-sent message may not
  appear immediately.

### Security

Two rotations live here:

- **Master password** - the passphrase that unlocks your encrypted
  config blob in this browser. Re-encrypts locally; does not touch
  Supabase.
- **Account password** - the password you use to sign in to your
  Supabase account. Nak re-verifies your current password before
  updating, then calls Supabase to set the new one.

Both require the current password and enforce an 8-character
minimum on the new one. Covered in more detail on
[Security model](./security.md).

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
