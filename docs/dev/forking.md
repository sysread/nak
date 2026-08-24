# Conversation forking

The structural layer for forked conversations: explicit message
positions, fork columns on threads, the `thread_transcript`
resolver, hidden threads, and the fork GC. The fork ENTRY POINTS
(creating a fork from the drawer or a message card, edit-forks on
delete/regenerate) are still in flight - see
[`./in-progress/conversation-forking.md`](./in-progress/conversation-forking.md)
for the milestone plan. This doc owns the machinery that has
landed.

## Data model

A thread row owns a **segment** - the run of messages it minted
itself - not necessarily a whole conversation. A conversation is
the concatenation of segments along the path from a root thread
down to one node. Threads form a forest (each node has at most one
parent, set at creation, never changed); the forest is a trie of
conversation histories, with shared prefixes stored once near the
roots.

Three columns on `threads` carry the structure:

- `forked_from_thread_id` - parent thread; null for roots. FK with
  `on delete restrict`.
- `forked_from_msg_id` - the fork point: the last message the fork
  shares with its parent, always a row of the PARENT's own segment
  (the reparent rule below). FK with `on delete restrict`. A CHECK
  constraint keeps this null exactly when the parent column is
  null.
- `hidden` - the thread is structure only: it holds rows other
  threads' transcripts depend on, but no list surface shows it and
  nobody talks in it. Deleting a conversation sets this flag; the
  GC does the destruction.

Message order within a segment is `messages.position` - numeric on
purpose (the recovery path heals gaps at fractional midpoints;
never assume integers), unique per thread, assigned at insert by a
before-insert trigger unless the caller provides one. `created_at`
is display metadata and wall-clock comparisons only; a guardrail
test (`tests/ordering-guardrail.test.ts`) enforces a comment on
every deliberate created_at ordering.

**The reparent rule**: a fork's parent is whichever thread OWNS the
fork-point message - which may be an ancestor of the thread the
user forked from, not that thread itself. This keeps invariant 1
below structural rather than checked.

## Invariants

1. A fork point always lands in the segment of the thread it points
   at.
2. Shared rows are never mutated or destroyed by user action. Only
   the GC destroys rows, and only unreachable ones.
3. After a GC pass: every leaf thread is visible, and every hidden
   thread has at least one visible descendant.
4. Forking never crosses users - every thread on an ancestor path
   belongs to the same `user_id`, so thread-ownership RLS covers
   cross-segment reads with no policy changes.

## The transcript resolver

