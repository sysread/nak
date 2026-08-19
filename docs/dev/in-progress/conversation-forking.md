# Conversation forking

Status: PLANNED - no milestone started yet. Update the milestone
checklist as work lands; graduate durable content into a permanent
`docs/dev/forking.md` (started in M3) and retire this doc when the
last milestone ships.

Read [`../architecture.md`](../architecture.md) and
[`../chat.md`](../chat.md) first; this plan assumes their
vocabulary (production-path ownership, the exchange slot model,
the worker/watermark pattern).

## SYNOPSIS

Fork a conversation - from the drawer (whole conversation) or from
any user / terminal-assistant message (partial). Forks share
history structurally: no rows are copied. Destructive edits inside
shared history become forks instead of deletes. A background GC
sweep reclaims rows no live conversation can reach.

## PURPOSE

Currently conversations are strictly linear. Exploring an alternate
direction from the middle of a conversation means delete-from-here,
which destroys the original branch, or copy-pasting into a new
thread, which loses attachments, reasoning traces, and all derived
state. There is no way to keep both timelines.

The deeper problem this plan fixes on the way: message order is
decided by `created_at`, a timestamp written by two different
clocks (browser for user rows, edge function for assistant/tool
rows), and two code paths already forge timestamps to control
ordering. Forking needs a crisp "everything up to point X"
predicate, which timestamps cannot provide.

## DESIGN

### Data model

Messages get an explicit per-thread **position** (numeric, unique
within the thread, assigned at insert). `created_at` stays as
display metadata only.

Threads get three columns:

- `forked_from_thread_id` - parent thread; null for roots.
- `forked_from_msg_id` - the fork point: the last message the fork
  shares with its parent. Null iff the parent column is null.
- `hidden` - boolean. A hidden thread is structure only: it holds
  rows other threads depend on, but nobody is talking in it and no
  list surface shows it.

The mental model shift: a thread row stops owning "a conversation"
and starts owning a **segment** - the run of messages it minted
itself. A conversation is the concatenation of segments along the
path from a root thread down to one node. Threads form a forest
(each node has at most one parent, set at creation, never
changed); the forest is a trie of conversation histories, with
shared prefixes stored once near the roots.

### Invariants

1. A fork point always lands in the segment of the thread it
   points at (the "reparent rule" below guarantees this).
2. Shared rows are never mutated or destroyed by user action. Only
   the GC destroys rows, and only unreachable ones.
3. After a GC pass: every leaf thread is visible, and every hidden
   thread has at least one visible descendant.
4. Forking never crosses users - every thread on an ancestor path
   belongs to the same `user_id`, so existing RLS (via thread
   ownership) covers cross-segment reads with no policy changes.

### Transcript resolution

One SQL function resolves a thread's full transcript: walk the
ancestor chain, take each ancestor's segment up to the relevant
fork position, then the thread's own segment, ordered by (depth,
position). Rows come back with their owning `thread_id` so callers
can tell inherited prefix from owned tail. Exposed as an RPC for
the browser (PostgREST cannot express the recursion) and called
directly by the edge-function agents. This is the single choke
point every full-transcript reader goes through; with zero forks
in the database it degenerates to exactly today's one-thread query.

The streaming chat loop needs no switch of its own: it never reads
the messages table for history - it receives the transcript in the
request body, built by the browser from its in-memory message
list. The loop therefore inherits fork resolution the moment the
browser's message load switches to the resolver. The edge-function
agents are the opposite case: they read transcripts directly from
the DB and are exactly the readers the resolver switch targets.

### Fork semantics

`forkConversation(threadId, msgId)` - one primitive for every
entry point:

- Validates the fork point is a user row or a terminal assistant
  row (not a tool row, not a mid-round assistant row carrying
  tool_calls).
- **Reparent rule:** the new thread's parent is whichever thread
  *owns* the fork-point message - which may be an ancestor of the
  thread the user was looking at, not that thread itself. This
  keeps invariant 1 structural.
- Inherits: title (verbatim), `title_manually_set`, model pin,
  reasoning-effort pin, verbosity pin, `toolboxes_enabled`.
- Does NOT inherit: summary, topics, cached priming payloads
  (intuition / context-recall - they are keyed to message ids and
  would mis-prime the fork), archived state, response claims.
