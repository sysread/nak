# Memory

Long-term memory: the `memories` table, the `memory_*` CRUD
tools (search / create / update / reaffirm / doubt / relate /
unrelate / invalidate / delete), the top-level `memory_recall`
tool, the reflection agent that writes memories after
conversations settle, and the recall agent that reads them
during live conversations. One coherent feature with a store,
a writer, and a reader, plus a **volitional layer** the chat
model can manipulate intentionally (confidence nudges and a
relation graph).

## Two layers: subconscious vs volitional

The memory feature now has two layers that coexist in the same
store:

- **Subconscious** — what the reflection agent writes in the
  background. Emergent, cross-thread, review-only from the chat
  model's POV. Historically the whole feature.
- **Volitional** — what the chat model manipulates mid-turn via
  `memory_reaffirm` / `memory_doubt` (confidence nudges) and
  `memory_relate` / `memory_unrelate` (graph edges). Explicit,
  inspectable, LLM-editable. Retrieval now surfaces a qualitative
  confidence tag (`[corroborated]` / `[hedged]` / `[shaky]`) and
  outbound relations alongside each matched memory so the LLM
  sees its own uncertainty and the graph it's been building.

A third, sibling subsystem - the **memory-topics worker** - tags
each memory with a short flat set of topic strings so the
Memories drawer can filter by topic. The shape mirrors the thread
topics worker exactly; the implementation deltas (different
eligibility predicate, different prompt) live in
[`./topics.md`](./topics.md) under "Memory topics" rather than
duplicating the description here.

Samskara is the separate, fully-subconscious counterpart to
this - see `./samskara.md`. Zero shared tables or RPCs; both
ride the system prompt independently.

## Role in the app

Every turn the main chat model can call `memory_recall` to pull in
relevant memories; every time a thread goes quiet, a background
reflection worker reads the transcript and decides whether to write,
update, or invalidate memories based on what it saw. The store lives
in each user's own Supabase; the writes happen through the same
tool harness the main chat uses.

From the user's perspective this is the Memory feature documented
in `docs/user/memory.md`. The dev side has four moving parts:

1. **The store** — `memories` table, RLS-scoped, with a pgvector
   `embedding` column populated asynchronously.
2. **The writer** — the reflection agent runs in a background Web
   Worker, reads settled threads end-to-end, and uses the
   `memoryToolbox` (a write-scoped subset of the memory tools).
3. **The reader** — the recall agent runs inline during a chat
   turn when the main model invokes the `memory_recall` tool.
   Read-only.
4. **The browser** — `src/screens/Memories.svelte` (panel) plus
   `src/components/MemoryList.svelte` (sidebar) plus
   `src/lib/memories-store.svelte.ts` (shared rune). Reached as a
   sibling drawer tab next to chats / recipes / journal; the URL
   keys are `?drawer=memories` for the tab and `?memory=<id>` for
   the focused memory. The sidebar owns the search input and a
   label-only row list; clicking a row sets `route.memory` and
   the panel renders that one card in detail with full inline
   edit / save / delete / reaffirm / doubt / relate UX. Both
   surfaces read from the shared store, so sidebar keystrokes
   filter the listing and panel-side mutations are reflected on
   the sidebar without a refetch. Wraps the shared
   `searchMemoriesSemantic` helper plus the `updateMemory` /
   `deleteMemory` Supabase methods. Human-only; offers hard
   delete but no invalidate (that stays an agent/assistant
   affordance).

   History note: the browser started as a modal opened from a
   footer bookmark icon and a Settings → AI button. Both went
   away when memories graduated to a sibling tab; the URL key
   flipped from `?modal=memories` to `?drawer=memories`. The
   panel briefly rendered every memory as a list of cards before
   switching to the current single-card detail view (parallel to
   Cookbook); a panel full of cards on a wide viewport buried
   the row the user actually came to read.

## Files

- `src/lib/memories.ts` — the shared `searchMemoriesSemantic`
  helper. Owns the embed → pad → RPC + ILIKE merge pipeline.
  Called by both the `memory_search` tool and the Memories
  browser so the two can't drift on what "search a memory"
  means.
