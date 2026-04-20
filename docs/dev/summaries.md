# Summaries

Background worker that writes a 2-3 sentence summary onto each
thread once the conversation settles. Summaries feed the search
drawer and the conversation-recall agent; they are never rendered
to the user directly.

## Role in the app

When a thread's newest terminal assistant message is past
`last_summarised_msg_id`, the summary worker claims it, asks the
fast model for a 2-3 sentence summary, and writes the result back
via a claim-guarded RPC. The background embeddings worker then
picks up the row (the `clear_thread_embedding_on_change` trigger
nulled its embedding on the write) and produces a vector over
`title + summary`.

That vector is what `conversation_search` ranks against, which is
what the `conversation_recall` tool consumes. Summaries are also
shipped to the recall agent as body text so it can judge whether
a thread is worth opening without fetching full message history.

## Files

- `src/lib/agents/summary/agent.ts` — `SummaryAgent.run`; one
  summary per invocation. No tool calls; output IS the final
  text.
- `src/lib/agents/summary/prompt.ts` — the user-turn instruction
  appended to the full transcript.
- `src/lib/agents/summary/loop.ts` — `runOneCycle`,
  `napForResult`. State machine factored out of the worker so
  it's unit-testable without a Web Worker runtime.
- `src/lib/agents/summary/worker.ts` — the Web Worker entry
  point. Constructs Supabase + Venice clients on the worker
  side (structured-clone won't carry class instances) and
  drives `runOneCycle` until abort.
- `src/lib/agents/summary/manager.ts` — main-thread
  supervisor. Cross-tab Web Lock
  (`nak:summary-worker`), starts/stops the Worker, passes
  config via a `StartMessage`.
- `supabase/schema.sql` (summaries section) —
  `threads.summary`, `last_summarised_msg_id`, the claim
  columns, and the `clear_thread_embedding_on_change` trigger.

## Entry points

- **`activate()` in `state.svelte.ts`** — calls
  `summaryManager.start({ supabase, config })` fire-and-
  forget. The manager acquires the Web Lock, reads the auth
  session, and posts a `StartMessage` to the Worker.
- **`lock()`** — calls `summaryManager.stop()`. Tears down the
  Worker, releases the Web Lock, releases the Supabase lease
  so another tab can take over instantly.
- **Cycle result driver** — inside the Worker, `runOneCycle`
  returns a `CycleResult` (`acquired-lease` / `polling` /
  `empty-queue` / `summarised` / `claim-lost` /
  `empty-summary` / `error`). `napForResult` maps each to a
  sleep before the next cycle.

## Data model

- **`threads.summary`** — the 2-3 sentence text the agent wrote.
  Null until the worker runs.
- **`threads.last_summarised_msg_id`** — message id the summary
  covers up to. A new terminal assistant message past this id
  makes the thread claimable again; the next summarization
  overwrites `summary` rather than appending.
- **`threads.summary_claim_holder`** +
  **`threads.summary_claim_expires`** — per-row claim for
  cross-device coordination. Same shape as reflection and
  embeddings claim columns; partial index on
  `summary_claim_holder is not null` keeps it tiny in steady
  state.
- **`worker_leases` row** — `worker_kind='summary'`. Partitioned
  from the `'reflection'` and `'embedding'` leases so a device
  can hold all three concurrently.
- **`clear_thread_embedding_on_change` trigger** — fires on
  UPDATE when `title` or `summary` changes; nulls the
  `embedding` + `embedding_model` + embed claim columns. Ensures
  a fresh summary gets a fresh embedding automatically without
  a coordinating flag.

## Contracts

- `SummaryAgent.run(req): Promise<AgentRunResult<SummaryOutput>>`
  — `SummaryOutput.summary: string` is the text to write.
  Empty output is a legitimate "agent said nothing worth
  storing"; the loop treats it as `empty-summary` and skips
  without stamping `last_summarised_msg_id`.
- `runOneCycle(ctx): Promise<CycleResult>` — one observable
  state transition. The Worker's outer loop maps each result
  to a sleep via `napForResult` before the next cycle.
- `save_thread_summary_if_claimed` RPC (schema) — only writes
  if `summary_claim_holder = $me AND summary_claim_expires >
  now()`. False return means another device took over; treat
  as `claim-lost`, drain to next.
- Transcript truncation — long threads are summarized from the
  first 40 + last 80 messages. Caps token spend and keeps the
  summary biased toward opening framing + recent state.
- `emptyToolbox` — the agent advertises a toolbox to satisfy
  the `Agent` interface, but it has zero tools. The headless
  loop never finds a tool call to dispatch, so this is
  structurally a single-round "produce text" call.

## Interactions with other features

- **Chat** — chat's job is just to write messages. A terminal
  assistant message on a thread is the summary trigger; the
  worker picks it up on its next poll. No direct call path.
  See `./chat.md`.
- **Embeddings** — the
  `clear_thread_embedding_on_change` trigger nulls
  `threads.embedding` whenever `threads.summary` changes, so
  the embeddings worker's next poll reselects the row. The
  two workers hand off through the row's state, not through
  an explicit signal. See `./embeddings.md`.
- **Conversation recall** — reads `threads.summary` to judge
  relevance without fetching full message history. A
  missing summary means the recall agent sees only the
  thread title; quality degrades accordingly. See
  `./conversation-recall.md`.

## Gotchas

- **Summary is never rendered to the user.** This surprises
  people reading the schema. There's no UI surface on
  `threads.summary` today — it's a search/recall signal
  only. If you add a UI affordance later, remember the
  column can be null for a window after the thread settles.
- **Claim-lost is not an error.** Another device can legally
  take over mid-summarization (the incoming lease-holder
  sees an expired claim and reselects the same row). The
  save RPC's guard drops the write silently; the worker
  drains to the next thread. Loop treats `claim-lost` as a
  normal transition.
- **Empty-summary is not an error either.** A model response
  the agent couldn't parse into a usable summary returns
  `SummaryOutput.summary = ''`. The loop skips the save
  (so `last_summarised_msg_id` isn't stamped either, which
  means the row stays claimable on the next cycle). Don't
  retry in a tight loop — the nap policy covers this.
- **Truncation is pragmatic, not principled.** First 40 + last
  80 messages is a heuristic that keeps a mid-conversation
  topic shift visible without blowing token budget. A long
  thread that pivots multiple times may produce a summary
  biased toward the final topic; we live with that.
- **Long conversations re-summarize on every settle.** Each
  new terminal-assistant-message past
  `last_summarised_msg_id` reopens the claim. The new
  summary overwrites the old; no diff-only mechanism.
  Acceptable because summarization is cheap fast-tier text
  and most threads settle a handful of times total.
- **No content diff on re-summarize.** If two devices race
  across the lease-boundary, both may have produced very
  similar text; the `save_thread_summary_if_claimed` RPC's
  claim guard ensures only one write lands. Whichever lease-
  holder wins the claim wins the text.

## Where to go next

- `./embeddings.md` — the downstream worker that reads the
  summary to produce the search vector.
- `./conversation-recall.md` — the primary consumer of
  summaries.
- `./memory.md` — sibling background loop (reflection),
  same plumbing shape.
- `./architecture.md` — the worker model in context.
