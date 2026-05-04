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

After the first user+assistant exchange in a new thread, Nak asks the
fast model for a 3-6 word title and swaps it in for the
`New conversation` placeholder. The request is best-effort: if it
fails, the thread keeps the placeholder and nothing else breaks.

What you see: the sidebar entry for the thread flips from
`New conversation` to a real title a second or two after your first
reply arrives. You can always click the title bar to rename manually;
the auto-title only seeds the first value.

Cost: one short fast-tier call per new thread (24 output tokens max).

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
stretch without a refresh. Each fire runs two parallel passes — one
over your stored memories, one over the topical summaries of your
prior conversations — and stitches the findings into a short
recollection the assistant reads as its own prior thought before
the next reply. The main model can also call `memory_recall` and
`conversation_recall` directly when you ask it to look something
specific up; those are the explicit-lookup escape hatches alongside
the automatic topic-boundary path.

No toggle for either. If you want recall to skip a specific turn,
tell the model directly ("don't look up prior context for this
one") and it will.

## Embeddings

A background Web Worker computes vector embeddings for every memory
and every thread summary. Embeddings are what make `memory_search`
and `conversation_search` find things by meaning rather than by
exact keyword match.

What you see: nothing. A just-written memory is unembedded for a
short window (typically under a minute) while the worker catches up;
during that window, searches still match it by substring and
promote to semantic results once the embedding lands.

Cross-tab coordination: only one tab runs the worker at a time, via
`navigator.locks`. If you have Nak open in several tabs, the others
sit idle until the active one closes.

Cost: Venice's embedding endpoint, one call per unembedded row.
Rate-limit responses pause the worker for 30 seconds before
retrying.

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
- [Security model](./security.md) - what's encrypted, what's stored
  plaintext, and what the master password protects.
- [Search](./search.md) - the user-facing side of the embeddings
  pipeline.
- [Models & reasoning](./models.md) - the fast tier that all
  background work runs on.

---
Back to the [index](./README.md).
