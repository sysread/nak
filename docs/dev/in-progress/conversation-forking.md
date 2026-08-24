# Conversation forking

Status: M0-M3 done; M4 implemented, awaiting QA. Update the milestone
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

### Data safety: deploy windows and rollback

The deploy pipeline applies schema + edge functions minutes before
the new frontend goes live, so every milestone has a mixed-version
window: OLD frontend against NEW schema and functions. The
standing constraint: **each milestone's schema must serve both
frontends during that window.** The plan's milestones satisfy it
by being purely additive - new columns with safe defaults, new
functions, new indexes; no existing column dropped or retyped, no
existing FK changed. The M1 recovery-row divergence (documented in
M1) is the only known window artifact, and it mis-orders
transiently rather than losing anything.

Rollback is loss-free at every milestone:

- M1 revert: the position column stays (additive) and code
  reverts to created_at ordering, which matches position order
  for backfilled and normally-appended rows alike. NULL
  stragglers wait for the next apply's backfill sweep.
- M2 revert: fork columns are all NULL; the resolver goes
  uncalled; direct queries return identical rows.
- M3 revert: code reverts to destructive delete. Threads hidden
  but not yet swept reappear in the drawer - a UX surprise, not
  data loss; the user deletes them again destructively. Threads
  the GC already collected are permanently gone, which is not a
  loss either: the user deleted them, and this is exactly the
  outcome today's destructive delete produces, deferred one sweep.
- M4+: forks and hidden ancestors are real data by then; revert
  means disabling entry points, not reverting reads - the
  resolver and hidden filters must stay.

The single operation with corruption reach is the M1 position
backfill - the only statement that touches every existing message
row. Its guards (deterministic ordering, NULL-only idempotence,
per-thread-max offset) are specified in M1; nothing else in the
plan modifies existing rows at all.

**Backup/restore interaction** (verified against the landed
`mise run backup` / `mise run restore` tooling): a restore applies
the backup's OWN schema dump and then a copy of the repo's
schema.sql that was **frozen into the archive at backup time** -
it does not read the current repo. So restoring a pre-M1 backup
after M1 ships leaves the database without the position column,
while the deployed code expects it. The required follow-up step:
after restoring an archive older than M1, apply the current repo
schema.sql to the restored target (the linked project gets this
from `mise run sync` or the next deploy's sync job; local, apply
schema.sql via psql). That apply creates the column as NULL and
the backfill sweeps every row into correct per-thread positions.
The data apply runs with triggers disabled (replica role), which
is also covered: restored rows land with NULL positions and the
same sweep assigns them. Post-M1 backups carry positions in the
data dump and restore verbatim; the NULL-only backfill is a no-op
over them. The dependency runs one way: the backup tool needs
nothing from this plan, but weakening either backfill guard
(NULL-only idempotence, per-thread-max offset) silently breaks
older-archive restores.

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

The marker and preamble are nak-inserted framing inside content a
model reads, which is exactly the class of text the provenance
convention in
[`../prompt-augmentation.md`](../prompt-augmentation.md)
("Provenance markers and fourth-wall framing") now governs: an
injection-hardened model that meets unexplained instruction-shaped
insertions flags them as prompt injection (observed in prod on the
priming think chain, which is why that convention exists). When M4
writes this copy: name nak as the source of the marker line, keep
the preamble descriptive rather than second-person imperative, and
if any fork framing ever rides an injected `<think>` block, follow
that section's full contract (marker comment, SUBCONSCIOUS_BLOCK
registration, first-person voice).

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

Status: DONE (2026-08-21). Use-cases shipped and executed against
unchanged code by a local QA agent; baseline rows are in each
results log, stamped with the docs-only commits. A pre-M1 backup
of the hosted project was taken. The runs also surfaced five
pre-existing app bugs, fixed and QA-re-verified in the same PR
(MCP tool names 400ing agent sub-completions, the aborted-regen
orphan round, the interrupted-prune view lie, stopped tool calls
rendering failed after server-side success, leaked think blocks -
plus the mid-stream Stop misclassifying as a network error, which
gated the regen rollback). Net effect for M1: the baselines
describe INTENDED behavior, so its re-runs diff against a clean
contract. Two cosmetic observations remain open, logged in the
regenerate case's results row: an intermittent stale regen-grey on
rebuilt rows, and generated-image cards not greying inside a regen
range.

