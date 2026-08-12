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
- **Thread embeddings.** The embeddings backfill vectorizes
  `title + summary` into `threads.embedding`. The recall
  agent's search ranks threads against a query vector without
  scanning bodies.

Both signals are background; recall is the read-time consumer.

## Files

- `src/lib/tools/conversation_recall.schema.ts` — the main-chat
  tool definition (schema only; the implementation lives
  server-side).
- `supabase/functions/venice/tools/conversation_search.ts` — merges
  chunk hits with title+summary hits, keeping the better score per
  thread. Chunk hits carry a `passage` back.
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
- `supabase/schema.sql` (summaries + embeddings + search RPCs)
  — `threads.summary`, `threads.embedding`,
  `search_threads_by_embedding` RPC,
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
- **`threads.embedding`** — `vector(2048)`, populated by the
  embeddings backfill after a summary lands. A trigger
  (`clear_thread_embedding_on_change`) nulls this column (and
  `embedding_model` + both embed claim columns) whenever
  `title` or `summary` changes, so the worker re-embeds on its
  next poll.
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

- `conversation_search.execute({ query, limit, include_current })`
  — merges chunk hits and thread-level hits into one row per
  thread, keeping the higher similarity. Chunk hits carry
  `passage`, the excerpt that matched; feed it back as
  `conversation_get`'s `query`. A chunk-index failure degrades
  to title+summary results rather than failing the search.
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
- **Embeddings** — the worker populates `threads.embedding`
  from `title + summary`. The search RPC's cosine-similarity
  path reads that column. The exact-ILIKE fallback covers the
  "just summarized, not yet embedded" window. See
  `./embeddings.md`.
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
- **Search covers message text, not just title + summary.** The
  thread-level vector is built from 2000 chars of `title +
  summary`, which meant the words a user actually typed were
  never in the index — a thread auto-titled "Bread Recipe
  Modification Advice" could not be found by searching
  "lentils" despite that word opening its first message. The
  chunk index (`thread_chunks`) is what fixes that, and it is
  why queries should be written in the user's words rather than
  in title-ish paraphrase.
- **Chunk scores are aggregated, never chunk vectors.**
  `search_thread_chunks_by_embedding` ranks every chunk, keeps
  each thread's single best one, and orders threads by that
  score. Averaging a thread's chunk vectors into one would
  rebuild exactly the centroid dilution the chunking exists to
  remove: in a 107-message thread any one topic is a couple of
  percent of the mean direction and still would not rank.
- **Both indexes are queried and merged, and that is the
  migration path.** A thread has no chunk rows until the
  rechunk unit reaches it. Dropping the title+summary half
  before the backfill has drained silently narrows recall to
  recently-touched threads.
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
