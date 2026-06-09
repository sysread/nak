# What runs in the background

Most of Nak is the chat window in front of you, but a handful of
features do their work silently between messages — generating thread
titles, summarizing old conversations, learning long-term facts about
what you're working on, and pre-computing search indexes. This page
explains what each one does, what (if anything) you see when it runs,
and what knobs exist to control it.

None of this leaves your browser except as API calls to Venice (for
the model work) and Supabase (for storage). Memories, summaries, and
embeddings all land in your own Supabase project — the one whose URL
and key you entered during [getting started](./getting-started.md).

## Auto-titling

A background worker watches for threads still on the `New
conversation` placeholder, asks the fast model for a 3-6 word title
based on your first message, and swaps it in. If the call fails (a
network blip, a Venice 4xx) the worker retries on its next cycle, so
a closed tab or a refresh mid-titling no longer leaves the thread
permanently blank.

What you see: the sidebar entry for the thread flips from
`New conversation` to a real title within a few seconds of your
first send. You can always click the title bar to rename manually;
the auto-title only seeds the first value, and a manual rename
takes over for good.

Cost: one short fast-tier call per new thread (64 output tokens max).

No toggle. The call is cheap enough that exposing a switch would be
more friction than it saves.

## Thread summaries

When a thread settles (no new messages for a while), a background
worker asks the fast model to write a 2-3 sentence summary of it.
The summary is stored on the thread row in Supabase but never
rendered in the UI — it exists so [search](./search.md) and the
conversation-recall agent (below) can find old threads by gist, not
just by matching words.

What you see: nothing directly. Indirectly, searches across old
conversations start returning better results once a thread has been
summarized. Brand-new threads you just finished may take a moment to
become fully searchable.

Cost: one fast-tier call per thread, once. Long threads get
condensed to the first 40 + last 80 messages before summarization so
cost stays roughly constant.

No toggle.

## Topic tagging

A separate background worker reads each thread and picks 1-4 short
topic tags for it (`baking`, `sourdough`, `programming`, etc.). The
tags drive the **Topics** filter dropdown in the conversation
drawer - see [Threads](./threads.md) for how to use it.

The agent reads your existing topic vocabulary on every cycle and
reuses tag names that fit, so the dropdown stays a small stable
list instead of sprawling into near-duplicates. New conversations
seed new topics; the same conversation gets re-tagged after
several more turns so the tags stay current with how the thread
evolved.

What you see: nothing while it runs. After the worker tags a
thread, that thread starts matching the corresponding filters in
the Topics dropdown.

Cost: one fast-tier call per thread, with a re-tag after a thread
materially grows. Long threads get condensed the same way summaries
do.

No toggle.

A sibling worker does the same job for your memories: each memory
gets 1-4 short subject-area tags ("allergies", "tooling",
"family") and the **Memories** drawer tab gains the same
**Topics ▾** dropdown the conversation drawer has. See
[Memory](./memory.md) for the user-facing side. Editing a
memory's text re-queues it for tagging on the next worker pass;
confidence-only nudges (reaffirm, doubt) leave the tags alone.

A third sibling worker tags your recipes, with a higher cap of 1-6
tags per recipe so all four dimensions - primary ingredients,
cuisine, course, technique - can land on a single dish (chicken +
indian + curry + dinner, for example). The **Recipes** drawer tab
mounts the same **Topics ▾** dropdown. See
[Cookbook](./cookbook.md) under "Filtering by topic" for usage.
Editing a recipe's title or cooklang re-queues it for tagging;
bookmark / rating changes do not.

## Memory reflection and recall

Two background loops — **reflection** (writes long-term memories
after a thread settles) and **recall** (reads them back at topic
boundaries) — are the mechanics behind the [Memory](./memory.md)
feature. That page is the primary source; everything here is just
the plumbing view.

Reflection runs on the fast model tier, one cycle per settled thread,
and uses the memory tools to write or update memory rows.

