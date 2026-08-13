# Conversation recall

The read-only surface that lets the main chat model pull context
out of **prior conversations** (threads) — as opposed to saved
memories. Sibling of memory recall, separate because it searches
a different table and needs a different prompt.

## Role in the app

When the main model decides the current turn would benefit from
context out of a prior thread (not just a loose memory fact), it
calls the `conversation_recall` tool. A fast-tier agent spins up
inline, reads the current thread, runs one or more
`conversation_search` queries against the user's other threads,
and returns either `{kind:'none'}` or `{kind:'note', note:'...'}`.
The main model folds the returned note into its reply.

Two shared signals drive this feature's value:

- **Thread summaries.** The summary worker writes a 2-3 sentence
  summary into `threads.summary`. Without that, the recall
  agent would have to fetch full message histories to judge
  relevance.
- **Transcript chunks.** The rechunk unit slices each thread's
  messages into `thread_chunks` and the embeddings backfill
  vectorizes them. Search ranks those chunks and keeps each
  thread's best-matching one, so a conversation surfaces for
  what was said in it rather than for how it was labelled.

Both signals are background; recall is the read-time consumer.

## Files

- `src/lib/tools/conversation_recall.schema.ts` — the main-chat
  tool definition (schema only; the implementation lives
  server-side).
- `supabase/functions/venice/tools/conversation_search.ts` — ranks
  transcript chunks; every hit carries the `passage` that matched.
- `supabase/functions/venice/tools/conversation_get.ts` — windows a
  thread's transcript, optionally anchored on a `query`.
- `supabase/functions/_shared/thread-transcript.ts` — renders a
  thread's messages (including tool calls) and slices them into
  embedding-sized chunks.
- `supabase/functions/venice/agents/thread_chunks.ts` — the rechunk
  curation unit that keeps `thread_chunks` in step with a thread.
- `supabase/functions/venice/agents/conversation_recall.ts` —
  the recall agent, running server-side inside the venice edge
  function. Trims the thread to the last user turn, appends a
  recall-instruction user turn, runs `runHeadlessAgent` with a
  `conversation_search`-only toolbox, and returns a
  `RecallNote`.
- `supabase/schema.sql` (summaries + chunks + search RPCs)
  — `threads.summary`, the `thread_chunks` table and its two
  work queues, `search_thread_chunks_by_embedding` RPC,
  `listThreadSummariesByIds` surface.

## Entry points

- **Main model invokes `conversation_recall`** — with or without
  an optional `topic` hint. The tool definition dispatches to
  the server-side `conversation_recall` agent
  (`supabase/functions/venice/agents/conversation_recall.ts`).
- **Agent tool calls** — inside the headless loop, the agent
  calls `conversation_search` one or more times. Exact-title
  hits are ordered ahead of semantic (vector) hits; the current
  thread is filtered out by default.

## Data model

- **`threads.summary`** — 2-3 sentences written by the summary
  worker. Null until summarized. See `./summaries.md`.
- **`thread_chunks`** — one row per embedding-sized slice of a
  thread's transcript, each carrying `content`, the message
  range it covers, and a `vector(2048)`. Written by the rechunk
  curation unit whenever `threads.last_chunked_msg_id` falls
  behind the thread's newest message, then vectorized by the
  embeddings backfill. Chunk boundaries are packed greedily from
  the first message, so appending a turn rewrites only the last
  partial chunk and everything before it keeps its vector.
- **`ThreadSearchHit`** — core hit fields come from the backend
  search; the tool layer hydrates summaries for display. The
  merged list preserves ordering (exact before semantic) and
  omits the current thread by default.
- **Current-thread filter** — `conversation_search` excludes
  `ctx.threadId` by default. An explicit `include_current:
  true` flag opts back in for the rare case the main model
  wants an earlier turn from the same thread (e.g. after
  context compaction drops an older message).
- **`RecallOutput`** — discriminated union:
  `{kind:'none'} | {kind:'note', note:string}`. Parsed
  server-side in
  `supabase/functions/venice/agents/conversation_recall.ts`.

## Contracts

- `conversation_search.execute({ query, limit, include_current,
  within_days?, prefer_recent? })` — one row per thread, scored by
  that thread's best-matching chunk. Every hit carries `passage`,
  the excerpt that matched; feed it back as `conversation_get`'s
  `query`. `within_days` is a hard floor on `threads.updated_at`
  applied before ranking; `prefer_recent` adds a small decaying
  bonus to the ORDERING only. The reported `similarity` is always
  the raw cosine either way.
- `conversation_get.execute({ id, query? })` — returns a window
  of the transcript plus `window: {start, end, total}` and
  `matched_query`. With `query`, the window centres on the
  best-matching turn and grows outward alternately so the match
  arrives with the exchange around it; without one it is the
  tail. `matched_query: false` means the terms were not found
  and the tail was returned instead — do not read that as "the
  passage is not in this thread".
- `ConversationRecallAgent.run(req): Promise<AgentRunResult<
  ConversationRecallOutput>>` — server-side, in
  `supabase/functions/venice/agents/conversation_recall.ts`.
  `req.input` is `{ threadId, topic? }`. The returned `note`
  is parsed from the agent's final JSON; a parse failure
  collapses to `{kind:'none'}` so a malformed model response
  doesn't fail the main chat turn.
- **JSON-mode discipline.** The agent passes
  `responseFormat: { type: 'json_object' }` to the headless
  tool loop. Providers only constrain the *text* part of a
  response to the requested shape, so tool-call rounds pass
  through unaffected.

