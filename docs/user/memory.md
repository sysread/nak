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
- **Personality signals** — how you communicate, what you value,
  what frustrates or delights you.
- **Reactions to the assistant** — when you pushed back, when you
  agreed, when you redirected a conversation. Data about what
  works and doesn't with you specifically.
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
column on the conversation pane, stacked above the bias chart, the
intuition brain, the mood pill, and the scroll-to-latest arrow.
Click it to open the **Recall** modal, which shows the stitched
first-person note that was most recently injected as the
assistant's prior thought — verbatim, in italic, the way a chapter
opens with an illuminated initial. The modal also reports when the
recall fired, which user round it landed on, and what triggered it
(cold start, topic shift, mood shift, or staleness fuse).

Only one recall is kept per thread at a time, so the modal always
reflects what the assistant remembered before its most recent
reply. When a new recall fires, the modal's content updates in
place. The light bulb stays disabled until a recall has actually
landed for the active thread.

## Browsing memories directly

The **Memories** tab in the left drawer is the entry point - same
row of tabs as Chats, Recipes, and Wiki. Pick it and the
sidebar fills with every memory on your account, most recent
first; the main panel waits for you to pick one.

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
hasn't reached yet (or chose not to tag). Picking multiple topics
is OR semantics - "allergies" + "food" shows memories tagged with
either. Pills below the dropdown carry the active selection;
each pill's × clears just that one. Tags are managed for you -
there is no manual tagging UI; edit a memory's text and the
worker re-tags it on its next pass.

From the panel you can:

- **Edit a memory in place.** Clicking *Edit* swaps the row into
  label + body fields with character counters and an explicit
  *Save* button. A save-state badge under the fields shows
  *Unsaved changes*, *Saving…*, *Saved ✓*, or the error message
  if the write failed, so you never have to guess whether an edit
  landed on the server.
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
  `memory_delete` tool performs). The confirmed *Delete* button
  flips to *Deleting…* while the request is in flight; if the
  server refuses, the error surfaces next to the buttons rather
  than in the global banner.

A freshly edited memory briefly falls back to substring search
while the background embedding worker recomputes its vector — the
list still shows it, but semantic-match hits on the old text stop
landing until re-embedding catches up. This is the same behavior
the assistant sees when it updates a memory through its tools.

Invalidation (the soft-delete the assistant uses by default) is not
exposed here — the browser only offers hard delete, because an
explicit human decision to remove a memory is the stronger signal
of the two. If you want to just hide a memory without erasing it,
tell the assistant to forget it instead.

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
server; memory writes go from your browser to your Supabase. Memory
reads go the same way.

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
- [Security model](./security.md) - RLS, encryption, and what the
  master password does (and doesn't) protect.
- [The chat interface](./chat.md) - where the tool-call strip
  appears so you can watch recall fire.

---
Back to the [index](./README.md).
