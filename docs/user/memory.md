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

When a new conversation starts or shifts to a new topic, the model
can call the `memory_recall` or `conversation_recall` tool on its
own initiative. Those tools run a semantic search across your stored
memories (and, for conversation recall, your prior threads) and
return a short digest the model folds into its next reply.

You'll usually just notice the side effect: the assistant knows
you're working on project X without being re-told, or it picks up a
style preference you corrected it on weeks ago. If you watch the
tool-call strip on a reply, you'll see the recall calls fire.

Recall runs on the fast tier too — the cost is a few cents of tokens
per invocation, at most.

## Browsing memories directly

Two entry points open the Memories browser:

- the bookmark icon in the drawer footer, between Help and the
  Cookbook's book icon
- the **Browse memories** link in Settings → AI

The browser lists every memory on your account, most recent first.
The search box runs a semantic match — paraphrases and synonyms
count, not just substrings — and falls back to plain substring
search when the embedding service is unreachable. Each row shows
the label, the full body, and when it was last touched.

From the list you can:

- **Edit a memory in place.** Clicking *Edit* swaps the row into
  label + body fields with character counters and an explicit
  *Save* button. A save-state badge under the fields shows
  *Unsaved changes*, *Saving…*, *Saved ✓*, or the error message
  if the write failed, so you never have to guess whether an edit
  landed on the server.
- **Reaffirm or doubt a memory.** *Reaffirm* nudges confidence up
  by 0.5; *Doubt* multiplies it by 0.7. The chip in the header
  row shows the resulting tag (corroborated / hedged / shaky) or
  a numeric value when it's in the neutral band.
- **Link memories.** *+ Relate* opens an inline picker: choose a
  relation kind (supports / contradicts / generalises /
  specialises), search for a target memory to link to, optionally
  add a short note, and click a candidate to create the edge.
  Existing edges show up under each memory's body; the small ×
  next to an edge removes it.
- **Delete a memory.** *Delete* asks you to confirm inline before
  issuing a hard delete (the same operation the assistant's
  `memory_delete` tool performs).

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