## Interactions with other features

- **Chat** — `conversation_recall` is a main-chat tool. The
  chat loop dispatches it the same way it dispatches any tool
  call; the structured JSON result becomes a `role='tool'`
  message for the next round. See `./chat.md`.
- **Summaries** — the summary worker produces
  `threads.summary`, which the recall agent reads to decide
  whether a thread is worth pulling details out of without
  opening the full message history. No summary means the
  agent sees only the title, which substantially degrades
  recall quality. See `./summaries.md`.
- **Embeddings** — the backfill vectorizes `thread_chunks`
  rows, which the rechunk curation unit writes. The search RPC's
  cosine path reads those vectors. A thread the rechunk unit
  has not reached yet (`last_chunked_msg_id` null) is
  unrankable; exact-ILIKE covers that window in the callers
  that have an exact arm. See `./embeddings.md`.
- **Tools** — `conversation_recall` lives in the main chat's
  `TOOLS` list but is excluded from every agent toolbox
  (reflection, memory recall, conversation recall itself);
  agents don't recurse into recall. The search tool
  `conversation_search` is shared by chat and the recall agent.
  See `./tools.md`.
- **Logging** - the conversation-recall agent emits
  progress breadcrumbs through
  `createLogger('conversation-recall-agent')`. Entries
  land in the in-app log drawer alongside main-thread
  logs. See `./logging.md`.

## Gotchas

- **Recall runs server-side.** The conversation-recall agent
  (`supabase/functions/venice/agents/conversation_recall.ts`)
  runs inside the venice edge function under the same
  `EdgeRuntime.waitUntil` as the streaming loop. Survives a
  browser disconnect mid-recall.
- **Search covers message text.** Threads once carried a single
  vector over 2000 chars of `title + summary`, which meant the
  words a user actually typed were never in the index — a thread
  auto-titled "Bread Recipe Modification Advice" could not be
  found by searching "lentils" despite that word opening its
  first message. `thread_chunks` is what replaced it, and it is
  why queries should be written in the user's words rather than
  in title-ish paraphrase.
- **Chunk scores are aggregated, never chunk vectors.**
  `search_thread_chunks_by_embedding` ranks every chunk, keeps
  each thread's single best one, and orders threads by that
  score. Averaging a thread's chunk vectors into one would
  rebuild exactly the centroid dilution the chunking exists to
  remove: in a 107-message thread any one topic is a couple of
  percent of the mean direction and still would not rank.
- **A thread is unrankable until it has been chunked.** There is
  no second index to fall back on any more. `last_chunked_msg_id`
  null means no chunk rows, which means the thread cannot appear
  in a semantic hit list at all. The window is normally minutes —
  the rechunk unit runs on every chat turn's tail — but it is a
  real hole after a bulk import or a restore, and only the
  callers with an exact-ILIKE arm paper over it.
- **Similarity has no time dimension, and the scores are tightly
  packed.** Ranking is pure cosine, so "the conversation from
  yesterday" returns the best topical match from any date — this
  bit for real: a thread updated the previous day ranked 22nd of
  478 because the query described a topic it only half matched.
  `within_days` is the fix for a stated time frame;
  `prefer_recent` only breaks near-ties. The preference is
  deliberately tiny (+0.05 decaying over 7 days) because the
  top-10 similarity band spans about 0.04 on the live corpus:
  measured, +0.10 already promotes a thread that ranked 14th on
  relevance to first, and a MULTIPLICATIVE boost of 1.5x would add
  ~0.30 and make recency the entire ranking. If you retune this,
  re-measure the band first — the safe magnitude is a property of
  the corpus, not a constant.
- **`conversation_get` without a `query` returns the thread's
  TAIL.** That default is a trap on long threads and was the
  original bug: a caller correctly identified a 107-message
  thread, opened it twice, and got the last eight turns both
  times while what it needed was message 1. `truncated: true`
  said something was missing but not what or where, and
  re-calling with the same id returns identical bytes — so
  retrying is never the fix. Pass `query` to anchor the window,
  and read `window: {start, end, total}` to know where in the
  thread you landed.
- **Exact hits are ranked ahead of vector hits.** Not by
  score; by position. A model-written query that happens to
  include a thread's exact title should promote that thread
  to the top regardless of how the embedding landed.
- **The current-thread filter is load-bearing.** Without it
  every recall would return "your current conversation" as
  the top hit, which is useless — that thread's content is
  already in the main model's context window. If you expose a
  new caller, remember to pass `ctx.threadId`.
- **Summary + embedding must both land before a thread is
  semantically recall-able.** Until the summary worker runs,
  `summary` is null and the embedding trigger never fires;
  until the embeddings backfill runs, the vector path skips the
  row. This means brand-new threads are recall-able only by
  title-ILIKE until the background catches up (usually under
  a minute in practice).
- **`topic` is a hint, not a constraint.** The prompt tells
  the agent to bias its first `conversation_search` query
  toward that phrase but nothing stops it from running
  additional searches with different queries. Useful for the
  "I remember we talked about X" case; callers shouldn't
  treat it as filtering.

## Where to go next

- `./memory.md` — the sibling recall surface. Same shape,
  different store.
- `./summaries.md` — upstream of this feature. Produces the
  `threads.summary` rows the recall agent reads.
- `./embeddings.md` — upstream of the vector path.
- `./tools.md` — the toolbox + executor pattern this feature
  plugs into.
