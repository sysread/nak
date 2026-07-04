# Follow-ups (planning)

> **Status: design + QA-first planning. Nothing is built.** This
> doc records the settled design decisions; the three QA
> use-cases below are the behavioral spec, written before the
> implementation on purpose (the semantic case's baseline arm is
> executable against current code and reproduces the bug this
> feature exists to fix). When the feature ships, graduate the
> durable content into a permanent `docs/dev/followups.md` and
> retire this file per the in-progress rules in `CLAUDE.md`.

## The problem

The chat model hallucinates outcomes across conversations. The
user plans a recipe in one thread; in a later thread they ask a
question about it, recall surfaces "user planned recipe X", and
the model fills the gap - asserting the recipe was made, how it
went, details that never happened. The stores record *plans*
faithfully but carry no notion of *unresolved*: nothing tells the
model "this was planned, the outcome is unknown, ask rather than
assume."

The same gap blocks proactive follow-up: "ask how the meeting
went after Thursday" has no home. Memories cannot express it -
they have no dates, no status, and no non-semantic retrieval
path, so "which follow-ups are due?" is unanswerable there.

Intents were considered and rejected for this: wrong author (the
daily minter, not the chat model mid-turn), wrong cadence
(daily), wrong lifetime (standing dispositional goals vs one-shot
questions), wrong budget (the ~3-5 active cap shared with the
bias appendix), and free-form follow-up intents would pollute the
backtest corpus the intents feature's off-by-default gate depends
on.

## The shape

A **follow-up** (working name; "open loop" in design discussion)
is a pending question the model saves for itself: "Ask how the
lasagna turned out." It has a lifecycle (open -> answered /
dismissed / expired), an optional start-of-relevance date, and a
link to the conversation that seeded it. It is scaffolding, not
knowledge: when the answer arrives, the durable fact goes to
`memories` through the normal channels and the follow-up row is
closed with a short `resolution` stamp.

## Decisions settled

1. **Own table, not memories.** Three forcing reasons: (a) the
   date axis needs a deterministic query (`status='open' and
   relevant_after <= now()`), which the semantic-only memory
   store cannot answer; (b) the open->closed lifecycle is not
   memory-shaped - closing is a status flip, not a prose rewrite;
   (c) distinct presentation ("unresolved - ask, don't assert")
   is robust when the rows arrive in their own arm of the gather
   and fragile if a smoothing pass must sniff loop-shaped rows
   out of the fact pile.

2. **Surfacing rides the context-recall pipeline** (see
   [`context-recall.md`](../context-recall.md)). Follow-ups
   become a **fourth arm** of `gatherContextIndex`, alongside
   memories / conversations / wiki, and flow through the same
   smoothing pass into the injected `<think>` recollection and
   the same cached payload on `threads`. Two sub-axes:
   - **Semantic** - open follow-ups matching the derived query
     surface like memories do (the rows carry embeddings and ride
     the existing backfill). This is the hallucination fix: when
     the recipe memory surfaces, the open loop surfaces beside it
     carrying "outcome unknown". A semantically matched loop
     whose `relevant_after` is still in the future renders as
     "planned, hasn't happened yet", not as "worth asking about".
   - **Date-due** - loops whose `relevant_after` has passed are
     pulled deterministically into the same arm regardless of
     semantic match, capped (~2 per gather), so "how did the
     meeting go" surfaces at the next thread-open (`cold`
     trigger) even when the user talks about something else.
     Loops with null `relevant_after` surface only semantically -
     with no date there is no basis for an unprompted ask.

3. **Framing is dispositional, never a command.** Same altitude
   lesson as intents: the smoothing instructions render a due
   loop as "you've been meaning to ask..., raise it when there's
   a natural moment", never "ask X now". The model may judge the
   moment wrong (heavy topic in progress) and skip; the loop
   stays open for the next boundary.