- `src/lib/tools/memory_search.ts` — thin tool wrapper over
  `searchMemoriesSemantic`. Preserves the LLM-facing parameter
  schema.
- `src/lib/tools/memory_create.ts`, `memory_update.ts`,
  `memory_invalidate.ts`, `memory_delete.ts` — the CRUD surface.
  Invalidate halves confidence; delete hard-removes.
- `src/lib/tools/memory_reaffirm.ts`, `memory_doubt.ts` — the
  volitional confidence nudges. +0.5 cap 10.0 and ×0.7 no floor
  respectively, matching the `reaffirm_memory_confidence` /
  `doubt_memory_confidence` RPCs. Sit alongside the reflection-
  only `memory_invalidate` (halving) in the `memoryToolbox`.
- `src/lib/tools/memory_relate.ts`, `memory_unrelate.ts` — the
  graph layer. Four kinds (supports / contradicts / generalises
  / specialises); self-loops rejected at the tool boundary;
  duplicate edges collapse to a no-op (unique constraint on
  `(user_id, from, to, kind)`).
- `src/lib/tools/memory_recall.ts` — top-level tool the main
  model calls; triggers `RecallAgent`.
- `src/lib/agents/recall/agent.ts`, `prompt.ts` — the recall
  agent. Inline, read-only, returns a structured JSON note.
- `src/lib/agents/reflection/{agent,prompt,loop,worker,manager}.ts`
  — the reflection worker. Background, write-scoped, no return
  value (side effects = memory tool calls).
- `src/lib/agents/deep-sleep/{agent,prompt,loop,worker,manager,
  runner.svelte,types}.ts` — the memory librarian's slow-wave
  consolidation pass. Background worker; every ~12h it picks a
  longest-unvisited memory, embeds it, fetches similarity
  neighbors via `searchMemoriesByEmbeddingScored`, and runs the
  agent on the seed + neighbors batch. The agent has the
  `memoryLibrarianToolbox` (search, consolidate, relate,
  invalidate, doubt) and decides for each pair whether to
  consolidate, relate, or leave. Marks the entire batch
  visited after a successful run so the next sweep moves on.
- `src/lib/agents/rem/{agent,prompt,loop,worker,manager,
  runner.svelte,types}.ts` — the memory librarian's associative
  integration pass. Background worker; every ~12h it picks the
  oldest eligible conversation from `memory_conversation`,
  fetches the batch of memories the recall agent surfaced on
  that conversation, and runs the agent on it. Primary mode is
  `memory_relate`; rare consolidations handled via the same
  toolbox. Marks the conversation's `memory_conversation` rows
  processed after a successful run. Shares the
  'memory-librarian' lease partition with deep-sleep so the two
  passes can't run concurrently across devices.
- `src/lib/tools/memory_consolidate.ts` and
  `memory_consolidate.schema.ts` — the librarian's content-write
  primitive. Wraps the `consolidate_memories` RPC which atomically
  rewrites the survivor's content + confidence (max of the two
  inputs, NOT a bump), halves the loser's confidence, redirects
  `memory_conversation` rows from loser to survivor, and
  redirects `memory_relations` edges (dropping self-loops and
  duplicates).
- `src/lib/tools/memory_librarian_toolbox.ts` — toolbox shared
  by both librarian agents. Includes `memory_consolidate`,
  search, relate/unrelate, invalidate, doubt, and
  conversation_search. Deliberately omits create / update /
  reaffirm (the design rules from the librarian discussion).
- `src/lib/memory-events.ts` — window-level event bus the
  librarians and the content-write tools use to notify the
  in-page memories store and the changelog panel of writes.
- `src/components/MemoryChangelogPanel.svelte` — the Memories
  tab's default surface when no memory is selected (suppressed
  while a librarian confirm/progress strip is up, gated by
  `librarianStripVisible`, so the button-triggered form isn't
  competing with a full history list). Renders `memory_changelog`
  newest-first with cursor-paged "Load more", clickable entry
  labels (fetch + upsert the row into the store, then
  `navigate({ memory })`), and a live refresh on `onMemoryChange`.
  Parallel to `WikiChangelogPanel.svelte`.
