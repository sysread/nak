# Wiki

The Wiki is a flat encyclopedia **about you** - your projects, the
people in your life, places you live or care about, things you're
learning or reading, work, hobbies, experiments. Every entry is a
titled article in encyclopedic third-person prose. There's no
nesting; everything sits at the same level and the drawer lists
articles alphabetically.

The wiki is a peer to Memory. Memories are atomic facts the
assistant references inline. Wiki articles are the longer-form
topical pages that cover what something IS - "the recipe project",
"Maya", "Lisbon trip planning". An article sits across many
conversations.

## Scope: about you, not about the world

The wiki is deliberately user-centric. Articles describe things in
your life. They do **not** describe generic topics that came up in
conversation. So:

**In scope** - article-worthy when discussed:

- Projects you are building, planning, or running.
- People in your life - family, friends, colleagues, contacts.
- Places you live, work, travel to, or care about.
- Things you are learning or reading - books, courses, papers,
  skills you are practising.
- Habits and experiments you are tracking - a running streak,
  a sourdough starter, an elimination diet.
- Your career, current job, prior roles, ongoing work.
- Hobbies and interests you have invested time in.

**Out of scope** - even if the conversation discussed them at length:

- General technical concepts, libraries, protocols, or frameworks
  not specific to one of your projects.
- World-knowledge topics: historical events, scientific concepts,
  geography.
- Public people you don't know personally - celebrities, authors of
  books you're reading, historical figures.
- News, current events.
- Tutorials and one-off help interactions.

When an external topic gets mentioned inside a user-centric article
(say, you're building an app whose name references a 1980s
file-transfer protocol), the agent will add a Markdown link to a
public source like Wikipedia rather than creating a separate
article. External topics are linked, never given their own pages.

Both the per-conversation agent and the librarian enforce this
scope. The librarian will delete out-of-scope articles it finds on
its periodic sweep, so any encyclopedic-but-not-about-you articles
that slipped through earlier should disappear over the next 12 to
24 hours.

## Opening the Wiki

Click the **Wiki** tab in the left drawer. The sidebar shows the
alphabetical listing with a search bar at the top; the main panel
opens whichever article you click.

When the Wiki tab is open with no article selected, the panel shows
an empty-state hint plus an "add a new one" link that opens the
inline create form.

## What goes in an article

Articles are encyclopedic - they read like Wikipedia lead paragraphs,
not chat replies. Third person, present tense, neutral. They're meant
to summarize what you'd want to come back to later, not transcribe a
conversation.

Each article has just two fields:

- **Title** - the topic name. This is the alphabetical sort key in
  the drawer and must be unique. The title cap is 200 characters.
- **Content** - the article body, in Markdown. Capped at 16,000
  characters.

## Searching

The search bar above the listing filters the drawer in place. It uses
the same semantic-search pipeline the assistant uses for `wiki_search`
(see "How the assistant uses the wiki" below) - typing a phrase finds
articles by meaning, not just by literal substring. Substring matches
are merged in too, so an article you wrote ten seconds ago (before the
scheduled embedding pass has caught up) still surfaces.

Clearing the search returns the alphabetical listing. That listing
loads in pages as you scroll - more articles load automatically as
you reach the bottom, so a large wiki never stops at a fixed cap.
Search is separate: it shows the closest matches without paging.

## Adding an article

