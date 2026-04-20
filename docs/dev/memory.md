# Memory

Long-term memory: the `memories` table, the `memory_*` tools
that CRUD it (search/create/update/invalidate/delete) plus the
`memory_recall` top-level tool, the reflection agent that writes to it after
conversations settle, and the recall agent that reads from it
during live conversations. One coherent feature with a store, a
writer, and a reader.

## Role in the app

Every turn the main chat model can call `memory_recall` to pull in
relevant memories; every time a thread goes quiet, a background
reflection worker reads the transcript and decides whether to write,
update, or invalidate memories based on what it saw. The store lives
in each user's own Supabase; the writes happen through the same
tool harness the main chat uses.

From the user's perspective this is the Memory feature documented
in `docs/user/memory.md`. The dev side has three moving parts:

1. **The store** — `memories` table, RLS-scoped, with a pgvector
   `embedding` column populated asynchronously.
2. **The writer** — the reflection agent runs in a background Web
   Worker, reads settled threads end-to-end, and uses the
   `memoryToolbox` (a write-scoped subset of the memory tools).
3. **The reader** — the recall agent runs inline during a chat
   turn when the main model invokes the `memory_recall` tool.
   Read-only.

## Files

- `src/lib/tools/memory_search.ts` — vector search with ILIKE
  fallback for unembedded rows.
- `src/lib/tools/memory_create.ts`, `memory_update.ts`,
  `memory_invalidate.ts`, `memory_delete.ts` — the CRUD surface.
  Invalidate halves confidence; delete hard-removes.
- `src/lib/tools/memory_recall.ts` — top-level tool the main
  model calls; triggers `RecallAgent`.
- `src/lib/agents/recall/agent.ts`, `prompt.ts` — the recall
  agent. Inline, read-only, returns a structured JSON note.
- `src/lib/agents/reflection/{agent,prompt,loop,worker,manager}.ts`
  — the reflection worker. Background, write-scoped, no return
  value (side effects = memory tool calls).
- `src/lib/tools/recall_toolbox.ts` — the read-only toolbox the
  recall agent uses. Standalone file to break an import cycle.
- `supabase/schema.sql` (memory section + reflection section) —
  table shape, triggers, RLS policies, reflection claim columns
  on `threads`.

## Entry points

- **`memory_recall` tool call** — main model invokes it mid-turn;
  chat loop dispatches to `RecallAgent.run`, which spawns a
  headless tool-call loop on the fast tier with
  `recallToolbox`. Returns a structured JSON output the tool
  encodes as the `role='tool'` message payload for the next
  round.
- **Reflection worker cycle** — started by
  `reflectionManager.start()` on `activate()`. Acquires the
  `worker_kind='reflection'` lease; polls `threads` for rows
  where there's a terminal assistant message newer than
  `last_reflected_msg_id` and no live claim; claims one, runs
  the agent, stamps `last_reflected_msg_id` via a guarded RPC.
- **User memory CRUD through the assistant** — user asks "what
  do you remember about me?" or "forget that I liked X"; the
  main model calls `memory_search` / `memory_update` /
  `memory_delete` through the normal tool flow.

## Data model

- **`memories` table** (full definition in schema.sql).
  Key columns:
  - `id`, `user_id`, `label`, `data`, `created_at`, `updated_at`
  - `embedding vector(2048)` — padded from the 1024-dim native
    Venice embedding (see `padEmbeddingForStorage` in
    `models.ts` for why)
  - `embedding_model text` — records which Venice model produced
    the vector; a future rotation reselects stale rows by
    `where embedding_model <> $current`
  - `embedding_claim_holder`, `embedding_claim_expires` — per-row
    claim for the embeddings worker
  - `confidence real default 1.0` — starts at 1.0 on create;
    `memory_invalidate` halves it; `memory_update` calls the
    `bump_memory_confidence` RPC which adds 1.0 up to 10.0.
    Search floors at 0.05 and applies a log boost so
    corroborated memories rank higher.
- **Trigger `clear_memory_embedding_on_change`** — nulls
  `embedding`, `embedding_model`, and both claim columns when
  `label` or `data` changes. Ensures an in-flight worker save
  can't land a now-stale embedding.
- **RLS policies** — all four (select / insert / update / delete)
  are `auth.uid() = user_id`. No cross-user read is possible
  via the anon key.
- **`threads.last_reflected_msg_id`** + `reflection_holder_id`
  + `reflection_claim_expires_at` — same shape as the
  summaries claim columns. A message id (not a timestamp) is
  the pointer because ids are stable across clock skew and
  terminal-assistant-detection is a straightforward query.
- **Reflection lease** — `worker_leases` row with
  `worker_kind='reflection'`. Runs concurrently with the
  `'embedding'` and `'summary'` leases.

## Contracts

