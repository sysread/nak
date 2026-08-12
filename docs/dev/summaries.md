# Summaries

Server-side curation unit that writes a 2-3 sentence summary onto
each thread once the conversation settles. Summaries feed the search
drawer and the conversation-recall agent; they are never rendered
to the user directly. Runs in the venice edge function; there is no
browser-side summarisation code.

## Role in the app

When a thread's newest terminal assistant message is past
`last_summarised_msg_id`, the summary unit claims it, asks the fast
model (`mistral-small-3-2-24b-instruct`, hardcoded in the agent
module) for a 2-3 sentence topical summary, and writes the result
back via a claim-guarded RPC.

The summary is not an embedding input. Threads once carried a single
vector over `title + summary`, and that vector was what
`conversation_search` ranked against - which meant a conversation
could only be found by how it was labelled, never by what was said
in it. Ranking now runs over `thread_chunks` (see
`./conversation-recall.md`), built from the messages themselves.

What the summary is still for: it rides along on every search hit
and in the recall agent's context as body text, so the model can
judge whether a thread is worth opening without fetching its full
message history. That is a display and triage role, not a retrieval
one - a thread with a null summary is still fully searchable.

Two drivers run the unit:

- **Chat-turn tail** - `curateOnTurnTail(admin, userId)` fires from
  `getStreamingResponse.ts`'s `waitUntil` tail on every completed
  turn, walking the six curation units (auto-title first, then
  topics, summary, memory topics, recipe topics, rechunk) with a per-unit
  drain cap of 3.
- **Hourly curation sweep** - the `/curation-sweep` route (pg_cron
  job `nak-curation-sweep`, minute 57) runs `runCurationSweepTick`
  cross-user via the SECURITY DEFINER `*_sweep` claim RPCs,
  per-queue cap 10.

Double-driving is safe: the per-thread claim columns are the only
mutual exclusion - whichever driver claims first wins and the other
sees an empty queue. There is no worker lease for this unit.

## Files

- `supabase/functions/venice/agents/summary.ts` - the work unit:
  `summariseOneThread` (per-user claim, tail driver),
  `sweepClaimAndSummarise` (cross-user claim, sweep driver), the
  shared run half, and the summary prompt. Transcript sizing lives
  in `_curation_helpers.ts` (`completeOverThreadSlice`), shared
  with thread-topics.
- `supabase/functions/venice/agents/curation.ts` - the composition
  layer that orders the five units and owns the drain loops.
- `supabase/schema.sql` (summaries sections) - `threads.summary`,
  `last_summarised_msg_id`, the claim columns,
  `claim_next_thread_for_summary`,
  `claim_next_thread_for_summary_sweep`,
  and `save_thread_summary_if_claimed`.

## Entry points

- **`getStreamingResponse.ts` terminal tail** - on a `completed`
  turn, `curateOnTurnTail` walks the five units; summary drains
  third (after auto-title and thread topics).
- **`/curation-sweep` route in `venice/index.ts`** - the hourly
  cron tick; `runCurationSweepTick` drains each queue cross-user.
- **Outcome vocabulary** - each cycle returns a `SummaryOutcome`
  (`empty-queue` / `summarised` / `claim-lost` / `empty-summary` /
  `error`). The drain loops keep claiming on `summarised` and
  `claim-lost`; `empty-summary` deliberately stops the drain (the
  claim is left to expire via TTL, so re-claiming immediately would
  just skip past the row). `error` is handled by `drainUnit` rather
  than by the per-unit `drainOn` set - see the head-of-line gotcha
  below.

## Data model

- **`threads.summary`** - the 2-3 sentence text the agent wrote.
  Null until the unit runs.
- **`threads.last_summarised_msg_id`** - message id the summary
  covers up to. A new terminal assistant message past this id
  makes the thread claimable again; the next summarisation
  overwrites `summary` rather than appending.
- **`threads.summary_claim_holder`** +
  **`threads.summary_claim_expires`** - per-row claim, the sole
  mutual exclusion between the two drivers. Same shape as every
  other per-row claim in the file; partial index on
  `summary_claim_holder is not null` keeps it tiny in steady state.
  Claim TTL is `CURATION_CLAIM_TTL_SECONDS` (120s), shared by all
  six curation units.

## Contracts

- `summariseOneThread(admin, userId, log): Promise<SummaryOutcome>`
  - one per-user cycle: claim, summarise, save. Non-throwing; every
  failure path folds into an outcome the drain loop can act on.
- `sweepClaimAndSummarise(admin): Promise<SummaryOutcome>` - one
  cross-user sweep step. Creates its own edge logger per claim and
  flushes before returning.
- `claim_next_thread_for_summary(holder, ttl, p_user_id)` RPC -
  returns `{thread_id, terminal_msg_id}` for the oldest eligible
  thread. `p_user_id` is the b-strict escape hatch for the
  service-role caller (no `auth.uid()` in scope).
- `claim_next_thread_for_summary_sweep(holder, ttl)` RPC - SECURITY
  DEFINER cross-user variant; same predicate without the user
  filter, returns `user_id` for log attribution and save scoping.