Open the **Wiki** tab with no article selected (the default view is
the [changelog](#changelog)) and click **+ New article** in the
changelog header. The inline form takes a title, content, and a
one-line **change message** (a git-style summary of why you're
adding the article - lands in the [changelog](#changelog)). **Save**
persists immediately and surfaces the new article in the panel.

Titles are unique per user. If you try to create an article with a
title that already exists you get a clear error and can either rename
the new draft or open the existing article and edit it.

## Editing

Open an article and click **Edit**. The view flips to a form with the
title, content, and a **change message** field. The form shows
"Unsaved changes" the moment you diverge from the stored row;
**Save** persists and flips the view back to the rendered article,
**Cancel** drops the draft.

The change message is required - it's the one-line entry the
[changelog](#changelog) shows next to this edit. Treat it like a git
commit summary: "Fix Maya's job title" rather than "edits". The
message clears back to blank after each successful save so a follow-
up edit writes its own message rather than inheriting the prior one.

Saving an article nulls its embedding - the scheduled embedding pass
will re-compute it within a few minutes. Search falls back to
substring matches in the meantime.

## Table of contents

Articles with two or more Markdown headings get a **Contents** outline
at the top of the panel, just below the title. Each entry is a link
to its heading in the body, with nested headings indented under their
parent. Clicking an entry smooth-scrolls the heading into view without
disturbing the surrounding chrome.

The outline is built from the article's own Markdown headings (`#`,
`##`, etc.) so it stays in sync with edits automatically - rewrite a
heading and the entry updates the next render.

Below the heading outline, the Contents box also links to the
article's appended sections that are present: **Sources**, **See
also**, and **Records**. These jump-links appear even when the body
has fewer than two headings (so a short article with records still
gets a quick way down to them) - so an article with no headings but a
populated Records section shows a Contents box with just the section
links. A bare article with no headings and none of those sections has
no Contents box at all.

## Deleting

Click **Delete** on the open article. A confirmation strip appears
with a required **change message** field; **Delete** is the
destructive action, **Cancel** dismisses the prompt.

Deletes are hard - the article doesn't move to a trash bin. If you
delete by mistake the easy recovery is to ask the assistant to
reconstruct it from the relevant conversations and call `wiki_create`,
or to recreate it manually. The deletion stays visible in the
[changelog](#changelog) with the title snapshot and the reason you
typed, so the audit trail survives even when the article doesn't.

## Asking the agent to update an article

Each article has an **Ask agent to update** button that opens an
instructions textarea. Type what you want the agent to do ("add a
sentence noting that Maya prefers green tea", "fix the date in
paragraph two", "rewrite the second paragraph for tone but keep the
facts") and click **Ask agent**.

The agent can change the article body **and** its
[records](#records) in one request. It sees the article's existing
records, so you can ask it to "log today's bake as a record", "fix
the date on the doctor-visit record", or "delete the duplicate
record from last week" - on its own or together with a body edit.

The agent runs on the spot and shows a preview. While the update is
open the article above picks up a red outline (the same "marked for
replacement" cue you get on chat messages when you regenerate a
turn). The preview shows the changed body (when the body changed) and
a list of any proposed record changes, each tagged **Add record**,
**Edit record**, or **Delete record**. You then have three choices:

- **Accept** - persist the agent's version: the body edit and every
  listed record change land together. The original fades out and the
  new content snaps in; the listing and the Records section reflect
  the changes.
- **Try again** - throw away the preview and run the agent again.
  Useful if the agent's interpretation didn't quite match what you
  wanted.
- **Cancel** - close the preview without changing anything.

The agent is told to do exactly what you ask AND to preserve every
fact already in the article unless you explicitly say to remove or
replace it. So "add a sentence" adds without rewriting; "rewrite the
second paragraph" rewrites only that paragraph; "fix the date in
paragraph 2" patches that single value. It only proposes record
changes you actually asked for - most body edits touch no records.

If your instructions don't actually require a change ("looks fine",
"no edits"), or are too ambiguous to act on without the agent
inventing facts, the agent emits a "no change applied" note with its
reasoning instead of a preview. You can Try Again with sharper
instructions or close the dialog.

## Records

Below every article is a **Records** section. Records are dated
entries that document a topic's *journey* - the specific events,
experiments, and observations along the way - while the article body
stays the *current state* (what's true now). The split keeps an
article from bloating into a chronological log while still preserving
the history: "baked an 80%-hydration loaf, too slack" is a record;
"the recipe settled on 75% hydration by mid-2026" is the article body.

Each record has:

- a **date** (the day the event happened, which can differ from when
  you logged it),
- a **Markdown body** describing what happened and what you learned,
  and
- optional **tags** for filtering.

What you can do in the Records section:

- **Add record** (the **+** icon in the Records header) - opens a
  compose form with a date picker (defaults to today), a Markdown
  content field, and a comma-separated tags field. Save to log it.
- **Filter** - narrow the list by a date range (From / To) and by a
  single tag.
- **Search** - the search bar runs a *semantic* search across the
  records on *every* article (not just this one), ranked by meaning
  rather than keywords. A hit that belongs to another article is
  marked "(other article)". Clear the search to return to this
  article's list.
- **Expand** - click a record row to read its full Markdown. The
  expanded view has **Edit**, **Export**, and **Delete** actions, plus
  the **files** and **linked records** controls below. A collapsed row
  shows a small **paperclip with a count** when the record has files
  attached, so you can spot the documented entries without expanding
  each one.
- **Export** - **Export** on a single record downloads it as a
  Markdown file (`yyyy-mm-dd-<slug>.md`). The **download** icon in the
  Records header downloads a ZIP containing the article as
  `article.md` plus every record under `records/`.

### Attaching files to a record

Expand a record and you'll find a small upload zone: **drop a file on
it, or click to pick one.** Images attach as thumbnails (click to open
the full size); other files - PDFs, scanned recipe cards - attach as
download links. A record can carry as many files as you like. This is
the place for the crumb photos and process shots that document an
experiment. Each file has an **x** to remove it.

Unlike chat attachments (which are reclaimed a month after a
conversation goes quiet), record files are **permanent** - they live
with the record for as long as it does. The assistant can also attach a
file you posted earlier in the chat to a record, and can read an
attached document when it looks at the record.

Attaching the **same file twice** to one record is a no-op - whether
you do it or the assistant does, Nak compares the file's contents (not
just its name) and keeps a single copy. So if the background agent
revisits a conversation it already logged, it won't stack a duplicate
of a photo it attached earlier.

### Linking records together

The same expanded view has a **"Link to a record..."** control: pick
another record and give the relationship a short **label** ("based on",
"supersedes", "same dough"). The link is directional and shows up on
both records - an arrow (`->` / `<-`) tells you which way it points.
This is how you express "attempt #3 is based on attempt #2 with more
hydration" as a navigable relationship instead of a sentence. The
**x** on a link row removes it.

Records are filled both by hand (the Add button) and automatically by
a background agent that scans your conversations for discrete events
and logs them on the matching article - see
[Automatic records](#automatic-records-extraction) below. The
assistant can also cross-link related records and attach chat files to
them on your behalf. Deleting a record is a hard delete, like deleting
an article; its files and links go with it.

## The autonomous background agent

A background agent reads conversations a day after they settle and
either updates an existing article or creates a new one. It runs on
your Supabase project on an hourly schedule, not in your browser -
articles keep accruing with no tab open. The specifics:

- A conversation becomes eligible the day **after** its newest
  message lands (in your timezone). A conversation that wraps Monday
  evening is eligible Tuesday morning.
- If you continue the conversation, it becomes eligible again the day
  after that. So Monday -> agent runs Tuesday -> you continue
  Wednesday -> agent runs again Thursday on the new turns.
- The agent decides per topic whether to update, create, or do
  nothing. The bar for creating an article is "would the user later
  look this up?", not "did this come up at all?".
- When updating an existing article, the agent preserves every fact
  unless the conversation directly contradicts it. The wiki accretes
  rather than churns.

The agent treats the wiki as **ongoing documentation**, not a
snapshot. It listens for what the latest conversation advances
about a subject the wiki is already tracking - a new tweak to a
recipe you're iterating on, a finished chapter of a book you're
working through, a new PR on a hobby you practice, a milestone on
a project, a job change, a family update - and brings the
article's **current state** up to date. The dated trajectory
itself lives in that article's [records](#records): the agent
updates the body to say where things stand now, while the
individual dated events accumulate as records. If an older article
still has a dated log written into its body, the agent (and the
librarian) gradually **migrate** those entries into records and
trim the body to current-state prose - checking first so nothing
that's already a record gets duplicated, and never removing a
dated line until its record exists. Nothing is lost in the move;
the history just shifts to where it belongs.

You can disable the autonomous agent in **Settings -> Wiki**. Manual
edits and the per-article "Ask agent to update" flow keep working
when it's off.

### Skipped conversations

Sometimes the agent can't process a conversation. The most common
reason is Venice's content classifier rejecting the conversation
body as inappropriate. When that happens, the agent automatically
retries the run against an **uncensored fallback model** (currently
`arcee-trinity-large-thinking`) which doesn't run the same
classifier, so most conversations the default model balks at get
processed transparently on the retry. You don't have to do
anything; it just works on the next sweep.

If the fallback **also** can't process the conversation (rare - a
real model error, a transient network issue, or an unsalvageable
body), the agent gives up on that conversation rather than retrying
forever and burning quota. Skipped conversations land in a dedicated
**Skipped** panel inside the Wiki tab. The **alert-triangle** action
in the Wiki top bar (grouped with the librarian and changelog
actions) opens it.
Each row shows:

- The **conversation title** as a link - clicking it switches to the
  Chat tab and opens that conversation.
- The **timestamp** the agent gave up.
- The **error detail** the agent received (trimmed for display).

Each row carries a **Retry** button. Clicking it asks the server to
re-run the wiki agent against the conversation right now, going
through the same primary -> uncensored-fallback two-shot the
scheduled sweep uses. On success the row stays visible with the
agent's verdict
inline: how many wiki edits landed (often **zero** - the agent's
prompt tells it to be conservative and skip rather than fabricate
content), and a one-line **reasoning** summary the agent wrote
about why. A **Dismiss** button removes the row once you've read
it. On failure the new error appears inline next to the button and
you can retry again once you've made changes. The agent's writes
(any new wiki articles, any updates) land regardless, since the
wiki tools commit each call individually.

The retry runs on the server, so a page reload mid-retry is safe:
the run keeps going, and the row shows **Retrying...** again when you
come back rather than looking idle. A row already being processed -
by your retry, or by the background sweep picking it up at the same
time - shows the same in-progress state, and the result lands once
whichever run finishes.

The autonomous agent also processes skipped rows on its own
schedule. Adding or editing turns in the conversation is not the
trigger - skipped threads bypass the usual "wait a day after the
last message" cooldown so the agent can pick them up on its next
sweep without waiting. If you want immediate feedback, use the
Retry button; if you can wait, the sweep will get to them.

If the panel is empty, the autonomous agent hasn't given up on
anything - that's the steady state.

### Automatic records extraction

A separate background agent fills in [records](#records) the same way
the article agent fills in articles. It scans settled conversations
for discrete, dated events - a bake, a doctor visit, a shipped
feature, a measurement - and logs each as a record on the matching
article. It only adds records to articles that already exist (records
need a home), and it checks for duplicates before logging, so the same
event isn't recorded twice.

Like the article agent it's conservative: most conversations contain
no record-worthy event, and that's the expected outcome. General
discussion and Q&A don't become records; specific things that
*happened* do.

You can turn this off in **Settings -> Wiki -> Automatic records**
independently of the article agent. With it off, the background agent
stops creating records but you can still add and edit them by hand,
and existing records are untouched. When the librarian reorganises an
article it reads its records, promotes durable learnings into the
article body, and tidies up duplicate or outdated records - but it
never deletes a record just because it folded that learning into the
body. Records stay as the historical log.

## The librarian

A second background agent - the wiki **librarian** - runs every 12
hours or so, on your Supabase project like the per-conversation
agent (no tab needs to be open). Its job is different from the
per-conversation agent:
instead of reading a single conversation and adding to the wiki, the
librarian looks at the wiki as a whole and tries to make it more
coherent. It can:

- **Consolidate near-duplicates.** When two articles cover the same
  subject under slightly different titles, the librarian merges the
  unique facts from one into the other and deletes the redundant
  one.
- **Fact-check against conversation history.** When an article makes
  a specific claim that might be stale - a job title, a relationship
  status, a project status - the librarian searches your past
  conversations for evidence and updates the article when it finds a
  clear contradiction.
- **Tighten subject boundaries.** When two articles bleed into each
  other (a "Maya" article and a "household" article both covering
  the same person), the librarian rewrites both so the split is
  cleaner.
- **Reorganize as if from scratch.** Periodically the librarian
  steps back from the per-article view and asks the from-scratch
  question: "if I had to track the same information about the
  user with no organizational baggage - no titles to preserve, no
  paragraph order to respect - how would I organize it? What
  would each article be titled, and what order would the content
  inside each article be in?" The point is that the per-
  conversation agent picks an article's title from the first
  conversation that introduced the subject (and orders content by
  the chronology of conversations), and both can drift over time
  - an article titled "Jeff's first sourdough loaf" whose body has
  broadened into a general sourdough-project entry, or an article
  whose lead paragraph is "the latest thing the user mentioned"
  rather than the natural overview of the subject. When the gap
  between the from-scratch ideal and the current state is large
  enough to matter, the librarian renames the article, reorders
  its content, or moves sections between articles to match the
  subject the article actually covers. Small drift is left alone -
  the bar for a change is "the current organization is actively
  misleading or makes information hard to find". Every dated fact
  is preserved through the reorganization; the historical record
  in the article body is what gives the article its longitudinal
  value.

The librarian is intentionally constrained: it cannot create new
articles, only consolidate or update existing ones. New articles
flow from the per-conversation agent or from your direct edits. And
it's conservative - if it isn't confident two articles overlap
enough to merge, or that a title has drifted far enough to need a
rename, it leaves them alone.

The 12-hour minimum interval is enforced server-side (via an atomic
Postgres claim); exactly one scheduled run happens per cycle no
matter how many devices you have the app open on - or none.

You can disable the librarian independently from the per-conversation
agent in **Settings -> Wiki**. The two toggles are independent: you
can run one without the other.

### Running the librarian on demand

The Wiki top bar groups three actions - **sparkles** (run the
librarian), **clock** (the [changelog](#changelog)), and
**alert-triangle** (the [Skipped](#skipped-conversations) panel). On
a wide screen they sit side by side as a button group; on a narrow
screen they collapse into a single overflow (**...**) menu so the bar
stays uncluttered. Clicking **sparkles** opens a confirmation strip
with an optional instructions textarea, then runs the librarian
against your wiki immediately.

- **Leave the instructions empty** to run the normal periodic sweep
  (the consolidate / fact-check / boundary-tighten pass described
  above).
- **Type instructions** to scope the run. The librarian will carry
  out what you ask plus any follow-on edits required to keep the
  wiki coherent (for example, if you ask it to delete an article,
  it may remove references to that article in other places). It
  will NOT also perform the broader periodic sweep - it stays
  inside the scope you specified.

A manual run is irreversible - the librarian's `wiki_update` and
`wiki_delete` tools write to your wiki directly, with no preview
step. The confirmation strip surfaces this before you commit.

A manual run does **not** reset the 12-hour cadence for the next
background run. Manual and scheduled runs are independent.

The three ways a librarian run can start (scheduled, this button,
and the chat-driven path below) are mutually exclusive: starting one
while another is in flight shows a "try again in a moment" message
instead of racing two passes over the wiki.

### Asking Nak to run the librarian from the chat

You can also ask Nak to invoke the librarian from inside a normal
conversation - for example, "consolidate my duplicate Maya articles"
or "delete the kettle stub and tidy any references to it." The
assistant has read access to your wiki (`wiki_list`, `wiki_get`,
`wiki_search`) for surveying the shape of what is there, and it can
delegate maintenance tasks to the librarian through a `wiki_librarian`
tool. The tool is **gated** behind the **Wiki** toolbox in the
composer's toolbox popover - Nak will enable it on the fly when the
conversation makes maintenance the obvious next step, or you can flip
it on yourself before asking.

The chat-driven path runs the same librarian sub-agent the sparkles
button does, with the same in-flight guard - a chat-triggered run
while a manual or scheduled run is happening (or vice versa) returns
an error rather than racing two passes. Nak reports back in prose
what the librarian merged, deleted, or left alone.

The librarian is the right tool when the job spans several articles -
merging duplicates, splitting a conflated topic, a from-scratch
reorganization. For a single targeted edit, the assistant can also
write the article directly (see [How the assistant uses the
wiki](#how-the-assistant-uses-the-wiki) below); both paths gate behind
the same **Wiki** toolbox.

## Changelog

Every change to the wiki - article added, edited, deleted, **and
record added, edited, or removed** - by you or by either agent is
recorded as a one-line entry in the **wiki changelog**. The changelog
is the Wiki tab's default view - open the **Wiki** tab with no article
selected and it fills the panel. While reading an article, the
**clock** action in the Wiki top bar (grouped with the librarian and
skipped actions) clears the selection and lands you back on the
changelog.

Each entry shows:

- A **kind chip** (Added / Edited / Deleted for articles; **Added
  record / Edited record / Removed record** for record writes) so you
  can scan the history at a glance. Record entries reuse this same
  changelog, scoped to their parent article.
- The **article title** at the time of the change. For everything
  except an article deletion the title is a link - clicking it
  switches to the Wiki tab and opens that article. (A "Removed record"
  entry still links through: removing a record leaves the article
  intact.) For a deleted **article** the title is plain text (the
  article no longer exists to open).
- The **timestamp** the change was applied.
- The **one-line message** explaining what changed and why - written
  by whoever made the change. The autonomous agent and the librarian
  write their own messages as part of each tool call; your direct
  edits and the "Ask agent to update" preview both supply a message
  before the change lands.

Entries are newest-first. The list pages in chunks of 50; a **Load
more** button at the bottom fetches the next chunk. Switching away
from the Wiki tab and back fetches a fresh first page.

The changelog is per-user and read-only - entries cannot be edited
or removed individually. The only way to wipe it is **Settings ->
Wiki -> Reset wiki data**, which clears the changelog along with
the articles (the orphaned history wouldn't be useful next to an
empty wiki).

## How the assistant uses the wiki

Articles are **never** auto-injected into the chat. The assistant
reaches them only through `wiki_search`, an always-on tool registered
on every conversation. When you mention something topical or factual
about yourself - a project, a person, a place, a habit - the
assistant will call `wiki_search` to pull the relevant article so its
reply is grounded rather than guessing.

This is the deliberate split between the two knowledge surfaces:

- **Memory** - atomic facts, may be primed inline at the start of a
  conversation.
- **Wiki** - encyclopedic articles, never auto-included. Always
  retrieved on demand.

If you want the assistant to use a particular article, mention the
topic (or the title) directly - that's the cue for `wiki_search`.

### Letting the assistant edit the wiki

Reading is always on; **writing** is gated behind the **Wiki**
toolbox in the composer's toolbox popover. Turn it on (or let Nak flip
it on when the conversation makes a wiki edit the obvious next step)
and the assistant can, right there in the chat:

- **create, edit, and delete articles** - "start an article about my
  marathon training", "add a paragraph to the Maya article", "delete
  the duplicate kettle stub";
- **manage records** - log a dated [record](#records), correct one,
  remove one, attach a file you posted in the conversation, or
  cross-link two records;
- **delegate to the librarian** for the bigger multi-article jobs
  (see [The librarian](#the-librarian)).

Every chat-driven article create/edit/delete still writes a
[changelog](#changelog) entry with the reason Nak gives, so the audit
trail is identical whether you typed the change yourself or asked the
assistant to. When the Wiki toolbox is off, none of these write tools
are on the wire - the assistant can read your wiki but cannot change
it.

## Settings controls

The **Settings -> Wiki** pane has three independent toggles plus a
reset button:

- **Automatic articles** - whether the per-conversation wiki agent
  runs in the background after threads settle.
- **Automatic records** - whether the background extraction agent
  scans conversations and logs dated [records](#records) on your
  existing articles. Independent of the article toggle; manually-
  added records always work.
- **Librarian** - whether the periodic librarian agent runs in the
  background to consolidate and fact-check.
- **Reset wiki data** - lives at the bottom of the pane. Permanently
  deletes every wiki article (and its records) and clears the per-
  conversation wiki state so the agent re-evaluates your threads from
  scratch. Irreversible. There's a confirmation prompt. If the
  automatic toggle is still on, the wiki agent will begin rewriting
  articles on its next sweep - flip it off first if you want a
  permanent wipe.

All three toggles are on by default. The wiki uses the display
timezone you set under Settings -> AI -> About you.