- `memory_search.execute({ query, limit })` — vector search (when
  `query` is non-empty) merged with ILIKE against unembedded
  rows. Result shape: `{ id, label, data, updated_at }[]`. The
  model can't tell vector from ILIKE apart; the fallback is
  pure plumbing.
- `memory_create.execute({ label, data })` — inserts. The trigger
  nulls the embedding; the worker embeds it on its next cycle.
- `memory_update.execute({ id, label?, data? })` — writes
  changed fields, calls `bump_memory_confidence`, and relies
  on the trigger to null the embedding if either text changed.
- `memory_invalidate.execute({ id })` — halves confidence via
  `decay_memory_confidence` RPC. Not destructive.
- `memory_delete.execute({ id })` — hard delete. User-directed
  only; the reflection agent's toolbox excludes this tool.
- `RecallAgent.run(req): Promise<AgentRunResult<RecallOutput>>` —
  `RecallOutput` is a discriminated union:
  `{kind:'none'} | {kind:'note', note:string}`. The recall tool
  parses this and hands the JSON back to the main chat loop.
- `ReflectionAgent.run(req)` — returns a `ReflectionOutput` that
  carries counters, not text. The agent's "answer" is whatever
  `memory_*` tool calls it made; the final text is discarded.

## Interactions with other features

- **Chat** — the main model invokes `memory_recall` as a tool
  mid-turn. The chat loop dispatches it, the recall agent runs
  inline on the fast tier, the structured output becomes a
  `role='tool'` message, and the main model folds the returned
  note into its reply. See `./chat.md`.
- **Tools** — the five memory tools live in the registry
  (`tools/index.ts`). Reflection uses `memoryToolbox` (a
  write-scoped subset: search + create + update + invalidate,
  NOT delete, NOT any recall). Recall uses `recallToolbox`
  (search only). See `./tools.md`.
- **Embeddings** — the worker populates `memories.embedding`
  on a poll of `embedding is null`. Memory search's vector path
  reads that column; the ILIKE fallback covers the "just
  written, not yet embedded" window. See `./embeddings.md`.
- **Summaries / conversation recall** — separate store (thread
  rows), separate agents. Mentioned here only because the
  reflection loop shares the same claim-pattern plumbing with
  the summary loop (see `src/lib/agents/reflection/loop.ts` and
  `src/lib/agents/summary/loop.ts` — they mirror each other
  on purpose).

## Gotchas

- **Invalidate vs delete is load-bearing.** The reflection
  agent's prompt explicitly tells it "use memory_invalidate,
  not memory_delete" and the `memoryToolbox` doesn't even
  contain delete. Halving confidence is reversible; if new
  evidence re-confirms a memory the agent invalidated, the
  next update can promote it back. Hard deletes are
  user-directed ("forget that I ever liked X") and come through
  the main chat's full tool set.
- **Main chat's `memory_recall` is excluded from every agent
  toolbox.** A reflection agent running `memory_recall` would
  spawn another recall agent — recursion with no purpose,
  because the reflection already has the whole transcript in
  context. Recall excluding recall is the same: no nested
  recall on the recall agent's own loop.
- **Pre-recall message trimming.** The recall tool is invoked
  from inside the chat loop, which means at the moment
  `memory_recall` fires, the main model has already emitted an
  assistant row with `tool_calls` on it. That row is in the
  transcript the recall agent would otherwise read, and it
  confuses the agent into re-invoking the same recall it was
  meant to satisfy. `RecallAgent` drops any trailing assistant-
  with-tool_calls row before handing the transcript to its
  model.
- **Embedding dimensions are padded.** Venice's current model
  emits 1024 dims; the column is `vector(2048)` for future
  compat. The padding is zero-extension; cosine similarity is
  invariant. If you wire a different embedding source, route it
  through `padEmbeddingForStorage` or it'll hit a shape error
  on write.
- **Memory search vector path ignores invalidated rows by
  threshold, not predicate.** The RPC floors confidence at
  0.05 and applies a log boost; a very-invalidated memory is
  effectively hidden but still on disk. This is intentional —
  the row is recoverable if the agent re-learns the fact —
  but it means "why is this memory not showing up in search"
  can have two answers (unembedded, or invalidated-below-
  threshold).
- **Confidence is bumped on every `memory_update`, not just
  on meaningful changes.** A no-op update still bumps the
  counter (up to the 10.0 cap). The agent's prompt discourages
  meaningless updates, but if you ever expose update to a
  looser caller, consider whether that counter needs
  gating.

## Where to go next

- `docs/user/memory.md` — user-facing version of the same
  story. Useful for framing.
- `./embeddings.md` — the worker that makes semantic search
  work.
- `./conversation-recall.md` — the sibling recall surface that
  targets thread summaries, not memory rows.
- `./tools.md` — the registry + executor pattern the memory
  tools plug into.