`thread_transcript(p_thread_id)` (schema.sql, "Conversation
forking" section) resolves a thread's full transcript: walk the
ancestor chain, take each ancestor's segment up to the fork point
its child recorded, then the thread's own whole segment, ordered
(segment depth, position). It returns `setof public.messages` -
rows verbatim, each carrying its OWNING thread_id, so callers tell
inherited prefix from owned tail by comparing against the id they
asked for.

Two contract points that bite if forgotten:

- **Row order is the function's contract.** Position restarts per
  segment (a fork's own segment starts at 1 while its inherited
  prefix also starts at 1), so callers must preserve arrival order
  and never re-sort by bare position. The function is plpgsql
  precisely so the planner can never inline away its ORDER BY.
- **SECURITY INVOKER.** Browser calls resolve through the
  threads/messages RLS policies (invariant 4 makes ownership cover
  the whole chain); agents call it through the service role.

Every full-transcript reader goes through it: the browser's
`listMessages`, the shared agent slice loader in
`_agent_tools.ts` (summary, topics, reflection, wiki, wiki-records,
samskara evaluation), the recall slice loader, the context
umbrella, bias, and the `conversation_get` tool. Per-segment
(chunker), by-id, windowed, and current-turn readers stay on
direct queries. With zero forks the resolver degenerates to the
plain per-thread query.

## Hidden threads and deletion

Deleting a conversation sets `hidden = true` - nothing else. Every
list/search/poll surface excludes hidden threads server-side:

- Browser: the drawer's list reads and the exact search arm in
  `src/lib/supabase/threads.ts`, the bias debug modal's thread
  list.
- SQL: `search_thread_chunks_by_embedding` (semantic search AND
  recall's conversation layer ride it), `list_user_topics` (the
  topics dropdown), and every thread claim RPC (summary, topics,
  auto-title, reflection, evaluation, wiki, wiki-records) - a
  deleted thread never spends agent tokens. The chunker claims are
  the deliberate exception (see the comment there): chunks are
  recall's index and an edit-forked thread's trimmed segment is
  live shared prefix, so hidden threads still get chunked.
- Realtime: the browser's thread-UPDATE handler treats
  `hidden = true` as the delete signal (removes the row from the
  drawer, closes it if active). The delete gesture reaches other
  devices as that UPDATE, not a DELETE event; the GC's later hard
  delete arrives as a DELETE for a thread already out of the UI.

## The GC

`collect_hidden_threads()` (service-role only; pg_cron job
`nak-fork-gc`, hourly at :43) reclaims what no live conversation
can reach. Per pass: compute the kept set (visible threads plus all
their ancestors), delete doomed thread rows deepest-first, then
trim surviving hidden threads' segments past their keep watermark
(the max fork position among their children).

The leaf-to-root deletion order is load-bearing: a doomed child's
`forked_from_msg_id` is a restrict FK into its parent's segment, so
the parent's rows cannot go until the child thread row is gone. The
restrict FKs turn a GC ordering bug into a loud error instead of a
silently broken fork. Cascades fan out through the reference graph
policies (attachment links, chunks, traces cascade; watermarks and
evidence pointers set-null; soft pointers dangle and rebuild), and
the orphaned storage objects are reclaimed by the daily
attachment-gc (see [`./file-storage.md`](./file-storage.md)).

With zero forks a pass is exactly the old destructive delete,
deferred one sweep cycle. It returns `(deleted_threads,
trimmed_messages)` so tests and the QA walkthrough can assert on
what a sweep did; run it ad hoc with
`select * from public.collect_hidden_threads();` as service role.

## Gotchas

- Deleted content in a shared prefix persists as long as any fork
  lives - inherent to structural sharing.
- The M4-to-M6 window (forks exist, edit-forks don't) is
  corruption-safe by construction: delete-from-here and regenerate
  ranges run to the tail, so a range starting in an inherited
  prefix always includes the fork-point row and the restrict FK
  fails the whole statement loudly.
- `search_thread_chunks_by_embedding`'s blanket hidden filter must
  be REPLACED by hidden-hit resolution when forks ship (M4) - a
  hidden ancestor's chunks are live content by then. The comment on
  the RPC carries the handoff.
- A restored pre-fork backup archive lacks the fork columns until
  the current schema.sql is applied to the target; the columns
  arrive null/false, which is the correct state for every pre-fork
  row.

## Interactions

- **Chat** ([`./chat.md`](./chat.md)) - the drawer delete gesture,
  the realtime hidden-as-delete handler, message ordering.
- **Exchange** ([`./exchange.md`](./exchange.md)) -
  `mergeMessagesById` is segment-aware: inherited prefix rows keep
  resolver order; only own-segment rows position-sort.
- **Attachments / file storage**
  ([`./attachments.md`](./attachments.md),
  [`./file-storage.md`](./file-storage.md)) - thread deletion's
  object reclamation now rides the GC cascade + daily attachment-gc
  instead of inline removal.
- **Search / recall**
  ([`./conversation-recall.md`](./conversation-recall.md),
  [`./context-recall.md`](./context-recall.md)) - the chunk-search
  RPC's hidden filter serves both drawer search and recall's
  conversation layer.
- **Background workers** ([`./summaries.md`](./summaries.md),
  [`./topics.md`](./topics.md), [`./auto-title.md`](./auto-title.md),
  [`./memory.md`](./memory.md), [`./wiki.md`](./wiki.md)) - every
  thread claim RPC skips hidden threads; the chunker
  ([`./embeddings.md`](./embeddings.md)) deliberately does not.