- Worker cursors start **null** - nothing is seeded. This is
  sufficient: a fresh fork's own segment is empty, so the claim
  RPCs find no terminal message and never fire; once the first
  post-fork turn lands, the per-thread "rows since cursor" reads
  cover only the fork's own segment, and the inherited prefix
  (owned by ancestors) can never match a per-thread query. The
  prefix is structurally unreachable for re-processing. Seeding
  cursors to the fork point was considered and rejected: the
  fork-point message belongs to another thread, and a cursor id
  that a worker's own per-thread query can never return is a
  cross-thread oddity every cursor consumer would have to
  tolerate.

Two callers:

- **Explicit fork** (drawer menu, message-card button): parent
  stays visible. Both threads live side by side.
- **Edit-fork** (delete-from-here / regenerate inside a shared
  region): fork at the appropriate predecessor, then the edited
  thread is hidden and the fork takes its place in the UI -
  selection swaps, the drawer row is effectively "the same
  conversation, minus the deleted turns". The user's deletion
  intent is honored in everything they can see.

**Shared-region test** (decides destructive edit vs edit-fork):
an edit range is shared iff it touches inherited rows (owned by an
ancestor) or rows at-or-before the highest fork position among the
thread's live children. Edits strictly inside the private tail
stay destructive, exactly as today - the common case is unchanged.

Edge cases:

- Delete-from-here on the first message with no inherited prefix:
  degenerates to "fresh thread + hide the old one" (a fork with an
  empty prefix is just a new thread; no parent link needed).
- Edit inside an inherited prefix: the new fork's parent is the
  segment owner (reparent rule); the edited thread is hidden and,
  having no children of its own, becomes GC-collectible
  immediately.
- Regenerate in a shared region: fork with the anchoring user
  message as the fork point, hide the edited thread, then run the
  completion on the fork - no `supersededIds`, because nothing in
  the fork needs deleting. The existing superseded-rows path stays
  for private-tail regenerates.
- Recovery synthesis over an unhealed inherited prefix (the parent
  was interrupted mid-turn and the user forked from before the
  interruption): the in-memory synthesis runs as usual so every
  reader sees a wire-valid sequence, but the persistence pass must
  only write synthetic rows whose gap lies in the fork's **own
  segment** - persisting into an ancestor's segment would drop
  rows into the wrong thread's coordinate system. Inherited-prefix
  gaps stay in-memory-only for the fork; they heal durably when
  (and only when) a thread that owns the gap revisits it.

### Whole-thread deletion

Rewired to "set hidden = true", full stop. If the thread has no
live descendants the GC destroys everything on its next pass -
today's destructive delete, deferred by one sweep cycle. If it has
descendants, the shared prefix survives as structure. The inline
attachment/storage reclamation currently in the delete path
retires; the daily attachment-gc (already reference-checked
against live rows) reclaims objects after GC cascades. Verify
during M3 that the daily sweep also covers rendered-PDF page
objects, since the inline path reclaimed those explicitly.

### GC

A scheduled SQL function (pg_cron, alongside the existing sweeps),
also callable ad hoc for tests. Schedule it at minute :43 - the
hourly ladder is dense (3, 7, 13, 17, 23, 27, 33, 37, 47, 53, 57
are taken, plus every-minute and every-ten-minute jobs), and :43
is the gap clear of all of them. Per pass:

1. Compute each thread's **keep watermark**, bottom-up over the
   forest: infinity if visible; else the max fork position among
   live children; else nothing.
2. Process threads in a single **leaf-to-root** pass. Per thread:
   watermark "nothing" means delete the thread row (its children
   are already gone by the traversal order, and the cascade
   removes its segment); a finite watermark means the thread
   survives and only its segment rows past the watermark are
   trimmed. The existing cascade / set-null policies handle every
   downstream table - they were all designed for row destruction
   already.

The leaf-to-root order is load-bearing, not a style choice. A
chain of hidden threads that are all collectible (edit-fork of an
edit-fork, then the leaf is deleted) has each child's fork-point
FK pointing into its parent's segment. Deleting a parent's rows -
directly or via thread-row cascade - is blocked by the restrict FK
until the child thread row is gone, so children must be collected
before parents. A two-phase design (trim all segments, then drop
all empty threads) deadlocks on exactly this case.