- `src/lib/ui/memory-changelog-panel.ts` — pure UI-behavior
  primitives for the panel (`PAGE_SIZE`, `kindLabel`,
  `formatChangelogStamp`, `canOpenMemory`, `isExhausted`).
  Parallel to `src/lib/ui/wiki-changelog-panel.ts`.
- `src/lib/ui/memory-librarian.ts` — step-list bookkeeping
  primitives the Memories panel uses to render the manual-run
  progress strip. Unit-tested at
  `tests/memory-librarian-ui.test.ts`.
- `src/lib/tools/recall_toolbox.ts` — the read-only toolbox the
  recall agent uses. Standalone file to break an import cycle.
- `src/screens/Memories.svelte` — human-facing browser, panel
  side. Mounted in the chat shell's main column when the
  `memories` drawer tab is active; sibling of `Cookbook.svelte`
  / `Journal.svelte`. Renders exactly one memory at a time -
  the row whose id is in `route.memory`. With no selection
  shows the `MemoryChangelogPanel` (the tab's default surface,
  hidden while a librarian strip is up); the leftmost top-bar
  button (a `triggerChangelog` $bindable, ahead of the two
  librarian-pass buttons) jumps back to it by deselecting the open
  memory and dismissing a finished librarian strip. With a
  selection that's not in the active search results shows a "clear
  the search to find it" hint. Owns the inline edit /
  save / delete / reaffirm / doubt / relate UX - the edit and
  delete flows now require a one-line change message that lands
  in the changelog, mirroring the tools' `message` param - plus
  the `+
  Relate` candidate picker (debounced semantic search of its
  own). Reads results and relations from `memoriesStore`;
  mutations call the store-level helpers (`patchMemoryRow`,
  `removeMemoryRow`, `addRelationEdge`, `removeRelationEdge`)
  so the sidebar re-renders without a refetch. Confirmed
  delete also clears `route.memory` so the panel doesn't dwell
  on a row that no longer exists.
- `src/components/MemoryList.svelte` — human-facing browser,
  sidebar side. Search input bound to `memoriesStore.query`
  with a 200ms debounce around `runMemoriesSearch`. Each row
  shows `label + classifyMemoryConfidence` chip and an
  `.active` marker when its id matches `route.memory`. Clicking
  a row calls `navigate({ memory: id })` and (on mobile) closes
  the drawer. An infinite-scroll sentinel (`use:infiniteScroll`)
  at the list tail pages the browse list - shown only when
  `memoriesStore.hasMore`, which is forced false during a search.
  Composition-only: the `SEARCH_DEBOUNCE_MS` tunable and the
  empty-state message decision live in the primitives module
  next door.
