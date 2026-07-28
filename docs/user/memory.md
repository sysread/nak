# Memory

Nak builds up a long-term memory about you as you chat. Facts you've
shared, preferences you've expressed, decisions you've landed on,
observations about how you prefer to work — all of it gets distilled
into short notes the assistant can pull back in on future
conversations. You don't manage memory directly; you shape it by
talking to the model, and the model tends it on your behalf.

## What Nak remembers

Memories fall into a few loose categories. The reflection agent is
told to watch for each:

- **Facts about you** — name, role, current projects, tools you use,
  constraints you work under. The concrete, reusable stuff.
- **Personality signals** — the assistant pays special attention
  here: how you communicate (terse or expansive, formal or casual,
  blunt or hedged), the tone you use and the tone you want back,
  your sense of humor, what you value, and what frustrates or
  delights you.
- **Reactions to the assistant** — also weighted heavily: when you
  pushed back, agreed, redirected, went quiet, warmed up, or got
  short — and whether a particular phrasing or tone landed well or
  badly. Data about what works and doesn't with you specifically.
- **Self-guidance notes** — short coaching messages the model writes
  to its future self. "This user prefers terse answers." "Name the
  tradeoff rather than recommending." "Don't assume they want code
  samples without asking."

Memories are short, dense, and meant to be read by the assistant on
future turns — not by you. If you read one raw, it may sound stilted
or overly behavioral. That's intentional.

## How it grows

When a conversation settles (no new messages for a while), a
background agent reads the whole thread and decides whether anything
it saw is worth remembering. For each candidate memory, the agent:

1. **Searches existing memories** for anything close. Duplicates are
   worse than nothing — they dilute search.
2. **Updates** the existing memory if the new insight refines it.
   Updating bumps the confidence score, so memories you've
   corroborated across multiple conversations outrank one-off
   observations.
3. **Invalidates** a memory if a new insight contradicts it. See
   "Forgetting" below.
4. **Creates** a new memory only when nothing close exists.

The reflection agent runs on the fast model tier and is told to be
conservative: fewer high-signal memories beat many noisy ones. Most
threads produce zero or one memories; only conversations with
genuinely new information produce more.

See [background features](./background.md) for the mechanics of the
reflection loop itself.

## How the assistant uses it

Topic-boundary recall is automatic. At the start of a new thread,
when the topic shifts (the assistant renames the conversation),
when your mood band shifts, or after a long stretch without a
refresh, Nak quietly fans out two parallel recall passes — one over
your stored memories, one over the topical summaries of your prior
conversations — and stitches their findings into a short
recollection the assistant reads as its own prior thought before
replying. The result is the same as if the assistant had explicitly
called `memory_recall` and `conversation_recall` on every topic
boundary, without you having to wait through the tool-call strip
for them.

Two channels show up in the recall the assistant sees:

- **Facts and prior threads.** Standing memories that touch the
  current topic but weren't already mentioned, plus details from
  past threads ("we landed on approach X last time this came up").
- **Calibration.** Background context about what you've already
  worked through on this topic, so the assistant pitches its answer
  at the right depth and doesn't re-explain things you've mastered.

Calibration is NOT preference-bending: Nak doesn't shade facts to
match your tastes. It tells the assistant where you are on a topic
so the answer lands at your level, not under it.

You'll usually just notice the side effect: the assistant knows
you're working on project X without being re-told, picks up a
style preference you corrected it on weeks ago, or skips the basics
on a topic you've been deep in for weeks.

