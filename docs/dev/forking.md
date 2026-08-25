# Conversation forking

Forked conversations: explicit message positions, fork columns on
threads, the `thread_transcript` resolver, hidden threads, the fork
GC, the fork primitive with its drawer entry point, worker fork
framing, and hidden-hit search resolution. The remaining entry
points (fork-from-message card buttons, edit-forks on
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

## Creating a fork

One primitive serves every entry point: `forkThread` in the threads
slice of the Supabase layer (facade method of the same name). It
resolves a fork point, applies the reparent rule (the new thread's
parent is whichever thread OWNS the fork-point message), and inserts
the new thread row. What the fork inherits from the thread the user
forked: title behind a fork marker (the fraktur-f sigil plus a
subscript ordinal counting forks minted from the same fork-point
message; forking a fork re-marks the base title rather than
stacking sigils, and the untitled placeholder passes through
unmarked so the auto-title worker still claims the fork - see
forkTitle in src/lib/forking.ts), the manual-title flag, the model /
reasoning / verbosity pins, and the enabled toolboxes. What it does
NOT inherit: summary, topics, cached priming payloads (they are
keyed to message rounds and would mis-prime the fork), archived
state, response claims, and every worker cursor - null cursors are
deliberate, see "Worker treatment" below.

Fork-point rules live in `src/lib/forking.ts` as pure primitives: a
fork can anchor on a user row or a settled assistant row without
tool calls. Mid-round assistant rows and tool rows would freeze a
dangling exchange into the shared prefix, and a still-streaming row
is not settled content yet. The drawer's whole-conversation fork
walks back from the segment tail past invalid rows to the newest
anchor; a fork whose own segment is still empty falls back to its
own fork point, minting a sibling.

UI: the drawer row menu's "Fork" item (disabled for drafts) creates
and opens the fork; forked threads render a muted git-branch glyph
before the drawer title alongside the title's own fork marker. The
fork ordinal is a count-then-insert (no atomicity): concurrent forks
of the same point can mint duplicate ordinals, a cosmetic title
collision and nothing structural.

## The chat turn on a fresh fork

The marked title doubles as a "this fork has not found its own
direction yet" signal, and the chat turn keys on it: while the
title still carries the fork marker, every completion gets two
additions, and the moment the fork is renamed both disappear - a
settled fork reads as fully its own conversation.

- The per-turn metadata system message gains a fork section: this
  conversation was branched from "<base title>", the history above
  the FORK POINT marker is shared, and once the direction the user
  wants becomes clear the model should rename via update_title
  BEFORE replying (same double-write guard as the regular title
  nudges). This section REPLACES the placeholder/drift nudges and
  ignores their gates on purpose: it fires from the fork's first
  turn (auto-title only claims placeholder titles, so nothing else
  will ever rename a marked title), and it fires even when
  title_manually_set was inherited - the marker, not the inherited
  pin, is what says "provisional".
- The wire gets the FORK POINT marker row spliced at the
  inherited/own boundary (wire-only; the display list never shows
  it), so the model can locate the seam the metadata section names.
  Same self-attributing copy as the workers' marker.

The rename lands through the ordinary update_title path, which
writes the title but leaves title_manually_set alone - a fork that
inherited a hand-pinned flag keeps it after settling, so later
topic-drift renames stay suppressed exactly as they were on the
parent.

## Worker fork framing

A forked thread's resolved transcript opens with inherited rows. The
live chat wire is unframed once a fork has settled - to the user and
the responding model, the fork IS the conversation - with one
transient exception: while the title still carries the fork marker,
the chat turn splices the FORK POINT row and a retitle nudge (see
"The chat turn on a fresh fork" above). Background
agents replaying the transcript always get the boundary explained,
in a provenance-marked voice (see
[`./prompt-augmentation.md`](./prompt-augmentation.md), "Provenance
markers and fourth-wall framing": unexplained instruction-shaped
insertions get flagged as prompt injection by hardened models).

The shared framing module (`_fork_framing.ts` under
`venice/agents/`) splices two system rows into a slice that
contains inherited rows: a preamble at the head naming nak and the
parent conversation's title, and a FORK POINT marker line at the
inherited/own boundary. The boundary is found by row ownership
(first row whose thread_id matches the requested thread), which
degrades correctly when transcript trimming drops part or all of
the prefix: fewer inherited rows move the marker, none at all
produce no framing. Unforked threads pay one array scan and are
returned untouched.

Where it applies:

- **The two shared transcript loaders** frame automatically, so
  every replay-style agent (summary, topics, reflection, wiki,
  wiki-records, samskara evaluation, the recall agents, intent
  employment) gets the same treatment with no per-agent wiring.
  Summary and topics pass a task clause ("cover the conversation as
  a whole") because their default reading of "inherited context"
  would wrongly exclude the prefix from their output.
- **Bias** builds a JSON payload rather than a message replay: it
  gets a `fork_note` field (preamble plus a "only cite evidence
  below the marker" clause - the inherited rows were already
  analyzed under the parent) and a marker entry without an id, so
  the observer cannot cite the marker as evidence.
- **conversation_get** splices the marker into its windowed
  transcript when the window straddles the boundary - marker only,
  no preamble, per the read-only-assembler posture.

## Hidden threads and deletion

Deleting a conversation sets `hidden = true` - nothing else. Every
list/search/poll surface excludes hidden threads server-side:

- Browser: the drawer's list reads and the exact search arm in
  `src/lib/supabase/threads.ts`, the bias debug modal's thread
  list.
- SQL: `list_user_topics` (the topics dropdown) and every thread
  claim RPC (summary, topics, auto-title, reflection, evaluation,
  wiki, wiki-records) - a deleted thread never spends agent tokens.
  The chunker claims are the deliberate exception (see the comment
  there): chunks are recall's index and a hidden thread's segment
  can be live shared prefix, so hidden threads still get chunked.
- `search_thread_chunks_by_embedding` (semantic search AND recall's
  conversation layer) does NOT filter hidden threads - it RESOLVES
  them. A hit on a hidden thread's chunk walks down the fork tree to
  the nearest visible descendant whose transcript contains the
  chunk's rows (first hop proves containment against the child's
  fork position; deeper hops are free because a grandchild inherits
  its parent's entire inherited prefix), presents that thread as the
  hit, dedupes to the strongest chunk per presented thread, and
  drops hits with no visible descendant - so a plain deleted
  conversation stops surfacing the moment it is deleted, while a
  shared prefix stays searchable through the fork that carries it.
  The recency filter and boost run against the PRESENTED thread's
  updated_at. Chunk anchors are soft pointers; a stale anchor cannot
  prove containment and drops out conservatively until the next
  rechunk.
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
- The daily digest reports pre-fork rows under the owning (possibly
  hidden) thread's title. Decided in M4: accepted without code. A
  fork inherits its parent's title behind a short fork marker, so
  the "unreachable" title the digest shows stays recognizable next
  to the visible fork's; a rename of the fork can drift them
  apart, which is cosmetic.
- Cross-user fork forgery (a hand-crafted insert pointing
  forked_from at another user's thread) is not schema-enforced.
  It leaks nothing - the resolver is SECURITY INVOKER, so RLS
  returns zero foreign rows - but it would pin the foreign thread
  against GC via the restrict FK. The browser primitive only forks
  rows RLS let it read; a schema-level guard (composite FK on
  user_id) was judged not worth the migration for a personal app.
- Realtime UPDATEs to inherited rows do not reach a fork's open
  message list (the subscription filters on the fork's own
  thread_id). Display-only staleness on rare paths (a
  second-thoughts verdict landing on a shared row); a refetch
  heals it.
- A restored pre-fork backup archive lacks the fork columns until
  the current schema.sql is applied to the target; the columns
  arrive null/false, which is the correct state for every pre-fork
  row.

## Interactions

- **Chat** ([`./chat.md`](./chat.md)) - the drawer Fork item +
  fork indicator, the delete gesture, the realtime hidden-as-delete
  handler, message ordering.
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
  RPC's hidden-hit resolution serves both drawer search and
  recall's conversation layer; conversation_get splices the fork
  marker into windowed transcripts.
- **Background workers** ([`./summaries.md`](./summaries.md),
  [`./topics.md`](./topics.md), [`./auto-title.md`](./auto-title.md),
  [`./memory.md`](./memory.md), [`./wiki.md`](./wiki.md)) - every
  thread claim RPC skips hidden threads; the chunker
  ([`./embeddings.md`](./embeddings.md)) deliberately does not.
  Transcript replays get fork framing via the shared loaders.
- **Prompt augmentation**
  ([`./prompt-augmentation.md`](./prompt-augmentation.md)) - the
  fork preamble and FORK POINT marker follow its provenance-marking
  convention (nak-attributed, descriptive voice).