- `src/lib/ui/memories-list.ts` — pure UI-behavior primitives
  for the sidebar listing. `SEARCH_DEBOUNCE_MS` (shared with
  the recipe / wiki drawer tabs) and `emptyMessage(query)`
  (picks between the "No matches." search-empty reading and
  the cold-account "No memories yet. They accumulate as you
  chat." explainer). Topic filtering runs server-side via
  `topicsFilterClause`, so this module deliberately carries
  no client-side topic predicate. Unit-tested at
  `tests/memories-list.test.ts`.
- `src/lib/memories-store.svelte.ts` — shared reactive state
  (`results`, `relations`, `loading`, `loaded`, `error`,
  `query`, `offset`, `hasMore`, `loadingMore`) plus
  `runMemoriesSearch`, `loadMemoriesFirstPage`,
  `loadMoreMemories`, `patchMemoryRow`, `removeMemoryRow`,
  `addRelationEdge`, `removeRelationEdge`. `runMemoriesSearch`
  dispatches on the query: an empty query routes to the
  paginated browse list (`loadMemoriesFirstPage`, served by
  `listMemoriesPage` most-recent-first), a non-empty query runs
  the capped semantic search and forces `hasMore` false.
  `loadMoreMemories` appends the next offset page and merges its
  relation edges into the existing map. Owns the AbortController
  for the in-flight semantic search so rapid typing doesn't fire
  one embedding request per character.
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
- **Memories browser** — the **Memories** drawer tab next to
  chats / recipes / journal. Tab pick navigates to
  `?drawer=memories` and lazy-loads via `runMemoriesSearch` if
  the store hasn't fetched yet. Sidebar (`MemoryList.svelte`)
  owns the search input; panel (`Memories.svelte`) owns the
  inline edit / delete / reaffirm / doubt / relate UX. Both read
  the same `memoriesStore`. The store searches via
  `searchMemoriesSemantic` (same helper the tool uses) and edits
  via `SupabaseService.updateMemory` / `deleteMemory`. No tool
  harness involved - the user has their own session-scoped
  supabase client, so RLS is already in force.

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
    `memory_invalidate` halves it (reflection-only, ×0.5);
    `memory_update` calls the `bump_memory_confidence` RPC which
    adds 1.0 up to 10.0; the chat-side `memory_reaffirm` calls
    `reaffirm_memory_confidence` (+0.5 cap 10.0) and
    `memory_doubt` calls `doubt_memory_confidence` (×0.7 no
    floor). Search floors at 0.05 and applies a log boost so
    corroborated memories rank higher. `classifyMemoryConfidence`
    in `src/lib/memories.ts` is the single source of truth for
    the qualitative-tag thresholds (>=5.0 corroborated, >=1.5
    neutral/no-tag, >=0.5 hedged, <0.5 shaky).
- **`memory_relations` table** — directed edges on the graph.
  Columns: `id`, `user_id`, `from_memory_id`, `to_memory_id`,
  `kind`, `note`, `created_at`. `kind in
  ('supports','contradicts','generalises','specialises')` as a
  check constraint. Unique constraint on `(user_id,
  from_memory_id, to_memory_id, kind)` collapses duplicate
  inserts. Both FKs have `on delete cascade`, so deleting a
  memory cleans up all its edges (in and out) automatically.
  Indexed on `(user_id, from_memory_id)` and `(user_id,
  to_memory_id)` for forward and reverse traversal.
- **`get_memory_relations(p_ids uuid[])` RPC** — the retrieval
  primitive the opening-recall, `memory_search`, and
  `Memories.svelte` paths all share. Returns outbound edges for
  the supplied ids, joined to the target memory's label / data /
  confidence fields, RLS-scoped by `auth.uid()` through the
  underlying tables.
- **Trigger `clear_memory_embedding_on_change`** — nulls
  `embedding`, `embedding_model`, and both claim columns when
  `label` or `data` changes. Ensures an in-flight worker save
  can't land a now-stale embedding.
- **RLS policies** — all four (select / insert / update / delete)
  are `auth.uid() = user_id`. No cross-user read is possible
  via the publishable key.
- **`threads.last_reflected_msg_id`**, plus
  `reflection_holder_id` and `reflection_claim_expires_at`
  — same shape as the
  summaries claim columns. A message id (not a timestamp) is
  the pointer because ids are stable across clock skew and
  terminal-assistant-detection is a straightforward query.
- **Reflection lease** — `worker_leases` row with
  `worker_kind='reflection'`. Runs concurrently with the
  `'embedding'` and `'summary'` leases.
- **`memories.last_librarian_visit_at timestamptz`** — per-row
  "when did deep-sleep last visit this neighborhood." Picked
  oldest-first (nulls first) as the seed for the next cycle.
  Trigger `clear_memory_librarian_visit_on_change` resets it on
  label/data change (so a memory whose text moved re-enters the
  pool); confidence-only nudges leave it alone.
- **`memory_conversation` table** — `(memory_id, conversation_id,
  user_id, last_seen_at, last_processed_at)` with unique on
  `(memory_id, conversation_id)`. The recall path upserts on
  every recall (memories the recall agent surfaced during a
  conversation are evidence of co-occurrence). Rem's
  eligibility predicate is
  `last_processed_at is null or last_processed_at < last_seen_at`.
  Cascade on delete from both `memories` and `threads`; merge-on-
  consolidation handled in the `consolidate_memories` RPC.
- **`profiles.deep_sleep_last_run_at`,
  `profiles.rem_last_run_at`** — singleton cadence gates,
  mirroring `wiki_librarian_last_run_at`. `claim_deep_sleep_run`
  and `claim_rem_run` RPCs perform the atomic UPDATE-with-WHERE.
- **`consolidate_memories(survivor_id, loser_id, label, data)`
  RPC** — the librarian's atomic content-write. Sets survivor
  confidence to `greatest(survivor, loser)` (preserves stronger
  evidence; does NOT bump), halves loser, redirects
  `memory_conversation` rows and `memory_relations` edges, drops
  self-loops and unique-constraint duplicates from the
  redirected edges. Single transaction; no client-side
  coordination needed.
- **Librarian lease** — `worker_leases` row with
  `worker_kind='memory-librarian'`. Shared between deep-sleep
  and rem so only one of them can run per user across devices.
- **`memory_changelog` table** — append-only audit trail of
  content-affecting mutations, parallel in shape and intent to
  `wiki_changelog`. Columns: `id`, `user_id`, `memory_id`
  (`on delete set null` so a hard delete doesn't take its history
  with it), `kind in ('create','update','delete')`,
  `label_at_change` (snapshot so a row whose memory was deleted
  still reads without a join), `message` (commit-style, 1-200
  char CHECK mirroring `MAX_MEMORY_CHANGELOG_MESSAGE_CHARS` in
  `src/lib/memories.ts`), `created_at`. Index on `(user_id,
  created_at desc)` for the panel's newest-first cursor paging.
  RLS is select + insert only - no update/delete policy.
  **What gets logged**: create / update / delete (from the
  volitional tools and the user's direct edits in
  `Memories.svelte`) plus librarian `memory_consolidate`, which
  records an `update` on the survivor with an auto-generated
  "Merged X into this" message. **What does NOT**: confidence-
  only operations (reaffirm / doubt / invalidate / the reflection
  auto-bump) and relation edges - they'd swamp the "what did I
  learn / forget / revise" signal with nudge churn. Writes are
  best-effort: a failed changelog insert never rolls back the
  mutation that already landed. Surfaced by
  `MemoryChangelogPanel.svelte` (the Memories tab's default
  no-selection surface) via `supabase.listMemoryChangelog`.

## Contracts

- `memory_search.execute({ query, limit })` — vector search (when
  `query` is non-empty) merged with ILIKE against unembedded
  rows. Result shape: `{ id, label, data, updated_at }[]`. The
  model can't tell vector from ILIKE apart; the fallback is
  pure plumbing.
- `memory_create.execute({ label, data, message })` — inserts.
  The trigger nulls the embedding; the worker embeds it on its
  next cycle. `message` is required (commit-style) and appends a
  `create` changelog row.
- `memory_update.execute({ id, label?, data?, message })` —
  writes changed fields, calls `bump_memory_confidence`, and
  relies on the trigger to null the embedding if either text
  changed. `message` is required and appends an `update`
  changelog row.
- `memory_invalidate.execute({ id })` — halves confidence via
  `decay_memory_confidence` RPC. Not destructive. No changelog
  entry (confidence-only).
- `memory_delete.execute({ id, message })` — hard delete.
  User-directed only; the reflection agent's toolbox excludes
  this tool. `message` is required; snapshots the label before
  deleting and appends a `delete` changelog row (with
  `memory_id` null).
- `memory_consolidate.execute({ survivor_id, loser_id, label,
  data })` — librarian-only merge. Appends an `update` changelog
  row on the survivor with an auto-generated "Merged X into this"
  message (no `message` param on this tool - the label snapshot
  of the merged-away memory supplies the text).
- `memory_reaffirm.execute({ id })` — +0.5 cap 10.0 via
  `reaffirm_memory_confidence`. Gentler than the reflection
  agent's bump (+1.0). Returns `{id, confidence}` post-bump.
- `memory_doubt.execute({ id })` — ×0.7 no floor via
  `doubt_memory_confidence`. Gentler than invalidate's halving.
  Returns `{id, confidence}` post-decay.
- `memory_relate.execute({ from_id, to_id, kind, note? })` —
  inserts an edge. Rejects self-loops at the wire boundary.
  Duplicate edges (unique-constraint violation) are mapped to
  `{ok:true, already_exists:true, kind}` rather than an error.
- `memory_unrelate.execute({ id })` — deletes an edge row.
  Hard-delete; no soft variant. The `id` is the relation row's
  id, not a memory id.
- `memory_search.execute({ query, limit })` — vector search
  merged with ILIKE. Result shape now includes `confidence`,
  `confidence_tag` (nullable), and a `relations` array per row
  hydrated from `get_memory_relations`. Up to 5 edges per
  source (`SEARCH_RELATION_FANOUT`).
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
  note into its reply. The chat screen also owns the
  `memories` drawer tab and the `MemoryList` / `Memories` panel
  pair that render against the shared `memoriesStore`. See
  `./chat.md`.
- **Settings** — no interaction. There used to be a "Browse
  memories" button in the AI pane (and a prose pointer after
  that); both went away once the Memories drawer tab landed
  as a prominent affordance of its own. The settings module
  now has no awareness of memories at all.