4. **Anti-nag is load-bearing, not polish.** A follow-up bot
   that re-asks every thread is worse than none. Stamped at
   gather time: `last_surfaced_at` + `surface_count`. The
   date-due pull skips loops surfaced within a cooldown window
   (so consecutive threads in one day don't repeat the ask), and
   loops expire after N unanswered surfacings or T days past
   `relevant_after`. Constants are launch placeholders to tune
   against real feel (provisional: 20h cooldown, N=3, T=30d).
   Semantic surfacing is NOT cooldown-gated - if the user brings
   the topic up, the unresolved status is always relevant.

5. **Two writers, mirroring memory's two layers.** Volitional:
   the chat model saves a follow-up mid-turn when the user shares
   a plan or a dated event (this is the "model leaves itself a
   reminder" ask that started this design). Subconscious: the
   reflection agent records unresolved plans it finds in settled
   threads, so capture doesn't depend on mid-turn volition. Both
   dedup by searching existing open loops first; the same plan
   discussed twice yields one row.

6. **Close beats delete.** When the user reports the outcome
   (asked or unprompted), the model closes the loop
   (`status='answered'`, `resolution` stamped) and writes the
   durable outcome to memories. `dismissed` covers "stop asking
   about that"; `expired` is the system's own decay. Rows are
   kept for inspection, never hard-deleted by agents.

## Data model (proposed)

`followups` table, RLS `auth.uid() = user_id`, idempotent DDL
per the `schema.sql` conventions:

- `id uuid pk default gen_random_uuid()`, `user_id uuid`.
- `question text not null` - first-person prompt to self ("Ask
  how the lasagna turned out").
- `context text` - one or two lines of seeding context, enough
  to raise the question naturally without a thread fetch.
- `source_thread_id uuid` FK `threads` on delete set null - the
  conversation that seeded it (the loop outlives the thread).
- `status text check in ('open','answered','dismissed',
  'expired') default 'open'`.
- `relevant_after timestamptz` - null = no proactive ask, ever;
  the loop surfaces only semantically.
- `resolution text` - stamped on close; what we learned.
- `last_surfaced_at timestamptz`, `surface_count int default 0`
  - the anti-nag ledger, written by the gather.
- `created_at`, `updated_at`.
- `embedding vector(2048)`, `embedding_model`, embedding claim
  columns - rides the existing embeddings backfill (see
  [`embeddings.md`](../embeddings.md)).

## Tools (proposed)

- `followup_create({question, context, relevant_after?})` -
  write, gated.
- `followup_close({id, resolution})` - write, gated.
- `followup_dismiss({id})` - write, gated.
- `followup_list()` - read, always-on (open loops are small in
  number; no search tool needed at v1).

The reflection agent's toolbox gains `followup_create` +
`followup_close` (it can both open loops and close ones the
transcript resolved).

## Open questions

- **Toolbox placement for the writes** - own `followups` box vs
  folding into `memories` (capture is memory-adjacent volition;
  a new box raises the flip cost, a shared box muddies "memory
  writes"). Leaning own box; decide at implementation.
- **Feature gate** - v1 rides `contextRecallEnabled` (surfacing
  is meaningless without the pipeline). If users who disable
  context recall want follow-ups, it needs its own toggle.
- **Citations / drill-down** - loops are small like memories and
  can ride verbatim in the arm; whether they get `^N^` citations
  and a `followup_get` is a render-detail decision.
- **Inspector surface** - nak convention wants emergent state
  inspectable eventually (a pill or drawer listing open loops).
  v1 ships without; `followup_list` via chat covers "what were
  you going to ask me?".
- **Expiry mechanics** - lazy (the gather query flips
  past-threshold rows) vs a sweep. Lazy is likely sufficient;
  nothing else needs timely expiry.

## Interactions (anticipated)

- **Context recall** ([`context-recall.md`](../context-recall.md))
  - the fourth gather arm, the smoothing-pass instructions, the
  `context` umbrella tool's fourth result array. A non-empty
  loops arm must make the cached note non-empty (the empty-note
  short-circuit would otherwise drop a due ask).
- **Memory** ([`memory.md`](../memory.md)) - outcomes graduate
  to memories on close; the reflection agent is the subconscious
  writer for both stores.
- **Tools** ([`tools.md`](../tools.md)) - new gated writes +
  one always-on read; the browser schema / edge registration
  mirror discipline applies.
- **Embeddings** ([`embeddings.md`](../embeddings.md)) - the
  backfill gains a fourth `embedding is null` poll target.
- **Settings** ([`settings.md`](../settings.md)) - only if the
  gate question resolves to a dedicated toggle.

## QA use-cases (the behavioral spec)

Written before implementation; see each file's banner:

- [`followup-capture`](../../qa/use-cases/followup-capture.md) -
  both writers create loops; dedup holds.
- [`followup-semantic-recall`](../../qa/use-cases/followup-semantic-recall.md)
  - the recipe scenario: unresolved framing kills the outcome
  hallucination; close-on-answer. Its baseline arm runs against
  CURRENT code and reproduces the bug.
- [`followup-date-due`](../../qa/use-cases/followup-date-due.md)
  - the meeting scenario: due loop surfaces off-topic at thread
  open; cooldown and expiry contain the nag.
