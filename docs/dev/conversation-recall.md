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
- **Thread embeddings.** The embeddings worker vectorizes
  `title + summary` into `threads.embedding`. The recall
  agent's search ranks threads against a query vector without
  scanning bodies.

Both signals are background; recall is the read-time consumer.

## Files

- `src/lib/tools/conversation_recall.ts` — the top-level tool
  definition.
- `src/lib/agents/conversation_recall/agent.ts`, `prompt.ts` —
  the agent that runs one recall pass.
- `src/lib/tools/conversation_search.ts` — exact-ILIKE + vector
  merge over the user's threads. The recall agent's only tool.
  Returns hits labeled by `match_kind: 'exact' | 'semantic'`.
- `src/lib/tools/conversation_recall_toolbox.ts` — the read-only
  toolbox. Standalone file to break an import cycle (see
  Gotchas).
- `supabase/schema.sql` (summaries + embeddings + search RPCs)
  — `threads.summary`, `threads.embedding`,
  `search_threads_by_embedding` RPC,
  `listThreadSummariesByIds` surface.

## Entry points

- **Main model invokes `conversation_recall`** — with or without
  an optional `topic` hint. The tool calls
  `ConversationRecallAgent.run({ threadId, topic })`, which
  loads the current thread, trims the trailing
  assistant-with-tool_calls row (same reason as memory recall —
  see `./memory.md` Gotchas), appends the recall instruction as
  a final user turn, and calls `runHeadlessToolLoop` with
  `conversationRecallToolbox`.
- **Agent tool calls** — inside the headless loop, the agent
  calls `conversation_search` one or more times. Exact-title
  hits are ordered ahead of semantic (vector) hits; the current
  thread is filtered out by default.

## Data model

- **`threads.summary`** — 2-3 sentences written by the summary
  worker. Null until summarized. See `./summaries.md`.
- **`threads.embedding`** — `vector(2048)`, populated by the
  embeddings worker after a summary lands. A trigger
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
  `{kind:'none'} | {kind:'note', note:string}`. Parsed via
  `parseRecallOutput` shared from `agents/recall/agent.ts`.

## Contracts

- `conversation_search.execute({ query, limit, include_current })`
  — merges exact-title hits (`'exact'`) ahead of vector hits
  (`'semantic'`), preserving backend ordering. Caps at `limit`
  (default 20, max 100). When the embedding fetch fails (no
  Venice key, offline), falls back to ILIKE-only results.
- `ConversationRecallAgent.run(req): Promise<AgentRunResult<
  ConversationRecallOutput>>` — `req.input` is
  `{ threadId, topic? }`. The returned `note` is parsed from
  the agent's final JSON; a parse failure collapses to
  `{kind:'none'}` so a malformed model response doesn't fail
  the main chat turn.
- **JSON-mode discipline.** The agent passes
  `responseFormat: { type: 'json_object' }` to
  `runHeadlessToolLoop`. Providers only constrain the *text*
  part of a response to the requested shape, so tool-call
  rounds pass through unaffected.

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
  `conversation_search` is shared by chat and the recall agent:
  it lives in the registry and is also exposed via
  `conversationRecallToolbox`. See `./tools.md`.
- **Logging** - the conversation-recall agent emits
  progress breadcrumbs through
  `createLogger('conversation-recall-agent')`. Entries
  land in the in-app log drawer alongside main-thread
  logs. See `./logging.md`.

## Gotchas

- **Circular import dodge.** `conversation_recall` lives in
  `tools/index.ts` and triggers
  `agents/conversation_recall/agent.ts`, which needs a
  toolbox. If the agent imported the toolbox from
  `tools/index.ts` the cycle would bite — agent loads before
  `conversationRecall` is defined, toolbox is undefined at
  class-init time. Fix: `conversation_recall_toolbox.ts` is
  its own file, re-exported from `tools/index.ts` so consumers
  reading `$lib/tools` still see it. The memory recall side
  has the exact same structure — both dodge the cycle the
  same way.
- **Helpers imported directly from `recall/agent`.** The
  conversation-recall agent reaches across to
  `agents/recall/agent.ts` for `trimToLastUserTurn`,
  `parseRecallOutput`, and `messageToVenice`. These are
  small, stable, and hoisting them into a shared module would
  be premature abstraction; the comment at the top of the
  conversation-recall agent calls this out explicitly.
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
  until the embeddings worker runs, the vector path skips the
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