Per the docs/qa rules: backfill use-cases FIRST and execute them
against unchanged code, so post-change runs prove preservation,
not just self-consistency.

- New use-cases: chat-message-ordering (display vs DB order, the
  tool-round re-stamp, mid-transcript recovery persistence) and
  chat-delete-from-here (visibility, hover preview, delete
  semantics incl. attachment reclamation, mid-send disable).
- Re-execute existing: chat-regenerate-from-here,
  threads-management (delete/archive), chat-streaming-turn.
- Log baseline rows in each results table.

### M1 - explicit message positions

Status: DONE (2026-08-21). QA re-ran the ordering baseline (PASS
5/5 - same observable transcript as M0, with the M1 contract
verified: terminal-reply position above its tool rows while its
created_at honestly precedes them, fractional recovery positions
mid-conversation), the streaming case (PASS 5/5 - stream inventory
unchanged), and a delete-from-here spot-check (position assignment
is gap-tolerant after a range delete). One incidental QA
observation, pre-existing but fixed in the same PR (dishes as we
cook): the M0 think-leak relocation only matched a full leading
`<think>` tag, missing leaks whose `<` the provider glitched away
(content starting with bare `think>`; seen on deepseek-v4-flash) -
the matcher now treats both tags' leading `<` as optional. Deltas
from the spec below, chosen at implementation:

- Move-to-tail took the RPC option (`move_message_to_tail`), not
  read-then-write: it shares the insert trigger's thread-row lock,
  so it cannot race a concurrent insert's tail assignment.
- The recovery synthesizer assigns each synthetic row its
  fractional position at synthesis time (between its real
  neighbors, always strictly below the next integer so the tail
  trigger can never collide with a healed row). The in-memory
  view, the merge sort, and the persistence pass all read the same
  value, and the persistence pass no longer needs its own
  anchoring walk. A side benefit: the unique (thread_id, position)
  index turns the cross-tab double-heal race into an insert error
  instead of duplicate recovery rows.
- The guardrail test (tests/ordering-guardrail.test.ts) enforces a
  nearby "wall-clock" / "legacy order" comment on every deliberate
  created_at ordering of messages, rather than a line-number
  allowlist - self-maintaining, and it doubles as the "non-
  conforming code requires a comment" rule. Sanity pins on the
  known allowed sites keep the scanner honest.
- Deliberately NOT switched: commit_assistant_message's
  newer-user-message conflict check still compares user rows by
  created_at. User rows are never forged and always tail-append,
  so the two orderings agree; it is a comparison, not an ORDER BY,
  so the guardrail ignores it. Revisit when M2's resolver work
  touches that RPC.
- The five day-gate "newest message" laterals and the digest's
  cross-thread day window stay on created_at on purpose (they ask
  when the thread last saw a write, not transcript order); each
  now carries the wall-clock comment the guardrail requires.

Pure ordering refactor; transcripts render identically.

- Schema: `messages.position numeric`; backfill per thread by
  (created_at, id); before-insert trigger assigns floor(max)+1
  under a per-thread row lock on the parent thread; unique index
  on (thread_id, position).
- The backfill MUST be collision-safe: assign
  per-thread-max(existing position) + row_number(), never
  row_number() alone. Two reasons. First, schema.sql re-applies
  start-to-finish on every deploy, so the backfill statement runs
  forever with its `where position is null` guard - it is a
  permanent sweeper for NULL stragglers, not a one-shot migration.
  Second, stragglers are real: within a single schema apply there
  is a window between the backfill statement and the trigger's
  creation where a concurrent insert lands with a NULL position
  (the unique index admits NULLs). A non-offset backfill would
  then assign that straggler position 1, collide with the unique
  index, fail the schema apply, and block every deploy after -
  a deploy-blocking landmine, not a display glitch.