- `save_thread_summary_if_claimed(thread_id, holder, summary,
  msg_id, p_user_id)` RPC - only writes if
  `summary_claim_holder = $me AND summary_claim_expires > now()`.
  False return means another run took over; treat as `claim-lost`,
  drain to next.
- Transcript truncation - if a thread has more than 120 messages,
  summarisation runs on the first 40 + last 80, each half trimmed
  to a safe turn boundary so the wire never serialises a
  `tool -> user` role sequence. Caps token spend and keeps the
  summary biased toward opening framing + recent state. A second
  pass then excerpts oversized rows and drops from the middle until
  the transcript fits the token budget - the message cap alone does
  not bound request size (see Gotchas).

## Interactions with other features

- **Chat** - chat's job is just to write messages; the completed
  turn's tail is what drives this unit. See `./chat.md`.
- **Embeddings** - none, any more. Writing a summary used to
  invalidate the thread's vector and hand the row to the embeddings
  backfill; that vector is gone, and what gets embedded now
  (`thread_chunks`) is derived from the messages, so a summary write
  neither triggers nor blocks any embedding work. See
  `./embeddings.md`.
- **Conversation recall** - reads `threads.summary` to judge
  relevance without fetching full message history. A missing
  summary means the recall agent sees only the thread title;
  quality degrades accordingly. See `./conversation-recall.md`.
- **Logging** - both drivers emit progress and error breadcrumbs
  through `createEdgeLogger(userId, 'summary')`, which reach the
  in-app Logs drawer over the `logs:<userId>` Broadcast topic. See
  `./logging.md`.

## Gotchas

- **Summary is never rendered to the user.** This surprises people
  reading the schema. There's no UI surface on `threads.summary`
  today - it's a search/recall signal only. If you add a UI
  affordance later, remember the column can be null for a window
  after the thread settles.
- **Claim-lost is not an error.** The tail and the sweep can race
  on the same row; the per-thread claim means only one wins, and
  the save RPC's guard drops the loser's write silently. The drain
  loop treats `claim-lost` as a normal transition.
- **Empty-summary is not an error either - and it leaves the claim
  stamped.** A model response that trims to nothing returns
  `empty-summary`; the unit does NOT save (an empty save would
  stamp `last_summarised_msg_id` and never retry) and does NOT
  clear the claim. The TTL expiring is what re-queues the row -
  this is the deliberate backoff for transient model misbehavior,
  and why `empty-summary` stops the drain loop.
- **An errored row must not wedge the queue.** Claims come off
  `order by t.updated_at asc`, so the oldest eligible thread is
  re-claimed FIRST on every tick. If the drain pass stopped on
  `error`, one deterministically-failing thread would block every
  row behind it forever. It did: a single thread failing on
  `context_length_exceeded` held the head of the queue and produced
  24 claims and 0 saves over ten hours, and the whole backlog
  drained within the hour once its underlying failure was fixed.
  `drainUnit` in `curation.ts` now steps over an errored row - the
  row keeps its claim until the TTL expires, so the next claim in
  the same pass reaches the row behind it - and only bails after
  `MAX_CONSECUTIVE_ERRORS` in a row, which reads as a failing
  backend rather than one bad row. Watch for `picked up` lines with
  no matching `finished` line: that pairing is the symptom.
- **Truncation is pragmatic, not principled.** First 40 + last 80
  messages is a heuristic that keeps a mid-conversation topic shift
  visible without blowing token budget. A long thread that pivots
  multiple times may produce a summary biased toward the final
  topic; we live with that.
- **The message cap is not a size cap.** 120 turns of a tool-heavy
  thread is routinely six figures of tokens, which the serving
  backend rejects outright. `completeOverThreadSlice` in
  `_curation_helpers.ts` is what actually bounds the request: it
  excerpts oversized rows (tool results hardest), drops from the
  middle until the transcript fits `CURATION_INPUT_TOKEN_BUDGET`,
  and halves the budget for one retry if the backend rejects it
  anyway. Summary and thread-topics share it. See the topics doc's
  Gotchas for the incident that drove it.
- **Long conversations re-summarise on every settle.** Each new
  terminal-assistant-message past `last_summarised_msg_id` reopens
  the claim. The new summary overwrites the old; no diff-only
  mechanism. Acceptable because summarisation is cheap fast-tier
  text and most threads settle a handful of times total.
- **The model id is hardcoded in the agent module.**
  `SUMMARY_MODEL = 'mistral-small-3-2-24b-instruct'` mirrors
  `agentModel('summary')` in `src/lib/models/index.ts`. Change both
  together.

## Where to go next

- `./embeddings.md` - the downstream worker that reads the summary
  to produce the search vector.
- `./conversation-recall.md` - the primary consumer of summaries.
- `./memory.md` - reflection, the memory-write counterpart; same
  per-row claim-RPC pattern on `threads`, same tail + sweep
  double-driving.
- `./architecture.md` - background work in context.