- **Tools** — the five memory tools live in the registry
  (`tools/index.ts`). Reflection uses `memoryToolbox` (a
  write-scoped subset: search + create + update + invalidate,
  NOT delete, NOT any recall). Recall uses `recallToolbox`
  (search only). See `./tools.md`.
- **Embeddings** — the worker populates `memories.embedding`
  on a poll of `embedding is null`. Memory search's vector path
  reads that column; the ILIKE fallback covers the "just
  written, not yet embedded" window. See `./embeddings.md`.
- **Topics** — the memory-topics background worker tags each
  memory with 1-4 short topic strings so the Memories drawer can
  offer a topic filter. Both surfaces (search + filter) share the
  same `searchMemoriesSemantic` pipeline; the filter is an
  optional `selectedTopics` argument that the assistant-facing
  `memory_search` tool doesn't pass (no UI on the LLM side). See
  `./topics.md` under "Memory topics" for the worker shape, the
  schema deltas, and the trigger / claim discipline.
- **Summaries / conversation recall** — separate store (thread
  rows), separate agents. Mentioned here only because the
  reflection loop shares the same claim-pattern plumbing with
  the summary loop (see `src/lib/agents/reflection/loop.ts` and
  `src/lib/agents/summary/loop.ts` — they mirror each other
  on purpose).
