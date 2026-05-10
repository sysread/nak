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
  Q&A. The journaler waits until the day after a conversation's
  most recent message before writing or updating its entry, so
  an in-progress chat has room to finish before it gets a page.
  If you've filled in **Name** and / or **Location** under
  Settings -> AI -> *About you*, the journaler picks those up so
  new entries refer to you by name and ground location-specific
  context. Leaving the fields blank keeps entries written in the
  generic third-person "User" voice.

Both are exportable as Markdown and deletable on demand.

## Opening the Journal

The conversation drawer has a **Journal** tab. It shows one row
per day - newest first - with a count of how many entries that
day holds. Clicking a day opens the modal on that day's view.
The drawer's search box filters the listed days by content,
mood, or topic. The footer's **Open journal** button opens the
modal on today's day.

The modal itself is daily-view-only - one day at a time, with
prev / next / Today buttons in the header. Closing the modal
(× or Escape) returns you to the drawer.

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
- **Regenerate / thumbs up / thumbs down** — on automatic
  entries, three emoji-labeled buttons in the action row, sitting
  to the right of the download button. The regenerate button (🔄)
  asks the journaler to write a different take on the same
  conversation - see
  [Regenerating an automatic entry](#regenerating-an-automatic-entry)
  below. Thumbs-up (Looks good) tells the journaler "this kind of
  conversation IS worth journaling"; thumbs-down (Delete) removes
  the entry, marks the source conversation as excluded from
  future journaling, AND tells the journaler "this kind is NOT
  worth journaling." See
  [Teaching the journaler what to keep](#teaching-the-journaler-what-to-keep)
  below. Thumbs-up stays visible after a click and picks up a
  green border to show the vote took; re-clicking is a no-op.

Navigate days with **‹** / **›** or jump back to **Today**.

Each entry has a **download** button (⬇️) for a single-entry
Markdown download.

### Writing your own entry

On any day, click **Write an entry** at the bottom. The compose
form has:

- a Markdown body (the only required field),
- an optional **mood** tag,
- optional comma-separated **topics** (chips),
- optional comma-separated **people**.

**Save entry** writes; **Cancel** discards. Saves show up
immediately in the day view and the drawer's day index.

Writing your own entry counts as a strong **ham** signal - the
fact that you took the time to record it tells the spam filter
you find this kind of content journal-worthy, so the entry's
words feed straight into the model's ham vocabulary. Deleting
the entry rescinds that vote.

### Regenerating an automatic entry

The 🔄 button on an automatic entry asks the journaler to write
a different take on the same conversation. Click it and the
original card picks up a red outline (the same "marked for
replacement" cue you get on chat messages when you regenerate a
turn) while a proposal card appears just below, showing a
spinner first and then the journaler's new version. You can
read both side by side, then choose:

- **Accept** replaces the original entry with the proposal. The
  original card fades out and the new content snaps in.
- **Try again** re-runs the journaler against the original entry
  for another fresh angle. Each try ignores the previous proposal,
  so retries don't compound.
- **Cancel** discards the proposal and restores the original
  entry untouched.

Nothing is saved until you click Accept. Your thumbs-up vote,
the entry's spam-filter training, and the source conversation's
link to the entry are all preserved when you accept.

Regenerate runs the journaler with the worthy / not-worthy gate
bypassed - clicking the button is itself a "yes, I want an entry
for this" signal, so the model is told to produce one regardless
of whether it would have on its own.

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

- **Thumbs-down (Delete)** trains a per-user spam filter against
  the source conversation. The next conversation that reads
  similarly is more likely to be skipped.
- **Thumbs-up (Looks good)** trains the same filter in the
  opposite direction. Conversations that read like ones you've
  approved get a stronger nudge toward journaling.
- **Writing your own entry** counts as ham too. The entry's text
  itself feeds the model rather than a conversation transcript -
  your own framing of what's worth keeping is the cleanest
  positive example we have.

If you change your mind - thumbs-up an entry, then later delete
it - the thumbs-up vote is rescinded before the delete trains the
filter as spam. The conversation's words contribute one clean
negative signal instead of cancelling out at zero.

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
- **Reset journal data** — sits directly below the Automatic
  entries toggle. Permanently deletes every journal entry (both
  automatic and your own) and clears the per-conversation
  journaling state so the worker re-evaluates your threads from
  scratch. Irreversible. There's a confirmation prompt. If the
  automatic toggle is still on, the journaler will begin
  rewriting entries on its next sweep — flip it off first if you
  want a permanent wipe. Export your journal first if you might
  want it back.
- **Day boundary** — the IANA timezone that determines which day
  a conversation lands on. Default is whatever your browser
  reports. A late-night message in Los Angeles should land on
  that calendar day, not whatever UTC thinks.
- **Export all (.zip)** — downloads every entry as a ZIP of
  Markdown files (`journal/yyyy-mm-dd.md`, one per day, each
  containing every entry from that day).

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