The GC never touches a reachable row, so `forked_from_msg_id`
(declared `on delete restrict` as a belt-and-suspenders check) can
never dangle: the restrict FK turns a GC ordering bug into a loud
error instead of a silently broken fork.

### Reference-graph audit (why destruction is already safe)

Every existing inbound reference to messages or threads falls into
one of three deliberate classes, each already commented in
schema.sql:

- **Cascade** (dies with the source): attachment link rows, chunk
  rows, samskara traces, bias rows, memory-conversation links,
  wiki source links.
- **Set-null** (record outlives the link): worker watermarks, wiki
  provenance, bias evidence deep-link, intent seeds, agent-run log
  pointers.
- **Soft pointer, no FK** (dangles; rebuilt next cycle): chunk
  start/end anchors, samskara message references.

The GC only ever destroys unreachable rows, so these policies fire
in exactly the situations they were designed for. The one new
reference - the fork point - is the restrict FK above.

### Worker treatment

Two families, decided by whether re-processing shared prefix rows
would duplicate output:

| Worker | Reads | Treatment |
| --- | --- | --- |
| summary | full transcript | resolver + fork framing; summary covers the whole conversation (the fork IS a whole conversation); nothing runs until the first post-fork turn (empty own segment = no terminal message for the claim RPC) |
| thread topics | full transcript | same as summary |
| reflection (memory) | new rows since cursor | cursor starts null; per-thread reads cover only the own segment, so the prefix (already reflected in the parent) is never re-read - no duplicate memories |
| samskara evaluation | new rows since cursor | cursor null; same rationale |
| wiki extraction + wiki records | new rows since cursor | cursor null; per-thread scope keeps the prefix out, so no duplicate wiki records |
| chunker / embeddings | own segment only | does NOT switch to the resolver - chunks the thread's own rows; shared prefixes are already chunked under their owning thread, so recall search dedups for free |
| second thoughts | current turn only | no change - the turn anchor is always at-or-after the fork point |
| bias | full transcript | resolver + fork framing |
| context recall / intuition priming | full transcript | resolver + boundary marker; cached payloads never inherited |
| conversation_get tool / recall agents | other threads' transcripts | resolver + boundary marker; list-style tools filter hidden threads; direct-id fetch of a hidden thread stays allowed (its content is part of live conversations) |
| auto-title | placeholder-titled threads | no code change, but note: a fork of a still-placeholder-titled parent inherits the placeholder, so the poll matches the fork and titles it independently. Acceptable - both threads get real titles - but two threads sharing an opening may get near-identical titles |
| followups | user-scoped, cross-thread | no change - followups attach to the user's life, not a thread, so they surface in forks (and survive hidden parents) by existing design |
| digest | day-window across threads | no change; note the gotcha that pre-fork rows report under the owning (possibly hidden) thread's title |

