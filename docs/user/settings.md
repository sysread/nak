# Settings overview

Everything configurable lives behind the gear icon in the drawer
footer. The panes are ordered by how close their subject is to you:
the app itself first, then how Nak looks and what it remembers, then
the assistant, then your account and credentials at the end. Each
pane saves on its own.

## Opening settings

## The panes

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

### Appearance

Covered in detail on [Appearance](./appearance.md). Also holds the
**Default log level** for the Logs drawer.

### Memory

A single toggle for the **memory librarian** - the autonomous agent
that tidies your memory store on a schedule, merging duplicates,
filling in relationships, and retiring entries that contradict newer
ones. It runs in the background on your Supabase project, whether or
not the app is open. Turning it off leaves your existing memories
untouched and stops the scheduled runs; the manual run buttons in
the Memories panel keep working. See [Memory](./memory.md).

### Wiki

Two independent toggles plus a reset:

- **Automatic articles** - lets the autonomous agent write and
  update wiki articles on its own. On by default for new accounts;
  manual edits and the per-article "ask agent to update" button
  still work when it's off.
- **Librarian** - the periodic pass that deduplicates articles,
  fact-checks them, and tightens their boundaries. Independent of
  the automatic-articles toggle.
- **Reset** - permanently deletes every wiki article and the
  per-conversation wiki state. Irreversible; you're asked to
  confirm first.

Covered in detail on [Wiki](./wiki.md).

### AI

Covered in detail on [Models & reasoning](./models.md). Also holds
the **Emphasis markdown** scan-aid toggle, **reply notifications**
(an optional desktop/mobile ping when a reply lands while you're
looking elsewhere), and the system-prompt library.

### Usage

A date-ranged snapshot of what the project's Venice API key has
been spending. The key is held in your Supabase project's
`app_config` table - all browser callers reach Venice through an
edge function that holds the key server-side. Pick a **From** and
**To** date, hit **Refresh**, and the pane pulls the billing
ledger from Venice via that function and groups it by model.
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
- The last 7 days are fetched the first time you open this pane
  in a session and cached for 15 minutes; opening it again after
  that triggers a fresh fetch automatically. Change the dates and
  click **Refresh** to re-fetch a custom range. While a refresh is
  in flight, a thin progress bar appears
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

Rotates the password you use to sign in to your Supabase account.
Nak re-verifies your current password before updating, then calls
Supabase to set the new one. The form requires the current
password and enforces an 8-character minimum on the new one.
Covered in more detail on [Security model](./security.md).

### API keys

Update the **Supabase URL** and **Supabase publishable key** that
Nak uses to talk to your project. There's also an **Export**
subsection that downloads the two values as a JSON file for
re-import on another browser. The Venice API key isn't shown
here - it lives in your Supabase project's `app_config` table
and the edge function reads it server-side, so there's nothing
to enter or rotate from the browser. See
[Security model](./security.md) for how the Supabase keys are
stored locally, and [Export & import](./export-import.md) for
the export/import workflow itself.

## Where to go next

- [Models & reasoning](./models.md)
- [Appearance](./appearance.md)
- [Memory](./memory.md)
- [Wiki](./wiki.md)
- [Security model](./security.md)
- [Export & import](./export-import.md)

---
Back to the [index](./README.md).