- **Logging** - the reflection worker's loop driver and
  the `memory_recall` agent both emit breadcrumbs through
  `createLogger` (`reflection-worker`, `recall-agent`).
  Worker-side entries relay main-thread via postMessage
  and surface in the in-app log drawer alongside
  main-thread logs. See `./logging.md`.

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
- **Confidence deltas are per-layer.** Reflection agent uses
  the stronger bump (+1.0) and halving decay (×0.5) because it
  operates on settled evidence; the chat-side reaffirm (+0.5)
  and doubt (×0.7) are mid-turn nudges on a single exchange.
  Do not collapse them without reconsidering the implied
  "evidence strength" of each path.
- **`memory_invalidate` stays alongside `memory_doubt`.** The
  former halves; the latter multiplies by 0.7. Kept as separate
  tools so the reflection agent can act decisively on
  settled-evidence contradictions while the chat model has a
  gentler lever mid-turn. If observation shows the two
  collapse in practice, revisit.
- **`contradicts` edges are stored asymmetrically.** Writing
  `A contradicts B` does not auto-insert `B contradicts A`.
  The LLM chooses whether the relationship is directional.
  Retrieval only traverses outbound edges, so asymmetry
  matters: if both directions should surface, both need to be
  asserted.
- **Relation cycles are legal.** The schema does not enforce
  acyclicity. Opening-recall's bounded traversal (1 hop, cap 5
  fan-out) is what prevents a cyclic graph from blowing the
  priming budget; callers adding deeper traversal must add
  their own cycle-bound.
- **Tag leakage into the LLM's voice is expected.** The
  qualitative tags (`[corroborated]` / `[hedged]` / `[shaky]`)
  ride inline in the injected memory text on purpose - the
  model's reply voice will pick up hedging cues from them. If
  you're reviewing a PR and see the model suddenly qualifying
  more, that's the volitional layer doing its job, not a
  regression.

## Where to go next

- `docs/user/memory.md` — user-facing version of the same
  story. Useful for framing.
- `./embeddings.md` — the worker that makes semantic search
  work.
- `./conversation-recall.md` — the sibling recall surface that
  targets thread summaries, not memory rows.
- `./tools.md` — the registry + executor pattern the memory
  tools plug into.