The assistant can still call `memory_recall` and `conversation_recall`
directly when you ask it to look something specific up ("what was
that thread about X?", "remind me what we decided about Y"). These
are the explicit-lookup escape hatches; the topic-boundary recall
above handles the ambient case.

Recall runs on the fast tier — the cost is a few cents of tokens
per invocation, at most.

## Seeing what was recalled

There's a light-bulb glyph (💡) at the top of the bottom-right pill
column on the conversation pane, stacked above the intuition brain,
the bias chart, the mood pill, the working-intentions seedling (when
enabled), and the scroll-to-latest arrow.
Click it to open the **Recall** modal. Each injection is shown
verbatim, in italic, the way a chapter opens with an illuminated
initial, paired with the user prompt that triggered it. The most
recent injection sits at the top; earlier injections from this
session follow below, in descending order by turn, separated by
horizontal rules. Each entry reports the trigger (cold start,
topic shift, mood shift, or staleness fuse) and the timestamp it
landed.

Recalled facts cite their sources. Small superscript numbers in the
note (like the ones web search adds) link to a **Sources** list under
each entry; clicking a source opens the memory, prior conversation, or
wiki article it came from, so you can trace exactly what Nak was
drawing on.

Recall injections are per-turn and ephemeral — each fire is only
used by the round it was computed for; nothing about the
injection survives into later turns of the conversation. The
in-memory history exists only so you can audit what Nak was
thinking on each prior turn while the tab is open; reload the
page and the history clears down to the most recent injection
(which is the one cached on the thread row). The light bulb
stays disabled until a recall has actually landed for the active
thread.

## Browsing memories directly

The **Memories** tab in the left drawer is the entry point - same
row of tabs as Chats, Recipes, and Wiki. Pick it and the
sidebar fills with your memories, most recent first; the main
panel shows the **memory changelog** until you pick one (see
*The memory changelog* below). The list loads in pages as you
scroll - more memories load automatically as you reach the
bottom, so a large account never stops at a fixed cap.

The search box at the top of the sidebar runs a semantic match -
paraphrases and synonyms count, not just substrings - and falls
back to plain substring search when the embedding service is
unreachable. Typing into the sidebar filters the listing in
place. Click a row in the sidebar to open that memory in the
main panel - one card at a time, with the full body, confidence
tag, last-touched timestamp, relations, and the inline edit /
delete / reaffirm / doubt / + Relate controls.

Rows in the sidebar are tinted by confidence so you can scan the
listing at a glance: green-tinted rows are *corroborated*, light-
red rows are *hedged*, and a stronger red marks *shaky*. Neutral
rows stay plain. Hover a row to see the tag spelled out in the
tooltip alongside the label.

Switching to a different drawer tab (Chats, Recipes, Wiki)
and back keeps your selection - the picked memory is on the URL,
so a refresh or a back button lands you on the same card.

Below the search box, a **Topics ▾** dropdown lets you narrow
the listing to memories about a particular subject area
("allergies", "tooling", "family"). A background worker tags
each memory with one to four short topic strings as you accumulate
them; the dropdown shows the topics you've collected so far,
plus an **untagged** row that filters to memories the worker
hasn't reached yet (or chose not to tag). Each row carries a count
in parens - the total number of memories with that topic across your
whole collection, not just the ones the current search turned up.
Picking multiple topics
is OR semantics - "allergies" + "food" shows memories tagged with
either. Pills below the dropdown carry the active selection;
each pill's × clears just that one. Tags are managed for you -
there is no manual tagging UI; edit a memory's text and the
worker re-tags it on its next pass.

From the panel you can:

- **Edit a memory in place.** Clicking *Edit* swaps the row into
  label + body fields with character counters, a required
  one-line *Change message* ("what changed and why"), and an
  explicit *Save* button. The change message lands in the memory
  changelog, so your edits leave the same trail the assistant's
  do; *Save* won't go through without one. A save-state badge
  under the fields shows *Unsaved changes*, *Saving…*, *Saved ✓*,
  or the error message if the write failed, so you never have to
  guess whether an edit landed on the server.
- **Reaffirm or doubt a memory.** *Reaffirm* nudges confidence up
  by 0.5; *Doubt* multiplies it by 0.7. While the request is in
  flight the button label flips to *Reaffirming…* / *Doubting…*
  and the sibling action buttons disable, so you can see the
  click registered; on completion a brief *Reaffirmed ✓* /
  *Doubted ✓* pulse appears next to the buttons before they
  return to normal. The chip in the header row shows the
  resulting tag (corroborated / hedged / shaky) or a numeric
  value when it's in the neutral band, and the sidebar row's
  background tint updates to match.
- **Link memories.** *+ Relate* opens an inline picker: choose a
  relation kind (supports / contradicts / generalises /
  specialises), search for a target memory to link to, optionally
  add a short note, and click a candidate to create the edge.
  Existing edges show up under each memory's body; the small ×
  next to an edge removes it.
- **Delete a memory.** *Delete* asks you to confirm inline before
  issuing a hard delete (the same operation the assistant's
  `memory_delete` tool performs). The confirm strip includes a
  required *Why delete this?* note that lands in the changelog -
  the deletion won't go through without it. The confirmed
  *Delete* button flips to *Deleting…* while the request is in
  flight; if the server refuses, the error surfaces next to the
  buttons rather than in the global banner.
- **Jump to similar memories.** At the foot of the card a *Similar
  memories* section sits collapsed. Expanding it runs a one-off
  semantic search for the memory's closest neighbours - the same
  vector match the search box and the assistant's recall use - and
  lists them by label, each prefixed with a match-score pill (higher
  is closer; the pill is the value the list is ordered by). Click a
  label to open that memory. Nothing
  is fetched until you expand the section, and a memory not yet
  embedded (one written moments ago) shows nothing until its vector
  is ready.

A freshly edited memory briefly falls back to substring search
while the scheduled embedding pass recomputes its vector - the
list still shows it, but semantic-match hits on the old text stop
landing until re-embedding catches up. This is the same behavior
the assistant sees when it updates a memory through its tools.

Invalidation (the soft-delete the assistant uses by default) is not
exposed here — the browser only offers hard delete, because an
explicit human decision to remove a memory is the stronger signal
of the two. If you want to just hide a memory without erasing it,
tell the assistant to forget it instead.

## The memory changelog

The main panel shows the **memory changelog** whenever no memory is
picked - a running, newest-first log of what was learned, revised,
and forgotten, much like the wiki's changelog. The clock button at
the left of the Memories top bar (ahead of the deep-sleep and rem
pass buttons) jumps you back to it from any open memory; on a narrow
screen the top-bar buttons collapse into a single overflow menu, and
the changelog is its first entry. Each changelog entry carries a
colored chip (*Added* / *Edited* / *Deleted*), the memory's label at
the time of the change, a timestamp, and a one-line note explaining
the change. Click a label to jump straight to that memory; entries
for deleted memories show the label in plain text, since there's
nothing left to open.

Entries that changed a memory's **size** also carry a small chip
showing by how much - `+412` when the body grew, `-1,203` when it
shrank, with the bigger moves shown more boldly. It's there because
long memories are expensive: the assistant replays a recalled
memory's full text every time it surfaces one, so a memory that
keeps growing costs a little more on every future turn. The chip
makes that visible - especially for the librarian's merges, where
it shows at a glance whether two memories were genuinely condensed
into one or just stapled together.

Small changes show no chip at all, so the column stays quiet unless
something really moved. Entries recorded before this was added show
no chip either - those sizes were never stored and can't be
recovered.

The log is deliberately about *content*, not confidence churn. It
records:

- memories the assistant or you **added**,
- **edits** - rewording, renaming, or correcting a memory,
- **deletes**, and
- **merges** by the memory librarian, when it folds two duplicate
  memories into one (shown as an edit on the survivor, noting which
  memory was merged in).

It does **not** record the constant background nudges to a memory's
confidence (reaffirm, doubt, the soft-delete the assistant uses),
or the relation links between memories - those would bury the
signal you actually want, which is "what did I learn, change my
mind about, or forget." Every entry - whether written by you, the
assistant, or the librarian - carries a short note, so the log
reads like a commit history for your memory. *Load more* at the
bottom pages back through older history.

## Talking to memory

You interact with memory through the assistant too — for in-flow
edits it's often faster than opening the browser. Some things you
can ask:

- **"What do you remember about me?"** or **"What do you know about
  my work on X?"** — the model runs a memory search and reads back
  what it finds.
- **"Actually, I don't use tool Y anymore — I've moved to Z."** —
  the model can update the stale memory rather than letting it
  rot. You don't need to say "please update your memory" explicitly,
  though you can.
- **"You keep assuming I want long responses. I don't. Remember
  that."** — a direct instruction to record a preference. The model
  will usually call `memory_create` and confirm.
- **"Forget that I was ever interested in X."** — see "Forgetting"
  below.

The assistant has `memory_search`, `memory_create`, `memory_update`,
`memory_reaffirm`, `memory_doubt`, `memory_relate`, `memory_unrelate`,
`memory_invalidate`, and `memory_delete` as tools. Most requests
map to a combination of those; you don't need to know the tool
names.

## Confidence and linked memories

Each memory carries a **confidence score** in `[0.05, 10.0]`. New
memories start at 1.0. The assistant can nudge it two ways mid-
conversation:

- **Reaffirm** adds 0.5 (capped at 10). Use when the current
  exchange reinforces an existing memory.
- **Doubt** multiplies by 0.7. Gentler than invalidation; expresses
  mild uncertainty without erasing the memory.

The score classifies into qualitative tags the assistant sees when
memories are retrieved:

- **corroborated** — confidence >= 5.0.
- **hedged** — confidence between 0.5 and 1.5. The model will tend
  to soften claims drawn from memories in this band.
- **shaky** — confidence below 0.5. Close to the 0.05 search-hide
  floor. The model hedges heavily or declines to rely on them.

Memories can also be **linked** to each other in a small directed
graph. Four relation kinds:

- **supports** — target reinforces source. Two memories pointing
  at the same pattern from different angles.
- **contradicts** — target disagrees with source. Stored directional;
  the assistant may choose to link only one way.
- **generalises** — target is a broader version of source.
- **specialises** — target is a concrete case of source.

When the assistant recalls a memory, the first few outbound links
ride along automatically so it sees linked context without a second
lookup. The Memories browser renders the edges inline under each
memory; you can add or remove any edge yourself.

## The memory librarian

Reflection writes memories one thread at a time and never sees the
store as a whole, so cross-thread duplicates accumulate over time
and the relationships between memories stay sparse. The **memory
librarian** is a pair of background passes that periodically tidy
the store:

- **Deep-sleep** (slow-wave consolidation). Every ~12 hours, picks
  the memory that hasn't been visited in the longest time, finds
  its similarity neighbors, and decides for each pair whether to
  consolidate them (one fact written twice), relate them
  (genuinely distinct but adjacent), or leave them alone.
- **Rem** (associative integration). Also every ~12 hours, on a
  staggered cadence. Looks at conversations where the recall
  feature surfaced multiple memories together and asks whether
  the memory graph captures the relationships your behavior
  implies. Primary mode is drawing relation edges; rare cases
  consolidate hidden duplicates that deep-sleep missed.

Both passes use the same toolbox: search, consolidate, relate, and
soft-invalidate. Neither can create new memories from nothing -
their job is to reshape what already exists. Consolidation preserves
the stronger of the two existing confidences (it does not
manufacture new confidence on a merge), so memories that survive
repeated consolidation passes don't drift artificially upward.

Both passes run in the background on your Supabase project, the
same place the wiki's background agents live - no tab needs to be
open, and your memories keep getting tidied whether or not the app
is running. Each pass keeps its own roughly-12-hour clock, enforced
server-side, so exactly one scheduled run happens per cycle no
matter how many devices you use.

Only one librarian run can happen at a time. The two passes - and
the manual buttons below - share a single lock, so starting one
while another is already running shows a "try again in a moment"
message instead of racing two passes over the same memories.

The Memories panel's top bar groups two icon actions - **moon** for
deep-sleep, **shuffle** for rem - that trigger a manual run when
you want to see what the librarian would do without waiting for the
next scheduled cycle. On a narrow screen the pair collapses into a
single overflow (**...**) menu to keep the bar uncluttered. The
panel shows a live step-by-step progress strip while the run
executes and a one-sentence summary of what the agent did when it
finishes. The step currently in flight is marked with a spinning
bar (`- \ | /`); finished steps get a check, failed ones a cross. A
spinning **Working** row sits at the bottom of the list for as long
as the run is going, so you can always tell the difference between
"more steps are coming" and "it stopped here". A cross partway down
the list is usually not the end of the run - the librarian often
retries a step a different way and carries on.
You can switch to another drawer tab mid-run and come
back - the strip picks up where it left off. A full page reload is
also safe: the run keeps going on the server, the button stays
disabled until it actually finishes, and the last run's summary is
restored when you come back (the live step-by-step list is not - only
the final summary). A manual run does not reset the 12-hour clock for
the next scheduled one.

The scheduled runs can be turned off under **Settings -> Memory ->
Memory librarian**. The manual buttons keep working with the toggle
off - they only run when you click them.

## Forgetting

Two tiers:

- **Invalidate** (the default for "forget X"). Halves the memory's
  confidence so search stops surfacing it. Repeated invalidation
  hides it entirely. The row stays on disk — if you later
  contradict the invalidation ("actually, Y is still true"), the
  memory can be re-promoted. Reflection never hard-deletes; it only
  invalidates.
- **Delete** (hard erase). Actually removes the row. Ask for this
  explicitly ("delete that memory, don't just hide it") if the
  content is sensitive or outright wrong. The assistant can call
  `memory_delete` on your behalf.

If you're about to hand a device off or stop using Nak, deleting the
relevant memories is more forceful than invalidating them — a
future session can't re-promote what isn't there.

## What's stored and where

- **Location:** the `memories` table in your Supabase project. Every
  row carries a `user_id`; Supabase Row-Level Security enforces
  that no account can read another account's memories, even on a
  shared deployment.
- **Content:** a short title, a body, a handful of tags, and an
  embedding vector. No raw conversation transcripts — just the
  distilled observation.
- **Backups:** whatever Supabase's automated backups cover for your
  project. Nak has no separate backup story for memories.

None of this leaves your infrastructure. Nak's own project has no
server; memory writes come from your browser or from the background
passes running on your own Supabase project, and land in your
Supabase either way. Memory reads go the same way.

## Limitations

- **No per-thread scope.** Memories are account-wide; the assistant
  can't scope a memory to "only remember this inside thread T."
- **No manual import.** If you want to seed memory with a batch of
  facts, paste them into a conversation and ask the model to record
  them. There's no bulk upload — and the Memories browser is edit/
  delete only, not create.
- **No invalidate-from-UI.** The in-app browser offers *Doubt*
  (gentle, ×0.7) and hard *Delete*, but not the reflection-tier
  halving (×0.5) that `memory_invalidate` uses. To decay a
  memory aggressively without deleting it, ask the assistant to
  forget it — reflection and the assistant's `memory_invalidate`
  tool handle that path.
- **Model-dependent quality.** The reflection agent is as thoughtful
  as the fast model it runs on. Occasional noise is unavoidable;
  invalidate or delete anything that slipped in.

## Where to go next

- [What runs in the background](./background.md) - the reflection
  and recall loops in more detail, alongside the other
  behind-the-scenes features.
- [Security model](./security.md) - RLS, where your keys live, and
  what the publishable key does (and doesn't) expose.
- [The chat interface](./chat.md) - where the tool-call strip
  appears so you can watch recall fire.

---
Back to the [index](./README.md).
