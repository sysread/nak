# Memory

Long-term memory: the `memories` table, the `memory_*` CRUD
tools (search / get / create / update / reaffirm / doubt / relate /
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
relevant memories; at the tail of each completed streaming chat turn,
the venice edge function fires a reflection pass that reads a settled
thread and decides whether to write, update, or invalidate memories
based on what it saw. The store lives in each user's own Supabase;
the writes happen through the same tool harness the main chat uses.

From the user's perspective this is the Memory feature documented
in `docs/user/memory.md`. The dev side has five moving parts:

1. **The store** — `memories` table, RLS-scoped, with a pgvector
   `embedding` column populated asynchronously.
2. **The writer** — the reflection agent runs in the venice edge
   function, reads settled threads end-to-end, and uses a
   write-scoped subset of the memory tools.
3. **The reader** — the recall agent runs in the venice edge
   function, inline in the tool dispatch when the main model
   invokes the `memory_recall` tool. Read-only.
4. **The librarians** — rem and deep-sleep, the two tidy-up
   passes, also in the venice edge function. Hourly pg_cron
   sweeps drive a per-user 12h cadence; the Memories panel's
   manual buttons trigger the same review cores on demand.
5. **The browser** — `src/screens/Memories.svelte` (panel) plus
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
  helper. Owns the embed → pad → RPC + ILIKE merge pipeline for
  the browser surfaces (the Memories panel and the opening-recall
  gather). The function-side `memory_search` tool mirrors the
  same pipeline; keep the two in step so a human and the model
  can't disagree on what "search a memory" means.
- `src/lib/tools/memory_*.schema.ts` — the browser side of every
  chat-facing memory tool (search / get / create / update / delete /
  reaffirm / doubt / relate / unrelate / recall). Schema-only
  `serverSideTool` registrations: the browser ships the wire
  `tools` array and the venice function dispatches. No memory
  tool executes in the browser.
- `supabase/functions/venice/tools/memory_get.ts` — by-id fetch of
  one memory (`{found, memory: {id, label, data, confidence,
  created_at, updated_at}}`), the read-only drill-down behind the
  recall block's memory citations. Parallel to `conversation_get` /
  `wiki_get`; always-on, b-strict (`user_id` filter).
- `supabase/functions/venice/tools/memory_*.ts` — the tool
  implementations. Invalidate halves confidence; delete
  hard-removes; reaffirm +0.5 cap 10.0 and doubt ×0.7 no floor,
  matching the `reaffirm_memory_confidence` /
  `doubt_memory_confidence` RPCs; relate/unrelate manage the
  graph (self-loops rejected at the tool boundary, duplicate
  edges collapse to a no-op on the unique constraint). b-strict
  throughout: the service-role client bypasses RLS, so every
  query stamps or filters `user_id` explicitly.
- `supabase/functions/venice/agents/recall.ts` — the recall
  agent plus the registered `memory_recall` ToolDef. Inline in
  the chat turn's tool dispatch, read-only (memory_search only),
  returns a structured JSON note. Side effect: upserts a
  `memory_conversation` row per surfaced memory - the
  co-occurrence hint queue rem drains.
- `supabase/functions/venice/agents/reflection.ts` — the reflection
  agent. Exports `reflectOneThread(adminClient, userId)`; runs
  write-scoped with no return value (side effects = memory tool
  calls). Its prompt instructs TIMELESS memories - no "this session",
  no write-date narration, no first-person AI self-logging - because a
  body that stamps when it was written reads back later as a
  current-chat event (the row's `created_at` already records when it
  was learned). `__test.REFLECTION_PROMPT` pins that guidance.
- `supabase/functions/venice/agents/deep_sleep.ts` — the memory
  librarian's slow-wave consolidation pass. Per run it picks the
  longest-unvisited memory as the seed, embeds it, fetches the
  top-8 cosine neighbors above 0.80 via
  `search_memories_by_embedding_scored`, and runs the agent on
  the seed + neighbors batch (skipping Venice entirely when the
  seed is lonely). The agent decides per pair whether to
  consolidate, relate, or leave. Marks the entire batch visited
  after a successful run so the next sweep moves on. Exports
  `runDeepSleepSweepTick` (cron path) and `runDeepSleepManual`
  (Memories-panel path).
- `supabase/functions/venice/agents/rem.ts` — the memory
  librarian's associative integration pass. Per run it drains up
  to 3 eligible conversations from `memory_conversation` (oldest
  first), fetches the batch of memories the recall agent surfaced
  on each, and runs the agent on batches of 2+ (smaller batches
  are marked processed without a Venice call). Primary mode is
  `memory_relate`; rare consolidations handled via the same
  toolbox. Marks the conversation's rows processed after a
  successful run. Exports `runRemSweepTick` and `runRemManual`.
- `supabase/functions/venice/agents/_memory_librarian_tools.ts` —
  the toolbox shared by both librarian passes
  (`buildMemoryLibrarianToolbox`: consolidate, reshape, search,
  relate/unrelate, invalidate, doubt, conversation_search -
  deliberately no create / update / reaffirm) plus the shared
  in-flight guard helpers (`claimMemoryLibrarianInflight` /
  `releaseMemoryLibrarianInflight`).
- `supabase/functions/venice/tools/memory_reshape.ts` — the
  librarian's framing-only content rewrite: change a row's label/data
  to strip encoding-time poison ("this conversation", write-date
  narration, first-person AI self-logging) WITHOUT changing facts or
  confidence. Mechanically memory_update minus the contract: a distinct
  tool so the librarian's "reframe, don't generate" boundary stays
  legible (the toolbox excludes memory_update by name). Logs an
  `update` changelog row; the embedding-clear trigger re-embeds the
  cleaned text. The rem / deep-sleep prompts scope it to de-poisoning,
  so memories heal over time rather than relying on read-time laundering
  forever (see [`context-recall.md`](./context-recall.md) -> "Keeping
  the store clean").
- `supabase/functions/venice/tools/memory_consolidate.ts` — the
  librarian's content-write primitive (wire schema lives with the
  toolbox above; not reachable from reflection or the main chat).
  Wraps the `consolidate_memories` RPC which atomically
  rewrites the survivor's content + confidence (max of the two
  inputs, NOT a bump), halves the loser's confidence, redirects
  `memory_conversation` rows from loser to survivor, and
  redirects `memory_relations` edges (dropping self-loops and
  duplicates).
