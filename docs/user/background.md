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

## Memory reflection

When a thread settles, a second background agent reads it end-to-end
and decides whether there's anything worth remembering across
conversations — a stable user fact, a project constraint, a
preference you've expressed, a decision you've landed on. When it
finds something, it writes a memory row into your Supabase via the
`memory_create` / `memory_update` / `memory_invalidate` tools.

What you see: nothing directly. The effect surfaces on *future*
threads, when the model pulls a relevant memory via conversation
recall (below) and brings context forward without you having to
repeat yourself.

Memories are scoped to your Supabase account under RLS, so no other
user can read them — not even other users of the same deployment.
There's no in-app browser for them today; the only way to read or
edit a memory is through the assistant (ask it to recall, summarize,
or correct one).

Cost: one fast-tier call per settled thread, plus a few small tool
calls for any memory writes.

No toggle.

## Conversation recall

When the model decides a reply would benefit from prior context, it
calls the `conversation_recall` or `memory_recall` tool. A dedicated
fast-tier agent runs a semantic search across your past threads and
stored memories, digests the hits into a short paragraph, and returns
that paragraph to the main model, which folds it into its reply.

What you see: usually just a better-informed answer. If you watch
the tool-calls strip, you'll see `conversation_recall` or
`memory_recall` fire during recall-heavy turns. Tool failures
degrade gracefully — the main model continues without the extra
context and you get a reply that's a little less informed rather
than an error.

Triggered by the model itself (on its own judgment at turn start or
after a topic shift), not by the user. The system prompt cues the
model to call recall when useful; you don't need to ask.

Cost: one fast-tier agent call per recall, plus the embedding
lookup. Recall runs at most a handful of times per turn in practice.

No toggle. If you want recall to stay out of a specific reply, tell
the model directly ("don't look up prior context for this one") and
it will skip the call.

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

- [Security model](./security.md) - what's encrypted, what's stored
  plaintext, and what the master password protects.
- [Search](./search.md) - the user-facing side of the embeddings
  pipeline.
- [Models & reasoning](./models.md) - the fast tier that all
  background work runs on.

---
Back to the [index](./README.md).
