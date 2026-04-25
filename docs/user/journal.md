# Journal

The Journal is Nak's daily diary. Each day has up to two entries:

- **Automatic** — written by a background journaler after your
  conversations settle. Covers feelings, self-reflection,
  interpersonal dynamics, and neurodivergence / identity themes
  that surface as you chat. Skips purely technical Q&A.
- **User Entry** — yours. Plain Markdown. Whatever you want to
  record for that day.

Both are searchable (synonyms and paraphrases work), exportable as
Markdown, and can be deleted on demand.

Open the Journal from the **Journal** tab in the conversation
drawer, or the **Open journal** button at the bottom of that
tab. Each entry in the drawer jumps straight to its day.

## The list view

The modal opens on a reverse-chronological list, grouped by date.

- **Search** — start typing to filter. The same pipeline the
  assistant uses for its `journal_search` tool runs here:
  meaning matches first, substring matches fall back.
- **Today** — jumps to today's day view.
- **Export all (.zip)** — downloads every entry as a ZIP of
  Markdown files (`journal/yyyy-mm-dd.md`, one per day, each
  containing both the automatic and user sections when present).

Click any day's header to open the daily view.

## The daily view

Two stacked cards per day:

1. **Automatic** (top, grey) — what the journaler wrote. Chips
   show the mood / topics it picked up on. Read-only by design;
   the journaler re-reads this card every time it updates the day
   so your edits would be overwritten.
2. **You** (bottom) — your own entry. Markdown renders in place
   when saved. **Edit** reopens the form; **Delete** removes the
   entry cleanly.

Navigate days with **‹** / **›** or jump back to **Today**.

Each card has an **Export .md** button for a single-day
single-card Markdown download.

### Writing your own entry

On any day, click **Write an entry** under the automatic card
(or **Edit** if you already have one). The compose form has:

- a Markdown body (the only required field),
- an optional **mood** tag,
- optional comma-separated **topics** (chips),
- optional comma-separated **people**.

**Save entry** writes; **Cancel** discards. Saves show up
immediately in the list and the drawer.

### Deleting an automatic entry

Deleting an automatic entry also marks its **source conversations**
as excluded from journaling. The journaler won't regenerate the
entry from those same conversations - you'd see the same content
re-appear otherwise. User entries delete cleanly with no
side-effect.

## Settings

The **Journal** pane in Settings controls:

- **Automatic entries** — toggle the background journaler on or
  off. User entries are unaffected either way. Turning this off
  stops the worker immediately; any existing automatic entries
  stay.
- **Day boundary** — the IANA timezone that determines which day
  a conversation lands on. Default is whatever your browser
  reports. A late-night message in Los Angeles should land on
  that calendar day, not whatever UTC thinks.
- **Export all (.zip)** — same button as the list view, surfaced
  in Settings for users who never open the modal.

## How the assistant knows about your journal

At the start of every new conversation, today's automatic entry
(if any) is injected into the assistant's per-turn context so
replies can refer back to what you've been working through. It's
not announced; the assistant just has context.

If you reference something journal-worthy, the assistant may reach
into the journal via its `journal_search` tool to find a related
prior entry. That's opt-in per-thread via the **Journal**
toolbox in the chat composer's tool picker.

See also: [Memory](./memory.md), [Background](./background.md),
[Settings](./settings.md).