- The SQL has a trap that turns the clear prose into exactly that
  landmine: computing the max in the same subquery that filters
  `where position is null` aggregates over ONLY the NULL rows, so
  max is NULL, coalesces to 0, and positions start from 1. The max
  must be computed over ALL rows first, then joined to the NULL
  rows:

  ```sql
  with thread_max as (
    select thread_id, coalesce(max(position), 0) as mx
      from public.messages group by thread_id
  ), null_ranked as (
    select m.id,
           tm.mx + row_number() over (
             partition by m.thread_id
             order by m.created_at, m.id
           ) as new_pos
      from public.messages m
      join thread_max tm on tm.thread_id = m.thread_id
     where m.position is null
  )
  update public.messages m
     set position = nr.new_pos
    from null_ranked nr
   where m.id = nr.id;
  ```

- The trigger assigns ONLY when the incoming row has no position;
  a caller-provided value passes through untouched. The recovery
  path depends on this: it inserts at fractional midpoints, which
  the trigger must not override with a tail position. Concretely,
  the browser insert helper's created_at override is replaced by
  an optional position parameter.
- The move-to-tail path is an UPDATE, so the trigger never fires
  for it: it must set position = floor(max)+1 explicitly. The
  client library cannot express a subquery in an UPDATE, so this
  is a read-then-write (safe: the response claim serializes the
  streaming loop per thread) or a one-line RPC.
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
  at fractional midpoints instead of forged
  neighbor-created_at-plus-1ms; the move-to-tail path sets
  position explicitly instead of re-stamping created_at (both per
  the trigger/UPDATE mechanics above).
- Known deploy-window divergence, accepted: the deploy applies
  schema + edge functions minutes before the new frontend, so an
  old-frontend recovery insert in that window carries no position
  and the trigger puts it at the tail - new readers see it at the
  end while the old frontend shows it mid-conversation via the
  forged timestamp. Narrow (minutes), rare (recovery rows only),
  self-healing (post-deploy recovery uses fractional positions),
  and no data is lost - only transiently mis-ordered for agents.
- Prove completeness of the switch, don't assert it: grep for
  `order by.*created_at` (TS and SQL) and require every remaining
  hit to be one of the documented cross-thread orderings. Ship it
  as a guardrail test with an explicit allowlist of the legitimate
  sites (same pattern as the existing style/markdownlint guardrail
  tests), not a one-time manual check - the failure mode this
  guards against is invisible on fresh data, where created_at
  order and position order coincide; it only diverges once a
  recovery row lands with a fractional position and an honest
  timestamp. A missed reader works in every demo and misorders
  exactly the transcripts that needed healing, and a guardrail
  keeps the next session from reintroducing one.
- Verify: gate + M0 ordering baseline re-run.

### M2 - fork columns + transcript resolver