- `src/lib/agents/memory-librarian-run.svelte.ts` — the
  navigation-stable singleton holding the manual-run UI state
  (pass / steps / result / error). Subscribes to the per-user
  `agent-runs:<userId>` Broadcast channel BEFORE POSTing
  `/rem-run` or `/deep-sleep-run`, filters events on the runId it
  minted, and survives the Memories panel unmounting on a drawer
  tab switch.
- `src/lib/memory-events.ts` — window-level event bus the
  browser's memory surfaces use to notify each other of writes.
  Fired by the panel's direct edits, by the manual librarian
  strip on a finished run, and by the realtime subscription
  relaying server-side writes (see the Chat entry under
  "Interactions with other features").
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
- `supabase/schema.sql` (memory section + reflection section +
  the "Cadence gates + run coordination for the two librarian
  agents" block) — table shape, triggers, RLS policies,
  reflection claim columns on `threads`, the librarian cadence
  columns + global claim RPCs + shared in-flight guard, and the
  `nak-rem-sweep` / `nak-deep-sleep-sweep` pg_cron dispatches.
- `supabase/functions/tests/memory_librarian.test.ts`,
  `memory_librarian_behavior.test.ts`,
  `memory_consolidate.test.ts` — Deno suites: toolbox-composition
  and prompt invariants for both passes, behavioral coverage
  (cadence, guard, retry stamping) driven through the runner's
  completion seam, and the consolidate tool's RPC contract.

## Entry points

- **`memory_recall` tool call** — main model invokes it mid-turn;
  the venice function's tool dispatcher (`performToolCall`) runs
  the registered ToolDef in `agents/recall.ts`, which spawns a
  headless read-only tool loop on the fast tier. Returns a
  structured JSON output the tool encodes as the `role='tool'`
  message payload for the next round.
- **Reflection (edge function tail)** — at the end of each
  successfully completed streaming chat turn, `getStreamingResponse`
  fires `reflectOneThread(adminClient, userId)` via
  `EdgeRuntime.waitUntil` as background work after the chat response
  ships. Each invocation opportunistically drains one day-gate-
  eligible thread from the existing reflection queue - NOT
  necessarily the thread that just finished. Claim mutual exclusion
  is the per-thread claim RPC (each call uses a fresh random holder
  id); no `worker_leases` row is involved.
- **Reflection catch-up sweep** — pg_cron job
  `nak-reflection-sweep` (hourly, minute 27) pg_net-POSTs
  `/reflection-sweep` -> `runReflectionSweepTick`, which claims the
  most-overdue eligible thread across ALL users
  (`claim_next_thread_for_reflection_sweep`, SECURITY DEFINER,
  per-owner timezone off the profile) and runs the same shared
  reflect body. Exists because the tail only fires when its owner
  converses - without it a dormant account's queue never moves. The
  per-thread claim makes tail + sweep double-driving safe. The dev
  shim ticks this route too.
- **Reflection attempt cap** — both reflection claims count
  ATTEMPTS at claim time (`threads.reflection_attempt_msg_id` +
  `reflection_attempt_count`): three claims against the same
  terminal message and the thread stops being offered, until a new
  conversation turn changes the terminal message and refreshes the
  budget. Counting attempts rather than failures is load-bearing: a
  run killed by the invocation wall clock never reaches an error
  handler, so a failure counter would miss exactly the deaths that
  need bounding (a measured ~9-minute reflection cannot fit the
  hosted ~400s window; without the cap the hourly sweep would
  re-claim such a thread forever). A successful mark resets the
  count.
- **Librarian cron sweeps** — pg_cron jobs `nak-rem-sweep`
  (hourly, minute 17) and `nak-deep-sleep-sweep` (hourly, minute
  47) read vault secrets and pg_net-POST `/rem-sweep` /
  `/deep-sleep-sweep` with the service-role bearer ->
  `runRemSweepTick` / `runDeepSleepSweepTick`. Each tick claims
  the most-overdue eligible user via the global SECURITY DEFINER
  RPC (`claim_next_user_for_rem` / `claim_next_user_for_deep_sleep`),
  which stamps the per-user 12h cadence column BEFORE the run and
  gates on the `memoryLibrarianEnabled` Settings toggle. In local
  dev, `scripts/dev-backfill-cron.mjs` ticks both routes.
- **Librarian manual runs** — the Memories panel's moon
  (deep-sleep) and shuffle (rem) buttons ->
  `librarianRun.start()` in `memory-librarian-run.svelte.ts` ->
  `SupabaseService.runDeepSleep` / `runRem` -> `POST
  /deep-sleep-run` / `/rem-run` (user JWT) with a client-minted
  runId. **Detached** like the wiki librarian (`docs/dev/wiki.md`):
  the route (`detachedManualRunHandler`) returns `{accepted:true}`
  and runs under `EdgeRuntime.waitUntil`, so a long pass can't draw
  the gateway 504; `librarianRun.start` awaits the outcome through
  `awaitDetachedRun` (subscribe-before-POST on the per-user
  `agent-runs:<userId>` channel, resolve on the terminal `result`
  event). Run liveness for every client is the shared
  `memory_librarian_inflight_expires_at` lease, watched via
  `memoryLibrarianLease` (`agents/inflight-lease.svelte.ts`,
  realtime off the `profiles` row), reflecting scheduled background
  passes too. Following the wiki sparkle pattern: the top-bar
  launchers stay ENABLED (they're navigation - they open the confirm
  strip), and the lease instead disables the confirm strip's **Run**
  submit and renders a "running in the background" spinner when a pass
  is in flight elsewhere. A collision still folds into a `busy`
  result. Manual runs never touch the cadence stamps. Run OUTCOME
  recovers across a reload the same way the wiki librarian's does: the
  detached handler writes a `{ runId, source, finishedAt, result }`
  envelope to `profiles.memory_librarian_last_run_outcome` (one column
  for both passes; `source` names rem vs deep-sleep), and
  `memoryLibrarianOutcome` (`createLastRunOutcomeWatcher`) reads it on
  mount + watches the profiles realtime UPDATE. A `$effect` in
  `Memories.svelte` bridges the watched outcome into
  `librarianRun.applyOutcome`, which re-renders the result strip via
  `outcomeToMemoryDisplay` (guarded by the store's `displayedRunId` so a
  live run isn't clobbered). The outcome column is a sticky last-value
  with no expiry, so the bridge also guards on age: `recoveredOutcomeUpdate`
  skips an outcome that finished longer ago than
  `MAX_RECOVERED_OUTCOME_AGE_MS` (10 min) via `recoveredOutcomeIsFresh`
  (`$lib/ui/manual-run-recovery`, shared w/ the wiki librarian's recovery
  bridge). Without that bound every cold app load would resurface the
  strip from the last run ever - burying the changelog default surface
  behind a stale "Rem finished" card. A fresh realtime outcome (a run
  finishing while the tab is open) has `finishedAt ~= now`, so it always
  passes.
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
    claim for the embeddings backfill
  - `confidence real default 1.0` — starts at 1.0 on create;
    `memory_invalidate` halves it (reflection-only, ×0.5);
    `memory_update` and `memory_reshape` rewrite content only and do
    NOT change confidence (corroboration is its own explicit signal,
    not a side effect of an edit); the `memory_reaffirm` lever calls
    `reaffirm_memory_confidence` (+0.5 cap 10.0) and `memory_doubt`
    calls `doubt_memory_confidence` (×0.7 no floor). The
    `bump_memory_confidence` RPC exists in the schema but is currently
    unreferenced - no tool calls it. Search floors at 0.05 and applies
    a log boost so
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
  `label` or `data` changes. Ensures an in-flight backfill save
  can't land a now-stale embedding.
- **RLS policies** — all four (select / insert / update / delete)
  are `auth.uid() = user_id`. No cross-user read is possible
  via the publishable key.
- **`threads.last_reflected_msg_id`** — progress pointer for
  the reflection queue. A message id (not a timestamp) is the
  pointer because ids are stable across clock skew and
  terminal-assistant-detection is a straightforward query.
- **Reflection claim columns** — `threads.reflection_holder_id`
  and `threads.reflection_claim_expires_at` are the mutual-
  exclusion primitive for the server-side reflection path.
  The claim-RPC pair (`claim_next_thread_for_reflection` /
  `mark_thread_reflected_if_claimed`) uses a fresh random holder
  id per call; there is no `worker_leases` row for reflection.
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
  `profiles.rem_last_run_at`** — per-user cadence gates,
  mirroring `wiki_librarian_last_run_at`. Stamped by the global
  SECURITY DEFINER claims `claim_next_user_for_deep_sleep` /
  `claim_next_user_for_rem` (EXECUTE locked to `service_role`),
  which pick the most-overdue eligible user and stamp inside the
  claiming UPDATE - BEFORE the run, so a crashed run waits out
  the 12h interval instead of retrying hot. Eligibility gates on
  `settings->>'memoryLibrarianEnabled' is distinct from 'false'`,
  the same string-compare-on-purpose shape as the wiki sweeps (a
  boolean cast could wedge the all-users sweep on one malformed
  value).
- **`consolidate_memories(survivor_id, loser_id, label, data)`
  RPC** — the librarian's atomic content-write. Sets survivor
  confidence to `greatest(survivor, loser)` (preserves stronger
  evidence; does NOT bump), halves loser, redirects
  `memory_conversation` rows and `memory_relations` edges, drops
  self-loops and unique-constraint duplicates from the
  redirected edges. Single transaction; no client-side
  coordination needed.
- **Shared in-flight guard** —
  `profiles.memory_librarian_inflight_holder` /
  `memory_librarian_inflight_expires_at`, taken via
  `claim_memory_librarian_inflight` and released via
  `release_memory_librarian_inflight` (atomic holder + 600s TTL,
  same shape as the wiki librarian's). ONE guard covers both
  passes and all four entry paths (two sweeps + two manual
  routes), so a rem run never overlaps a deep-sleep run for the
  same user regardless of how either started. The TTL unwedges a
  guard a crashed run left behind; release is holder-checked.
- **Realtime publication membership** — `memories` is a member of
  the `supabase_realtime` publication. Every agent that writes
  memory rows (reflection, the librarians, the chat tools) runs
  server-side, so an open Memories panel learns about writes
  through the browser's `postgres_changes` subscription rather
  than an in-page event.
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

Every tool `execute` below runs function-side (the venice
function's `performToolCall` registry, or an agent toolbox built
from the same ports); the browser carries only the wire schemas.

- `memory_create.execute({ label, data, message })` — inserts.
  The trigger nulls the embedding; the backfill embeds it on its
  next pass. `message` is required (commit-style) and appends a
  `create` changelog row.
- `memory_update.execute({ id, label?, data?, message })` —
  writes the changed fields and relies on the trigger to null the
  embedding if either text changed. Does NOT change confidence (a
  rewrite is not corroboration). `message` is required and appends an
  `update` changelog row.
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
- `memory_recall` (the registered ToolDef in `agents/recall.ts`)
  — settles on a discriminated union:
  `{kind:'none'} | {kind:'note', note:string}`. The tool parses
  the model's JSON and hands it back to the main chat loop as the
  tool result.
- `runRemSweepTick(adminClient)` /
  `runDeepSleepSweepTick(adminClient)` — non-throwing by
  contract; return per-tick outcome summaries (`no-user` /
  `inflight-blocked` / `empty-queue` or `no-eligible` /
  `too-small` / `reviewed` / `error`) that pg_net ignores and the
  dev shim prints. The cadence stamp lands at claim time, so a
  tick that ends empty or blocked still consumes that user's 12h
  slot.
- `runRemManual(adminClient, userId, onProgress?)` /
  `runDeepSleepManual(adminClient, userId, onProgress?)` —
  non-throwing; return result unions the routes relay
  (`ok` / `empty-queue` or `no-eligible` / `too-small` / `busy` /
  `error`). `busy` is the shared in-flight guard's collision
  surface. The `onProgress` hook feeds the panel's live step
  strip (`preparing` / the runner's `thinking` + `tool` /
  `done`); attaching it also injects the `activity` narration
  parameter into the tools' wire schemas, so the sweep paths
  (no listener) stay narration-free.
- `reflectOneThread(adminClient, userId)` — the edge function
  entry point. Claims one day-gate-eligible thread (newest message
  on a prior calendar day in the user's timezone, with >= 2 user
  messages), runs the reflection agent's headless tool loop, and
  stamps `last_reflected_msg_id` via a claim-guarded RPC. The
  agent's "answer" is whatever `memory_*` tool calls it made;
  the final text is discarded. Returns without error when the
  queue is empty or the claim is lost.

## Interactions with other features

- **Chat** — the main model invokes `memory_recall` as a tool
  mid-turn. The venice function's tool dispatcher runs it, the
  recall agent runs inline on the fast tier, the structured
  output becomes a `role='tool'` message, and the main model
  folds the returned note into its reply. The chat screen also
  owns the `memories` drawer tab, the `MemoryList` / `Memories`
  panel pair that render against the shared `memoriesStore`, and
  the realtime wiring: an effect in Chat.svelte subscribes
  `SupabaseService.subscribeToMemoryChanges(userId,
  emitMemoryChange)` so server-side writes flow into the same
  event bus every memory surface already listens on (coarse
  "something changed", no row deltas - the wiki twin's
  rationale). See `./chat.md`.
- **Settings** — the Memory group's single toggle
  (`memoryLibrarianEnabled`) gates the scheduled librarian
  sweeps. Consumed server-side by both claim predicates, so
  flipping it is just a settings write with no worker to start
  or stop. Manual runs ignore it - the user explicitly asked.
- **Tools** — the chat-facing memory tools ride the browser
  registry (`tools/index.ts`) as schema-only `serverSideTool`
  defs; the implementations live in
  `supabase/functions/venice/tools/`. Reflection uses a
  write-scoped subset (search + create + update + invalidate,
  NOT delete, NOT any recall) defined in its agent module; the
  librarians share `_memory_librarian_tools.ts` (consolidate
  instead of create/update). See `./tools.md`.
- **Embeddings** — the server-side backfill populates
  `memories.embedding` on a poll of `embedding is null`. Memory
  search's vector path reads that column; the ILIKE fallback
  covers the "just written, not yet embedded" window. Deep-sleep
  re-embeds its seed through the same Venice model to query the
  scored neighbor RPC. See `./embeddings.md`.
- **Topics** - the memory-topics curation unit (server-side, in
  the venice function) tags each memory with 1-4 short topic
  strings so the Memories drawer can offer a topic filter. Both
  surfaces (search + filter) share the same
  `searchMemoriesSemantic` pipeline; the filter is an optional
  `selectedTopics` argument that the assistant-facing
  `memory_search` tool doesn't pass (no UI on the LLM side). See
  `./topics.md` under "Memory topics" for the unit shape, the
  schema deltas, and the trigger / claim discipline.
- **Summaries / conversation recall** — separate store (thread
  rows), separate agents. Summary and reflection both run in the
  venice edge function, fired from the completed-chat-turn tail
  with an hourly sweep as catch-up. Both use the same per-row
  claim-RPC pattern on `threads` but have independent claim
  columns and no shared lease.
- **Logging** - the reflection agent and both librarian passes
  emit breadcrumbs through `createEdgeLogger` (sources
  `reflection`, `rem`, `deep-sleep`), which both writes to the
  Supabase function logs AND broadcasts to the user's `logs:<id>`
  channel so the entries land in the in-app Logs drawer alongside
  browser logs (see `./logging.md` "Edge-to-main relay"). The
  manual librarian runs additionally publish live step events
  over the sibling `agent-runs:<userId>` Broadcast topic
  (`_shared/agent-progress.ts`), same transport and
  flush-before-respond contract as the log relay.
- **Edge function auth** (`./edge-function-auth.md`) - the sweep
  routes are gated on `isServiceRole`; the manual routes on the
  gateway-validated user JWT. The cadence claims are SECURITY
  DEFINER global sweeps locked to `service_role`; the in-flight
  guard pair carries the `coalesce(p_user_id, auth.uid())`
  b-strict escape hatch.

## Gotchas

- **DELETE events need the (id, user_id) replica identity.** The
  `subscribeToMemoryChanges` relay filters on `user_id`, but a
  DELETE's WAL record carries only the table's replica identity -
  with the default primary-key identity, realtime can't match the
  filter and silently drops the event, so a chat-driven
  `memory_delete` never refreshes an open Memories panel.
  `memories_replident_idx` in `schema.sql` exists solely to put
  `user_id` into the old tuple; dropping it silently degrades the
  identity to NOTHING and breaks DELETE replication. Full rationale
  on the schema block.
- **Invalidate vs delete is load-bearing.** The reflection
  agent's prompt explicitly tells it "use memory_invalidate,
  not memory_delete" and its toolbox doesn't even
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
  meant to satisfy. The recall agent (`agents/recall.ts`) drops
  any trailing assistant-with-tool_calls row before handing the
  transcript to its model.
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
- **Error-path stamping differs between sweep and manual runs -
  deliberately.** It reads like an inconsistency; it isn't. A
  SWEEP agent error leaves the work unit unstamped (rem's
  `memory_conversation` rows stay unprocessed; deep-sleep's batch
  stays unvisited) so the next scheduled cycle retries it -
  nobody is watching, so silent retry is the right failure mode.
  A MANUAL deep-sleep run stamps the batch visited even when the
  agent errors: the seed picker is deterministic
  (oldest-unvisited first), so without the stamp a poison
  neighborhood - one whose batch reliably kills the agent - would
  wedge the button on the same batch click after click. Stamping
  on error costs one skipped neighborhood per ~12h; wedging the
  button costs the feature. (Manual rem keeps the
  leave-unprocessed shape - its queue is multi-conversation per
  run, so one failing conversation doesn't pin the button.)
- **Cadence stamps land before the run.** The claim RPCs stamp
  `rem_last_run_at` / `deep_sleep_last_run_at` inside the
  claiming UPDATE, so a tick that ends `empty-queue`,
  `too-small`, or `inflight-blocked` still consumes that user's
  12h slot. A crashed run waits out the interval instead of
  retrying hot; the cost is that a blocked tick is that cycle's
  librarian activity. Manual runs never touch the stamps.
- **One in-flight guard, two passes, four paths.** The shared
  guard means a manual deep-sleep click can come back `busy`
  because a scheduled REM sweep happens to be mid-flight - not
  just another deep-sleep. Intentional: both passes reason over
  the same memory rows, and two agents reshaping the same
  neighborhood concurrently would make conflicting decisions.
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
- `./embeddings.md` — the backfill that makes semantic search
  work.
- `./conversation-recall.md` — the sibling recall surface that
  targets thread summaries, not memory rows.
- `./tools.md` — the registry + executor pattern the memory
  tools plug into.