**Fork framing presentation** (for the workers marked "fork
framing"): rather than only a preamble sentence, insert a marker
line into the rendered transcript at the boundary, plus one
preamble line, so the boundary is visible exactly where it matters
even after transcript trimming:

```text
This conversation was forked from "<parent title>". Messages
above the FORK POINT marker are inherited context from the parent
conversation; treat them as background. <task-specific clause>.

...inherited rows...
==== FORK POINT - messages below belong to this conversation ====
...owned rows...
```

The task-specific clause per worker (exact copy written at
implementation, reviewed against each prompt's existing voice):

- summary / topics: "Summarize / tag the conversation as a whole,
  including the inherited context - the fork reads as one
  conversation to the user."
- bias: "Only cite evidence from below the marker; the inherited
  rows were already analyzed in the parent conversation."
- recall / conversation_get: no task clause - the marker alone;
  these are read-only context assemblers.

### Recall and search surfaces

- Thread list queries, search (title ILIKE + semantic), the topics
  filter, and list-style tools all exclude hidden threads.
- A semantic chunk hit on a hidden thread resolves to its nearest
  visible descendant whose prefix contains the chunk (walk down
  choosing children whose fork position covers the chunk's
  position range; dedupe multiple hits landing on one visible
  thread). Without this, recall would surface conversations the
  user cannot open.

### UI

- **Drawer row menu**: new "Fork" item (text, like its siblings)
  between Rename and Download transcript; disabled for drafts;
  forks the whole conversation (fork point = tail message),
  creates + opens the fork.
- **Message cards**: fork button on user rows and terminal
  assistant rows, in the existing `.msg-actions` strip. Icon is
  the Feather **git-branch** outline SVG (14px, 2px stroke) to
  match the trash / activity icons - the codebase uses stroke
  SVGs, not unicode glyphs, for card actions.
- **Hover preview**: reuses the shared regen-preview channel to
  red-outline every row after the fork point, exactly like
  regenerate / delete-from-here per the UX spec; the tooltip copy
  carries the semantic difference ("Fork here - later messages
  stay in this conversation").
- **Edit-fork signaling**: when delete/regenerate hover lands in a
  shared region, the tooltip switches to "will continue in a new
  fork" copy. Outline stays red (decided; a distinct color was
  considered and rejected to keep one danger language).
- **Drawer fork indicator**: forked threads show a small
  git-branch glyph before the title. After an explicit fork,
  parent and child sit adjacent with identical titles; the
  indicator is what tells them apart.

## MILESTONES

Ordered so the structure lands first and every milestone is
verifiable against existing behavior before the next builds on it.
M1-M3 change zero observable behavior; each ships with the gate
green and its QA baseline re-executed.

### M0 - QA baselines (before any code)

Per the docs/qa rules: backfill use-cases FIRST and execute them
against unchanged code, so post-change runs prove preservation,
not just self-consistency.

- New use-case: message ordering + delete-from-here (covering the
  mid-transcript recovery-row insertion and the delete gesture;
  today neither has a walkthrough).
- Re-execute existing: chat-regenerate-from-here,
  threads-management (delete/archive), chat-streaming-turn.
- Log baseline rows in each results table.

### M1 - explicit message positions

Pure ordering refactor; transcripts render identically.

- Schema: `messages.position numeric`; backfill per thread by
  (created_at, id); before-insert trigger assigns floor(max)+1
  under a per-thread row lock on the parent thread; unique index
  on (thread_id, position).
- The thread-row lock is NEW contention the trigger introduces,
  not a lock writers already held: the edge function's round
  persistence inserts touch only the messages table, and the
  browser's insert updates the thread row in a separate call after
  the insert, not in the same transaction. The lock is exactly the
  serialization appends need (two writers on the same thread take
  turns; different threads never contend), and insert transactions
  are short, but it is a behavior change to acknowledge, not a
  free ride on an existing lock.
- Index companions for the ordering switch: the two indexes that
  serve created_at ordering today - the per-thread transcript
  index and the partial streaming-probe index - need position
  equivalents ((thread_id, position asc); (thread_id, position
  desc) where streaming), or the switched queries sort on top of a
  scan. Drop the created_at versions in the same change once the
  last reader has switched - dead indexes are dead code.
- Switch every message read site from order-by created_at to
  order-by position (~10 files: browser list, edge agents, tools).
- Switch the SQL side too: schema.sql has ~14 per-thread
  `order by m.created_at` sites inside RPC functions - the claim
  RPCs that find a thread's terminal message (reflection,
  evaluation, summary, topics, wiki, wiki-records) and the
  auto-title first-user lookup. These MUST move to position in the
  same milestone: post-M1, recovery rows carry honest timestamps
  but fractional mid-transcript positions, so the two orderings
  genuinely disagree about which row is terminal. Cross-thread
  orderings (picking which thread to process first, e.g.
  `order by newest.created_at`) stay on created_at - those are
  wall-clock comparisons between threads, not within-thread order.
- Replace the two timestamp forgeries: the recovery path inserts
  at fractional midpoints instead of forged created_at; the
  move-to-tail path sets position = max+1 instead of re-stamping
  created_at.
- Verify: gate + M0 ordering baseline re-run.

### M2 - fork columns + transcript resolver

Still zero behavior change: the columns exist but are always null,
so the resolver provably returns exactly the old per-thread query.

- Schema: the three thread columns (parent FK restrict, fork-point
  FK restrict, hidden default false).
- The `thread_transcript` SQL function + browser RPC wrapper.
- Switch the full-transcript readers to it (browser listMessages,
  context agent, summary/topics/bias/recall/conversation_get,
  agent-tools transcript loader). The chunker and the by-id /
  windowed readers stay on direct queries per the worker table.
- Audit consumers of the browser message list for a uniform
  `thread_id` assumption: post-resolver, the list contains rows
  from ancestor threads too (UUID ids keep id-keyed merging
  correct, but anything reading a row's thread_id to answer
  "which thread am I in" gets an ancestor's id on a fork).
- Verify: gate + streaming and regenerate baselines re-run.

### M3 - hidden threads + GC + delete rewired

Externally identical delete behavior via new machinery.

- All thread list / search / poll surfaces filter hidden. Missing
  one puts a hidden thread back in the drawer, so enumerate rather
  than trust "all": the four list methods (recent / older /
  archived / since), searchThreads (both the exact ILIKE query and
  the semantic-hit re-fetch), the topics-filter paths, the
  auto-title placeholder poll, the realtime thread-change handlers,
  and every list-style conversation tool. Grep for `from('threads')`
  and the thread-facing RPCs and check each site against this list.
- The semantic chunk-search RPC is on that list and easy to miss
  because it is server-side: it joins chunks to threads filtering
  only by user, and BOTH of its edge-function callers (the
  conversation-search tool and context-recall's conversation
  layer) exclude only the current thread post-fetch. Without a
  hidden filter in the RPC, a deleted thread's chunks keep
  surfacing in recall until GC collects them. Add the one-line
  hidden filter in M3. NOTE the M4 handoff: once forks exist, a
  hidden ancestor's chunks are live content (they belong to
  visible conversations' prefixes), so M4's hidden-hit resolution
  must REPLACE the blanket filter on the semantic path - include
  hidden threads' chunks, resolve each hit to the nearest visible
  descendant, drop hits with none. Leaving the M3 filter in place
  through M4 would silently blind recall to every shared prefix.
- Whole-thread delete becomes "hide"; inline storage reclamation
  retires (daily attachment-gc takes over; confirm PDF-page
  coverage).
- GC function + pg_cron schedule + ad hoc invocation for tests.
- Start `docs/dev/forking.md` with the data model + invariants.
- Verify: gate; QA case "delete thread, run sweep, DB end state
  matches old destructive delete"; threads-management baseline.

### M4 - fork primitive + drawer Fork + worker treatment

First user-visible feature. Forks can now exist, so everything
that must be fork-aware lands in this milestone, not later.

- `forkConversation` (supabase slice + any SQL support): creation,
  inheritance list, null cursors (no seeding - see the fork
  semantics section), reparent rule.
- Drawer menu "Fork" item; open-on-create; drawer fork indicator.
- Worker fork framing (marker + preamble per the table).
- Recall/search hidden-hit resolution (hidden threads become
  reachable-but-invisible for the first time here: fork + delete
  parent).
- Docs: `docs/user/` forking page (new); dev doc grows.
- QA: new fork-conversation use-case (fork, converse in both,
  verify prefix shared + workers don't double-process).

### M5 - fork-from-message

Small delta on M4.

- Card button (user + terminal assistant rows) + git-branch SVG +
  hover range preview via the regen channel.
- Vitest primitives for the fork-range computation (mirror of
  computeRegenerateRangeIds; register any DOM-touching test file
  in environmentMatchGlobs).
- Docs + QA case.

### M6 - edit-forks (fork-on-delete / fork-on-regenerate)

The behavior-changing milestone; its baselines were locked in M0.

- Shared-region test primitive (inherited rows + max live-child
  fork position).
- Delete-from-here in a shared region: fork at the predecessor,
  hide the edited thread, swap selection.
- Regenerate in a shared region: fork at the anchoring user
  message, hide, run the completion on the fork (no superseded
  ids).
- Tooltip copy switch in shared regions.
- Docs + QA: re-execute the M0 delete/regenerate baselines in
  private-tail scenarios (must match baseline exactly) plus new
  shared-region walkthroughs.

## Gotchas to carry into the permanent doc

- Deleted content in a shared prefix persists as long as any fork
  lives - inherent to structural sharing; the user docs must say
  so plainly.
- The digest reports pre-fork rows under the owning (possibly
  hidden) thread's title for the day they were written - a title
  the user can no longer find in the drawer. Mitigation to decide
  during M4: resolve a hidden owning thread to its nearest visible
  descendant for display, the same resolution the recall/search
  surfaces use for chunk hits.
- The response-claim system is per-thread; parent and fork can
  stream concurrently by design.
- Position is numeric on purpose (fractional recovery inserts);
  never assume integers.