Recall fires automatically at topic boundaries: at the start of a
fresh thread, after the model renames the conversation (the strongest
"topic shift" signal), after your mood band shifts, and after a long
stretch without a refresh. Each fire searches three layers in
parallel — your stored memories, the topical summaries of your prior
conversations, and your [wiki](./wiki.md) articles — and assembles a
short index the assistant reads as its own prior recollection before
the next reply. Matching memory facts are dropped in verbatim;
related conversations and wiki articles come in as a short list of
titles the assistant can open in full (with `conversation_get` /
`wiki_get`) if a lead looks worth pulling. There is no extra model
step massaging the findings into prose, so what the assistant recalls
is exactly what the stores hold. The main model can also call
`memory_recall`, `conversation_recall`, `wiki_recall`, or the
umbrella `context` directly when you ask it to look something
specific up; those are the explicit-lookup escape hatches alongside
the automatic topic-boundary path.

What you see: while a recall fire runs, the in-progress assistant
bubble shows a brief checklist row - a spinner next to **Recalling**
that ticks over to a checkmark once the recollection is assembled. The
sibling [intuition](./intuition.md) and samskara layers get their own
rows (**Predicting** and **Reacting**) when they fire, and the whole
checklist ease-fades out as the reply starts streaming.

No toggle for either. If you want recall to skip a specific turn,
tell the model directly ("don't look up prior context for this
one") and it will.

## Embeddings

Vector embeddings are computed for every memory, thread summary,
recipe, wiki article, and a few other text fields. Embeddings are
what make `memory_search`, `conversation_search`, and the drawer
searches find things by meaning rather than by exact keyword match.

Unlike most of the items on this page, this one does **not** run in
your browser. It runs on your Supabase project on a schedule (every
few minutes), so it keeps working with no tab open - close the laptop
and new memories still get embedded. Most of the model-driven workers
above (titles, summaries, tagging) need the app open in a tab;
reflection, the [autonomous wiki agent](./wiki.md) and its librarian,
the [memory librarian](./memory.md#the-memory-librarian)'s two
tidy-up passes, embeddings, and the storage cleanup below run
server-side without one.

What you see: nothing. A just-written memory is unembedded for a
short window (up to a few minutes) until the next scheduled pass
catches up; during that window, searches still match it by substring
and promote to semantic results once the embedding lands.

Cost: Venice's embedding endpoint, one call per unembedded row. The
schedule processes a bounded batch per run and resumes on the next
run, so a large backlog drains over several passes rather than in one
burst.

No toggle.

## Storage cleanup

Files you attach to a chat (and images Nak generates) don't live
forever. Thirty days after a conversation's last message, a scheduled
job on your Supabase project deletes the stored file bytes and frees
the space. The filename, size, and any extracted text stay behind so
the conversation still reads sensibly - see
[Attachments](./attachments.md#expiration) for exactly what survives.

Like embeddings, this runs server-side on a schedule, so it reclaims
space even with no tab open. Replying to a thread resets the 30-day
clock for every file in it.

What you see: nothing while it runs. An expired attachment picks up a
small clock icon in the conversation; its **Text** button keeps
working.

Cost: none - it only deletes, no model calls.

No toggle.

## Web search

Venice supports server-side web search: when enabled, the model can
signal that an answer needs live results, Venice fetches and cites
them, and the citations appear inline in the assistant's reply.

What you see: citations in the reply, and occasionally a short delay
while Venice resolves the search. Results the model chose not to
cite don't appear.

Controlled by the **web search** toggle in
[Settings -> AI](./settings.md). Off by default. Turning it on adds
a line to the system prompt telling the model the capability is
available; it's still the model's choice whether to invoke it for
any given turn.

Cost: Venice's own search add-on pricing; see their documentation
for current rates. No cost when the toggle is off.

## What's NOT happening in the background

A few things people often assume are happening but aren't:

- **No upload of your prompts to any third party** beyond Venice (for
  the model call) and Supabase (for persistence, in your own
  project).
- **No analytics or telemetry back to the Nak project.** Nak has no
  server of its own.
- **No cross-account memory.** Memories are per-account; a second
  user signing in sees nothing you've accumulated.
- **No context-window compaction yet.** Long threads still send the
  full history to the model until you start a new thread. The
  [context ring](./chat.md) next to the composer shows how close
  you are to the model's limit.

## Where to go next

- [Memory](./memory.md) - the user-facing side of reflection and
  recall.
- [Security model](./security.md) - what's stored where (plaintext
  config vs the server-side Venice key) and what RLS protects.
- [Search](./search.md) - the user-facing side of the embeddings
  pipeline.
- [Models & reasoning](./models.md) - the fast tier that all
  background work runs on.

---
Back to the [index](./README.md).