Status: DONE (2026-08-24). Gate green; QA re-ran the streaming
baseline (PASS 1-5, identical to M1) and the regenerate baseline
(PASS 1-7, identical to M1's re-run), and spot-checked the DB: fork
columns all null, and thread_transcript's output full-outer-join
diffed against the direct per-thread query with zero mismatches -
same ids, positions, thread_ids, and order. Deltas and findings from
the spec below, chosen at implementation:

- The resolver is one SECURITY INVOKER plpgsql function returning
  `setof public.messages` - not a separate browser wrapper. The
  browser calls it as an RPC and RLS scopes the whole ancestor
  chain (forks never cross users); the agents call the same
  function through the service role. Returning the table type
  keeps the column list tracking the messages table automatically.
- Row order is the function's CONTRACT, not a convention: position
  restarts per segment, so callers must preserve arrival order and
  never re-sort by bare position. plpgsql (RETURN QUERY) rather
  than an inlinable sql body so the planner can never flatten away
  the internal ORDER BY (depth desc, position asc).
- A depth-100 recursion guard backstops a corrupted parent cycle
  (forest-ness is a creation-time convention, not a DB
  constraint); a `threads_fork_pair_check` CHECK enforces the
  "parent and fork point travel together" invariant; partial
  indexes on both FK columns serve the restrict-probe on every
  message/thread delete and the future GC's children walk.
- The thread_id audit found and fixed three fork-readiness bugs
  ahead of need (all no-ops until forks exist, all unit-tested
  now): recovery synthetics are stamped with their ANCHOR row's
  thread_id instead of the list head's (a fork transcript's head
  is an ancestor's row); `mergeMessagesById` takes the viewed
  thread's id and position-sorts only the own segment, keeping
  inherited prefix rows in snapshot order; and
  `persistSyntheticRecovery` skips synthetics whose thread_id is
  not the viewed thread (inherited-prefix heals stay
  in-memory-only, per the fork-semantics edge case).
- Two M4 notes discovered in the audit. First, the browser's
  realtime message subscription filters on the viewed thread's id,
  so post-fork UPDATEs to inherited rows (an ask_user rewrite or
  second-thoughts verdict landing in the parent) won't reach a
  fork viewer live - display staleness only; the next full load
  resolves it. Second, the M4-to-M6 window where forks exist but
  edit-forks don't is corruption-safe by accident of design:
  delete-from-here and regenerate ranges always run to the tail,
  so a range starting in an inherited prefix necessarily includes
  the fork-point row, and the restrict FK fails the whole delete
  atomically - a loud error, not data loss. M6 replaces that error
  with the edit-fork flow.
- The wiki behavior tests' fake admin client routes
  `thread_transcript` to its `messages` table stub - new
  agent-path tests that stub transcript reads should follow that
  pattern rather than stubbing `.from('messages')`.

Original spec:

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

Status: DONE (2026-08-24). Gate green; QA ran the new
threads-delete-gc walkthrough (PASS 1-7: instant hide, deferred DB
destruction, sweep counts (1,0) then idempotent (0,0), end state
matching the old destructive delete, cross-device hidden-as-delete
echo code-verified) and re-ran the threads-management baseline (PASS,
identical to M0). Deltas and findings from the spec below, chosen at
implementation:

- The GC is `collect_hidden_threads()`, returning
  (deleted_threads, trimmed_messages) so ad hoc runs and the QA
  walkthrough assert on what a pass did. Kept-set recursion uses
  UNION so a corrupted parent cycle terminates (dedup) rather than
  hanging; the doomed-ordering recursion walks down from roots,
  which a cycle is unreachable from - so corruption is left in
  place loudly rather than swept wrongly. Validated live on scratch
  Postgres: no-op pass, plain-delete deferral, watermark trim to a
  fractional fork point with the fork's transcript still resolving,
  idempotence, and a four-thread leaf-to-root collapse through the
  restrict FKs.
- Beyond the enumerated list surfaces, every thread claim RPC
  (summary, topics, auto-title, reflection, evaluation, wiki,
  wiki-records) now skips hidden threads - the old destructive
  delete removed a thread before a sweep could see it, so spending
  agent tokens on a deleted thread would be NEW behavior, not
  preserved behavior. The chunker claims are the deliberate
  exception (commented in place): once edit-forks exist, a hidden
  thread's trimmed segment is live shared prefix and its
  just-written rows must still get chunked, or recall goes blind to
  them; cost today is at most one wasted chunk pass per deleted
  thread. list_user_topics and the topics claim's vocabulary CTE
  also filter hidden.
- The delete gesture reaches other devices as an UPDATE with
  hidden=true, not a DELETE event - the browser's realtime
  thread-UPDATE handler grew a hidden branch that mirrors the
  DELETE path (without it, rebucketThread would re-insert the
  deleted thread). The GC's later hard delete still arrives as a
  DELETE for a thread already out of the UI.
- PDF-page coverage verified as the plan asked: attachment-gc's
  orphan lister anti-joins BOTH message_attachments and
  message_attachment_pages, so page renders orphaned by the GC
  cascade reclaim on the same daily pass as originals. No new code
  needed.
- The empty "Deleting a thread" stub in docs/user/threads.md got
  its section (instant disappearance, deferred cleanup, why);
  docs/dev/forking.md started with the data model, invariants,
  resolver contract, and GC, per the milestone.

Original spec:

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

Status: implemented (2026-08-24), awaiting QA - stamp DONE when the
threads-fork use-case results land. Gate green (2239 vitest + 535
Deno); the rewritten chunk-search RPC exercised on scratch Postgres
(9-scenario matrix: visible passthrough, hidden-no-descendant drop,
covered-fork resolution with dedupe, uncovered-fork drop, two-level
chain through a hidden middle, stale-anchor drop, tie-break to the
fresher fork, recency filter on the presented thread, idempotent
re-apply).

Implementation deltas from the plan:

- **Framing rides the two shared transcript loaders**, not
  per-agent wiring: EVERY replay-style agent (summary, topics,
  reflection, evaluation, wiki, wiki-records, recall agents,
  intent employment) gets preamble + marker uniformly; summary and
  topics pass a task clause via the loader's new opts. Correction
  to the plan's cursor rationale it surfaced: the cursor workers
  (reflection, evaluation, wiki) replay the FULL transcript - the
  cursor gates the CLAIM, not the read - so a fork's inherited
  prefix does reach them. That is the same shape as ordinary
  re-reflection over an already-processed thread, which those
  agents already tolerate by finding their own prior writes; the
  framing preamble is context, not the dedup mechanism.
- Recall/conversation_get were planned as "marker alone"; the
  loaders give recall agents the descriptive preamble too (an
  unexplained marker is the injection-flag shape the provenance
  convention exists for). conversation_get is the one true
  marker-only surface (splice into the windowed transcript).
- Boundary detection is by ROW OWNERSHIP (first row whose
  thread_id matches the requested thread), not by fork-point id -
  it degrades correctly when trims drop part or all of the prefix,
  and needs no extra fetch on unforked threads (one array scan).
  StoredMessage gained optional thread_id; both loaders select it.
- Bias gets a `fork_note` payload field plus an id-less marker
  entry (evidence is cited by id, so the marker is uncitable).
- Fork-point selection: pure primitives in `src/lib/forking.ts`
  (vitest-covered). The drawer fork walks the own-segment tail
  past streaming/tool/mid-round rows; an empty own segment falls
  back to the thread's own fork point, minting a SIBLING; a truly
  empty root refuses with a clear error.
- Thread (browser type) exposes BOTH fork columns; the semantic
  search stub reads as a root (costs a search-result row its
  indicator only). Fork inserts are plain RLS inserts - no new
  SQL. Cross-user forgery is not schema-enforced (leaks nothing
  via the invoker resolver; would pin a foreign thread against GC;
  judged not worth a composite-FK migration - noted in
  forking.md gotchas).
- Chunk-search resolution details: the first hop out of the
  chunk's owner proves containment (child fork position >= chunk
  end position, with the anchor verified to still be a row of the
  owner's segment); deeper hops are unconditional (a grandchild
  inherits its parent's entire inherited prefix); stale anchors
  drop conservatively until rechunk; dedupe keeps the strongest
  chunk per presented thread; recency filter AND boost run on the
  presented thread's updated_at (moved from the owning thread).
- **Digest hidden-title mitigation: decided, accept without
  code.** A fork inherits the parent's title verbatim, so the
  digest's "unreachable" title matches the visible fork's title;
  only a later manual rename of the fork drifts them, cosmetically.
- Two TS2589 casts (SupabaseClient -> TitleClient structural
  check overflows the compiler); commented at both sites.

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
