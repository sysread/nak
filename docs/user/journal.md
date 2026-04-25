# Journal

The Journal is Nak's daily diary. Each day can have any number of
entries:

- **User entries** — yours. Plain Markdown. Whatever you want to
  record for that day.
- **Automatic entries** — written by a background journaler after
  your conversations settle. One per conversation that the
  journaler decided was worth keeping. Covers feelings,
  self-reflection, interpersonal dynamics, and neurodivergence /
  identity themes that surface as you chat. Skips purely technical
  Q&A.

Both are searchable (synonyms and paraphrases work), exportable as
Markdown, and can be deleted on demand.

Open the Journal from the **Journal** tab in the conversation
drawer, or the **Open journal** button at the bottom of that tab.

## The list view

The modal opens on a reverse-chronological list, grouped by date.

- **Search** — start typing to filter. The same pipeline the
  assistant uses for its `journal_search` tool runs here:
  meaning matches first, substring matches fall back.
- **Today** — jumps to today's day view.
- **Export all (.zip)** — downloads every entry as a ZIP of
  Markdown files (`journal/yyyy-mm-dd.md`, one per day, each
  containing every entry from that day).

Click any day's header to open the daily view.

## The daily view

A day is rendered as a single column. Your own entries appear
first, then the automatic entries, in the order the conversations
they're derived from started. Each entry is separated from the next
by a curtain-rod divider, so reading top-to-bottom matches how the
day unfolded.

- **Your entries** — Markdown renders in place. **Edit** reopens
  the form; **Delete** removes the entry cleanly.
- **Automatic entries** — show a centered conversation title
  above the body that links straight back to the source
  conversation. The journaler re-reads this entry every time it
  updates the same thread, so your manual edits to an automatic
  entry would be overwritten - delete instead, then write your own
  user entry if you want a different framing.
- **Looks good** — on automatic entries, a button that tells the
  journaler "this kind of conversation IS worth journaling." See
  [Teaching the journaler what to keep](#teaching-the-journaler-what-to-keep)
  below for what this does. One click per entry; once marked, the
  button is replaced by a quiet **Marked good** tag.

Navigate days with **‹** / **›** or jump back to **Today**.

Each entry has an **Export .md** button for a single-entry
Markdown download.

### Writing your own entry

On any day, click **Write an entry** at the bottom. The compose
form has:

- a Markdown body (the only required field),
- an optional **mood** tag,
- optional comma-separated **topics** (chips),
- optional comma-separated **people**.

**Save entry** writes; **Cancel** discards. Saves show up
immediately in the list and the drawer.

### Deleting an automatic entry

Deleting an automatic entry also marks its **source conversation**
as excluded from journaling. The journaler won't regenerate the
entry from that same thread - you'd see the same content re-appear
otherwise. User entries delete cleanly with no side-effect.

Deletion also feeds the spam filter; see the next section.

## Teaching the journaler what to keep

The journaler decides whether to write an entry from each settled
conversation. It's selective by design (the bar is "did this move
the user emotionally / relationally / identity-wise", not "did
anything happen"), but the model's defaults won't match every
user perfectly. Two signals shape its behaviour over time:

- **Deleting an automatic entry** trains a per-user spam filter
  against the source conversation. The next conversation that
  reads similarly is more likely to be skipped.
- **Looks good** on an automatic entry trains the same filter in
  the opposite direction. Conversations that read like ones you've
  approved get a stronger nudge toward journaling.

The classifier is a Naive Bayes model on the conversation's words,
stemmed so different inflections of the same word share signal
(English-only for now). The score is passed to the journaler as a
**soft hint**, not a gate - a conversation that pivots from
technical to emotional should still get journaled even if its
opening reads as spam to the prior. The journaler still applies
its own worthy / not-worthy judgment on the conversation as a
whole.

The hint is suppressed entirely until you've labeled at least 20
conversations as ham (Looks good) and 20 as spam (deleted). Below
that threshold the model would be too noisy to interpret. Until
then, the journaler runs on its built-in heuristics alone.

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

At the start of every new conversation, the day's automatic
entries (if any) are injected into the assistant's per-turn
context so replies can refer back to what you've been working
through. It's not announced; the assistant just has context.

If you reference something journal-worthy, the assistant may reach
into the journal via its `journal_search` tool to find a related
prior entry. That's opt-in per-thread via the **Journal**
toolbox in the chat composer's tool picker.

See also: [Memory](./memory.md), [Background](./background.md),
[Settings](./settings.md).
