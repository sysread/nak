# Wiki

Flat encyclopedic articles about the user. A peer to chats and
memories. The user authors articles directly through the Wiki drawer
tab; two distinct background agents keep them healthy:

- The **autonomous wiki agent** runs server-side in the venice edge
  function. An hourly pg_cron sweep claims settled threads (newest
  message at least one full calendar day old in the user's timezone)
  across ALL users and updates / creates articles based on topics
  that came up.
- The **wiki librarian** also runs server-side in the venice edge
  function. It reads the wiki as a whole and consolidates duplicates /
  fact-checks claims against conversation history. It cannot create
  new articles; only update and delete. Three trigger paths share one
  prompt builder and one toolbox: an hourly pg_cron sweep that claims
  the most-overdue eligible user on a 12h cadence, the Wiki panel's
  manual-run (sparkles) button, and the chat-dispatched
  `wiki_librarian` tool. A per-user in-flight guard makes the three
  paths mutually exclusive.

A third flow is **user-triggered, not autonomous**: the per-article
**manual update** ("Ask agent to update") also runs server-side in the
venice edge function, as one non-streaming JSON completion with no tool
loop. No wiki feature code runs in the browser except the Wiki UI
itself - every wiki agent completion is server-side.

Both background agents share the encyclopedic-third-person voice and
the "preserve facts unless explicitly contradicted" discipline.

## Role

Two knowledge surfaces with deliberately different shapes:

- **Memory** (`docs/dev/memory.md`) - atomic labelled facts, surfaced
  inline by the chat-loop's recall pipeline.
- **Wiki** (this doc) - longer-form encyclopedic articles, **never
  auto-injected** into the chat. The main LLM reaches them only
  through the always-on `wiki_search` tool.

Articles are titled, single-level (no nesting), and unique per
`(user_id, title)`. The voice is encyclopedic third-person prose -
intentionally different from chat-style or first-person registers.

## Files

Schema (`supabase/schema.sql`):

- The "User Wiki" block defines `wiki_articles`, the
  `clear_wiki_embedding_on_change` trigger, RLS policies, and the
  `threads` extension columns (`last_wiki_processed_msg_id`,
  `wiki_claim_holder`, `wiki_claim_expires_at`, `wiki_failure_count`,
  `wiki_last_skip_at`, `wiki_last_skip_reason`,
  `wiki_skip_fallback_attempted`).
- Agent RPCs: `claim_next_thread_for_wiki` (a **global SECURITY
  DEFINER sweep** - no `auth.uid()`; EXECUTE locked to
  `service_role`; reads each user's timezone and "automatic wiki
  updates" toggle off the joined profile and returns `user_id` with
  the claim), `mark_thread_wiki_processed_if_claimed`,
  `record_wiki_failure_or_skip`, `compute_wiki_terminal_msg_id`,
  `manual_advance_wiki_pointer`, and `list_wiki_skipped_threads`.
  The mark / failure / compute / advance RPCs carry a `p_user_id`
  b-strict escape hatch (`coalesce(p_user_id, auth.uid())`, see
  `docs/dev/edge-function-auth.md`) so the service-role caller can
  scope to the thread owner while a browser caller passes null.
- `nak_safe_timezone(text)` - probes a stored timezone preference and
  falls back to UTC on anything Postgres rejects. The global sweep
  evaluates the day-gate for every user inside one query; without the
  guard, a single malformed `displayTimezone` would make
  `at time zone` raise and wedge the sweep for all users.
- Cron dispatch: `nak_trigger_wiki_sweep()` reads `project_url` /
  `service_role_key` from vault and POSTs `/wiki-sweep` via pg_net;
  the `nak-wiki-sweep` pg_cron job fires it hourly at minute 7
  (offset from the embed backfill's `*/5` grid so the two pg_net
  dispatches don't stack on the same tick). Clone of the
  embed-backfill dispatch pattern.
- Realtime: `wiki_articles` is a member of the `supabase_realtime`
  publication so the browser's refresh subscription (below) sees
  server-side writes.
- For the librarian: the cadence column
  `profiles.wiki_librarian_last_run_at` plus the in-flight guard
  columns (`wiki_librarian_inflight_holder`,
  `wiki_librarian_inflight_expires_at`).
  `claim_next_user_for_wiki_librarian(int)` is a global SECURITY
  DEFINER claim (EXECUTE locked to `service_role`) that stamps the
  cadence column for the most-overdue eligible user inside the
  claiming UPDATE - stamp-before-run, so a crashed run waits out the
  12h interval. Eligibility gates on
  `settings->>'wikiLibrarianEnabled' is distinct from 'false'`, the
  same string-compare-on-purpose shape as the wiki sweep's toggle.
  The guard pair `claim_wiki_librarian_inflight` /
  `release_wiki_librarian_inflight` (atomic holder + TTL on profiles;
  b-strict `coalesce(p_user_id, auth.uid())`) is what makes the three
  trigger paths mutually exclusive. Cron dispatch:
  `nak_trigger_wiki_librarian_sweep()` POSTs `/wiki-librarian-sweep`
  via pg_net; the `nak-wiki-librarian-sweep` job fires it hourly at
  minute 37 (offset from the wiki sweep's minute 7 and the backfill's
  `*/5` grid so the heavy dispatches never share a tick).
- Realtime authorization for live librarian runs: the "agent-run
  channel: owner subscribe" policy on `realtime.messages` admits the
  signed-in user to their private `agent-runs:<userId>` Broadcast
  topic. Per-USER topic, not per-run - one literal-equality policy
  covers every run; payloads carry the runId for client-side demux.
- For the changelog: a `wiki_changelog` table (one row per
  create/update/delete; `article_id` is `on delete set null` so a
  deleted article doesn't take its history with it; `title_at_change`
  snapshot keeps the row readable when `article_id` is nulled;
  `message` has a column-level `char_length` between 1 and 200 CHECK
  that mirrors `MAX_WIKI_CHANGELOG_MESSAGE_CHARS`; `chars_before` /
  `chars_after` record the content length either side of the change,
  powering the size-delta chip in the changelog panel - for article
  kinds the size measures `wiki_articles.content`, for record kinds it
  measures `wiki_records.content`; NULL means unknown (pre-column rows
  or file/link record writes that have no content delta), 0 means
  known-empty) plus append-only
  RLS (select + insert only, no update/delete) and a
  `(user_id, created_at desc)` index for the panel's cursor-paged
  listing. `reset_wiki_data` clears `wiki_changelog` alongside
  `wiki_articles` so a wipe leaves no orphan history. The `kind` CHECK
  is a NAMED constraint (`wiki_changelog_kind_check`) covering both the
  article kinds (`create`/`update`/`delete`) and the record kinds
  (`record_create`/`record_update`/`record_delete`); RECORD writes
  reuse this same changelog, scoped to the parent `article_id`. A
  guarded `do $$` block widens the constraint on databases created
  before the record kinds existed (drop-by-introspection, then add the
  named constraint - idempotent).
- For the audit trail: a `wiki_agent_log` table (one row per COMPLETED
  agent cycle across all three agents - article sweep/retry, record
  extraction, librarian - including no-op cycles; columns `agent`,
  `trigger_source`, set-null `thread_id`/`terminal_msg_id` FKs,
  `tool_calls`, `reasoning`). Select-only RLS; rows land exclusively
  through the service-role edge agents. `reset_wiki_data` clears it
  alongside the changelog. The `reasoning` column is the durable copy
  of the operator summary the log drawer shows live - without it,
  "when was this thread processed" and "why did the agent write
  nothing" stop being answerable once the 24h edge logs roll over.
- Embeddings RPCs: `claim_next_pending_wiki_article`,
  `save_wiki_article_embedding_if_claimed`,
  `search_wiki_articles_by_embedding`.

Edge function (`supabase/functions/venice/`):

- `agents/wiki.ts` - the autonomous agent. Exports
  `runWikiSweepTick` (cron path) and `retryWikiThread` (user path).
  Owns the autonomous prompt (`buildWikiAutonomousPrompt`; the
  "About the user" profile block comes from the shared
  `agents/_wiki_profile.ts`), the wiki
  tool wire schemas, `buildWikiToolbox`, the content-filter sentinel
  and fallback constants, and the per-run tunables: model
  `deepseek-v4-flash` (hardcoded mirror of `agentModel('wiki')` -
  `AGENT_MODELS` is a static role->model map, not a per-user tier),
  fallback `venice-uncensored-1-2`, `reasoningEffort:
  'medium'`, output cap 8192 tokens/round, claim TTL 600s, failure
  cap 3, sweep bound 3 threads/tick. Test-only invariants exported
  via `__test`.
- `agents/_accumulator.ts` - distill-then-act support for oversized
  transcripts (port of fnord's accumulator pattern): the pinned
  `WORKING_CONTEXT_TOKENS` budget, `transcriptFitsDirect`,
  `distillTranscript` (chunked notes accumulation w/ context-length
  backoff), `isContextLengthError`, and
  `renderDistilledNotesBlock`. Shared by `wiki.ts` and
  `wiki_records.ts`; see "Context-window handling" under the sweep
  section for the full flow. Unit-tested at
  `supabase/functions/tests/accumulator.test.ts`.
- `agents/wiki_manual.ts` - the per-article manual agent (the "Ask
  agent to update" flow). Exports `runWikiManualUpdate(adminClient,
  userId, { articleId, instructions })`: reads the persisted article
  and its records server-side (b-strict, explicit `user_id` filter),
  builds the manual prompt (`buildWikiManualPrompt`, shares the
  profile block via `_wiki_profile.ts`), runs ONE non-streaming JSON
  completion via `completeJsonObject` (no tool loop) pinned to
  `reasoningEffort: 'low'`, parses + validates the model's
  `RecordOp`s (hallucinated-id rejection against the records it
  actually showed), and returns the `WikiManualUpdateResult` union
  (`preview` / `noop` / `error`). Non-throwing by contract; writes
  nothing (the browser persists on Accept). Model mirror
  `WIKI_MANUAL_MODEL` (`deepseek-v4-flash`). Test-only invariants
  (the parser + prompt) exported via `__test`. Logger source
  `wiki-manual`.
- `agents/_wiki_profile.ts` - the shared "About the user" block:
  `WikiUserProfile`, `renderUserProfileBlock` (the
  anti-name-fabrication rules), and `loadWikiProfile` (reads
  `profiles.settings.userName` / `userLocation`). Imported by both
  the autonomous (`wiki.ts`) and manual (`wiki_manual.ts`) agents so
  the two render an identical block. The librarian
  (`wiki_librarian.ts`) keeps its OWN renderer - a CORRECTIVE
  variant, not a copy to fold in here.
- `agents/_wiki_agent_log.ts` - `appendWikiAgentLog`, the best-effort
  insert into `wiki_agent_log`. Non-throwing by contract (a cycle
  that did its real work must not fail because the audit insert
  did); called from the article agent's sweep + retry success paths,
  the extraction agent's sweep success path, and all three librarian
  entry points.
- `agents/_agent_tools.ts` - shared agent-toolbox plumbing:
  `asAgentTool` (wraps a registered `ToolDef` with a pinned wire
  schema so agent writes stay byte-identical to the chat-side
  tools), `loadThreadSliceUpTo` (history slice at the claimed
  terminal message), and `MEMORY_SEARCH_WIRE_SCHEMA`. Shared with
  the reflection agent and the librarian.
- `agents/_run.ts` - `runHeadlessAgent`, the headless tool loop every
  server-side agent (reflection, wiki, librarian) drives. Two seams:
  the injectable completion call (`RunHeadlessAgentOptions.complete`;
  defaults to `toolComplete`, the live Venice call) is how the Deno
  suites script model rounds without a network, and the optional
  `onProgress` hook emits `thinking` / `tool` step events. Attaching
  `onProgress` also injects a required `activity` narration
  parameter into every tool's wire schema; without a listener the
  wire bytes carry no narration (reflection and both wiki sweeps
  stay narration-free). A third seam, `now`, backs the optional
  `budgetMs` wall-clock bound - opt-in per agent, currently only
  deep-sleep. See `./tools.md` for why rounds alone are the wrong
  bound; the wiki librarian has not needed one.
- `tools/wiki_create.ts`, `tools/wiki_update.ts`,
  `tools/wiki_delete.ts` - the write tools (char caps, best-effort
  changelog + source attribution, unique-violation rephrasing).
  b-strict throughout: the service-role client bypasses RLS, so every
  query stamps or filters `user_id` explicitly.
- `tools/_wiki_helpers.ts` - shared write-path helpers:
  `appendWikiChangelog`, `attachWikiArticleSources`,
  `findExistingThreadIds` (validates model-supplied
  `source_thread_ids` against the user's own threads - the explicit
  `user_id` filter is what RLS would otherwise provide).
- `tools/wiki_search.ts`, `tools/wiki_get.ts`, `tools/wiki_list.ts` -
  the chat-facing read surfaces.
- `agents/wiki_librarian.ts` - the librarian, all three trigger
  paths: `runWikiLibrarianSweepTick` (scheduled; claims one user per
  tick via `claim_next_user_for_wiki_librarian` and skips post-claim
  when the wiki is under `LIBRARIAN_MIN_ARTICLES = 3`),
  `runWikiLibrarianManual` (the Wiki panel's sparkles button; never
  touches the cadence stamp), and the registered `wiki_librarian`
  ToolDef (the chat model's only path to wiki writes; always the
  custom-instructions prompt variant). One prompt builder
  (`buildWikiLibrarianPrompt` - standard five-step sweep body or the
  bounded custom-instructions variant, parameterised on the invoking
  surface) and one toolbox (`buildLibrarianToolbox`) built from the
  REGISTERED tool ports via `asAgentTool` /
  `asAgentToolNoThread`. Per-run knobs: model
  `deepseek-v4-flash` (mirror of `agentModel('wikiLibrarian')`),
  400-char article excerpts, 500-article fetch cap, 12h cadence,
  600s in-flight TTL. Test-only invariants exported via `__test`.
- `supabase/functions/_shared/agent-progress.ts` -
  `createAgentProgressPublisher`, the run-scoped publisher behind
  the manual route's live step events. Publishes each event to the
  private `agent-runs:<userId>` Broadcast topic with the runId folded
  into the payload; same fire-and-forget transport and
  flush-before-respond contract as `edge-log.ts`.
- `index.ts` - routes: `POST /wiki-sweep` and
  `POST /wiki-librarian-sweep` (both gated by `isServiceRole`);
  `POST /wiki-retry`, `POST /wiki-manual-update`, and
  `POST /wiki-librarian-run` (user JWT; the gateway-validated id
  scopes every RPC). The librarian-run route
  takes `{ instructions, runId }`, builds the progress publisher
  when a runId is present (capped at 64 chars - an opaque demux key,
  not identity), and awaits `publisher.flush()` before responding so
  the `done` event can't be dropped behind the response body. The
  manual-update route (`handleWikiManualUpdate`) takes
  `{ articleId, instructions }` and is synchronous - one JSON
  completion, no runId / progress channel - returning the
  `WikiManualUpdateResult` union in the response body, the same shape
  as `/wiki-retry`.
- `supabase/functions/_shared/embed-input.ts` - the `wiki` entry in
  `EMBED_SOURCES` builds the embed input for the server-side
  backfill.

Dev shim:

- `scripts/dev-backfill-cron.mjs` - the local stack has no pg_cron /
  pg_net, so this shim ticks `POST /wiki-sweep` and
  `POST /wiki-librarian-sweep` alongside `POST /backfill` and prints
  each tick's `WikiSweepSummary` / librarian sweep outcome.

Browser data layer:

- `src/lib/supabase.ts` - `WikiArticle` interface,
  `coerceWikiArticle`, plus the `SupabaseService` methods:
  `listWikiArticles`, `listWikiArticlesPage`, `getWikiArticleById`,
  `getWikiArticleByTitle`, `createWikiArticle`, `updateWikiArticle`,
  `deleteWikiArticle`, `searchWikiArticles`,
  `listWikiSkippedThreads`, `retryWikiThread` (a thin authenticated
  POST to `/wiki-retry`; boundary-validates the result union),
  `runWikiManualUpdate` (a thin authenticated POST to
  `/wiki-manual-update`; boundary-validates the
  `WikiManualUpdateResult` preview / noop union and converts the
  function's `kind:'error'` into a thrown Error so the panel shows a
  retry banner), `subscribeToWikiArticleChanges` (user-scoped `postgres_changes`
  subscription on `wiki_articles`; coarse "something changed"
  notification, no per-event payloads), `runWikiLibrarian` (a thin
  authenticated POST to `/wiki-librarian-run`; boundary-validates the
  `WikiLibrarianRunResult` union - `ok` / `busy` / `error`),
  `subscribeToAgentRunProgress` (private `agent-runs:<userId>`
  Broadcast subscription delivering `AgentRunProgressEvent`s; callers
  filter on runId), and the changelog pair `createWikiChangelogEntry`
  / `listWikiChangelog`. The `UserSettings` interface carries
  `wikiAutomaticEnabled?: boolean` and
  `wikiLibrarianEnabled?: boolean`.
- `src/lib/wiki.ts` - the search helper
  (`searchWikiArticlesSemantic`) plus the `MAX_WIKI_TITLE_CHARS`
  (200), `MAX_WIKI_CONTENT_CHARS` (16000), and
  `MAX_WIKI_CHANGELOG_MESSAGE_CHARS` (200) ceilings. The function-
  side tools mirror these constants so the wire schemas the agent's
  model sees match what the tool impls enforce.
- `src/lib/wiki-store.svelte.ts` - the shared `wikiStore`
  (`results`, `loading`, `loaded`, `error`, `query`, `offset`,
  `hasMore`, `loadingMore`), `runWikiSearch`, `loadWikiFirstPage`,
  `loadMoreWiki`, and the `patchWikiRow` / `removeWikiRow` /
  `addWikiRow` mutators the panel and tools call. `runWikiSearch`
  dispatches on the query: empty routes to the paginated
  alphabetical browse list (`loadWikiFirstPage`, served by
  `listWikiArticlesPage`), non-empty runs the capped semantic
  search and forces `hasMore` false. `loadMoreWiki` appends the
  next offset page.
- `src/lib/wiki-events.ts` - the `WIKI_CHANGE_EVENT` window-event
  bus parallel to `journal-events.ts` / `cookbook-events.ts`. Fired
  by user edits via Wiki.svelte, by the manual librarian strip on a
  successful run, and by the realtime subscription relaying a
  server-side agent write.

Browser tools:

- `src/lib/tools/wiki_search.schema.ts`, `wiki_list.schema.ts`,
  `wiki_get.schema.ts`, `wiki_recall.schema.ts` - server-side read
  tools, schema-only on the browser side (`wiki_search` rides in
  `src/lib/tools/index.ts`'s `alwaysOnToolbox` via `serverSideTool`).
  There are no browser wiki tool implementations - every wiki tool
  executes in the venice function. The browser
  `conversation_search` / `memory_search` impls that remain in
  `src/lib/tools/` belong to the memory-librarian fleet
  (deep-sleep / rem), not to any wiki feature.
- `src/lib/tools/wiki_create.schema.ts`, `wiki_update.schema.ts`,
  `wiki_delete.schema.ts` - the direct article-write schemas the chat
  model sees, schema-only like the reads (the impls + registration
  live in the venice function). Kept aligned with the agent-side wire
  schemas in `agents/wiki.ts`; the chat schemas omit the
  librarian-only `source_thread_ids` (the chat turn's current thread
  auto-attaches as the source).
- `src/lib/tools/wiki_librarian.schema.ts` + the `wikiToolbox`
  entry in `src/lib/tools/index.ts` - the main-chat wiki write
  surface: the article CRUD above, this librarian delegation, and the
  record writes all gate behind the one `wiki` toolbox (see "Tool
  toolbox split" below).

Browser preview UI (no browser agent code):

- There is no `src/lib/agents/wiki/` directory anymore - the manual
  flow moved into `supabase/functions/venice/agents/wiki_manual.ts`
  (see Edge function above). The browser's only manual-flow code is
  the thin POST (`SupabaseService.runWikiManualUpdate`) and the
  preview-display primitives below; the `RecordOp` /
  `WikiManualUpdateResult` types live in
  `src/lib/supabase/types/wiki.ts`.
- `src/lib/ui/wiki-manual.ts` - pure preview primitives:
  `describeRecordOps` projects the proposed `RecordOp`s into display
  rows (resolving update/delete against the records the panel loaded
  for display), `recordOpsHeadline` pluralizes the count. Unit-tested
  in `tests/wiki-manual.test.ts`. The agent's JSON parser +
  record-op validation now live edge-side with the agent (covered by
  `supabase/functions/tests/wiki_manual.test.ts`); this module is the
  framework-free rendering layer only.

Model registry:

- `src/lib/models/index.ts` - `AgentRole` includes `'wiki'` and
  `'wikiLibrarian'`; `AGENT_MODELS.wiki` and
  `AGENT_MODELS.wikiLibrarian` both pinned to `deepseek-v4-flash`
  (rationale documented inline above the table). This registry is now
  the canonical source the edge mirror constants document; no browser
  code resolves `agentModel('wiki')` at runtime any more (the manual
  flow that used to is server-side). The edge agents hardcode the
  mirror constants `WIKI_MODEL` (agents/wiki.ts), `WIKI_MANUAL_MODEL`
  (agents/wiki_manual.ts), and `WIKI_LIBRARIAN_MODEL`
  (agents/wiki_librarian.ts) - keep them in sync with the registry.

Main-thread plumbing:

- `src/lib/state.svelte.ts` - no wiki workers or managers at all;
  every wiki agent (autonomous, librarian, and the per-article
  manual update) runs server-side. `app.wikiAutomaticEnabled` and
  `app.wikiLibrarianEnabled` are plain persisted settings - the live
  switches are `profiles.settings.wikiAutomaticEnabled` (read by the
  wiki sweep's claim predicate) and
  `profiles.settings.wikiLibrarianEnabled` (read by the librarian
  sweep's claim), so flipping a Settings toggle is just a settings
  write with no worker to start or stop. There is no
  worker-push plumbing for profile fields either - every prompt that
  renders an "About the user" block reads `profiles.settings`
  server-side per run. `setDisplayTimezone` persists only - the
  day-gated server agents (reflection, wiki) read
  `profiles.settings.displayTimezone` server-side.
- `src/lib/routing.svelte.ts` - extends `DrawerTab` with `'wiki'`
  and `Route` with `wiki_article_id`.
- `src/lib/chat/system-prompt.ts` - `WIKI_BLOCK` after `JOURNAL_BLOCK` in
  the section list.

UI:

- `src/components/WikiList.svelte` - drawer listing. Search input +
  an infinite-scroll sentinel (`use:infiniteScroll`) that pages the
  browse list, shown only when `wikiStore.hasMore` (forced false
  during a search). Rows are rendered in server order verbatim -
  title ASC for browse, relevance for search - with no client
  re-sort, which would disagree with the server's page boundaries
  mid-scroll. Composition-only: the scanner-label and empty-message
  strings and the `SEARCH_DEBOUNCE_MS` tunable live in the
  primitives module next door.
- `src/lib/ui/wiki-list.ts` - pure UI-behavior primitives for the
  sidebar listing. `scannerLabel(query)` picks between "Searching
  wiki" and "Loading wiki" for the in-flight scanner;
  `emptyMessage(query)` picks between "No matches." and the
  cold-account explainer. No sort primitive: the listing is rendered
  in server order. Unit-tested at `tests/wiki-list.test.ts`.
- `src/screens/Wiki.svelte` - main-panel article view, edit form,
  create form, delete confirmation, and the "ask agent to update"
  preview/accept/cancel flow. Each direct-edit flow carries a
  required one-line change-message input that lands in the wiki
  changelog after the mutation. The "ask agent to update" preview
  surfaces the agent's `reason` field as the changelog entry it
  would write (only when the body actually changes - a records-only
  edit writes no body changelog row); Accept passes it through. The
  same preview lists the agent's proposed record operations
  (Add/Edit/Delete rows from `describeRecordOps`), and Accept applies
  them via `createWikiRecord`/`updateWikiRecord`/`deleteWikiRecord`
  after the body write, firing `emitWikiRecordChange` so the
  `WikiRecords` section refreshes. A preview can carry record ops with
  no body change at all. When no article is selected
  (and the user isn't composing), the panel renders
  `WikiChangelogPanel` as its default view - the changelog is the
  wiki tab's "home page", not a modal off to one side. The compose
  form's "+ new article" affordance lives in the changelog panel
  header (handed to it via the `onAddArticle` prop that flips
  Wiki.svelte's local `composing` state to true).
  **Page model.** The `.wiki-body` template is one if/:else-if
  ladder over five mutually-exclusive surfaces: librarian, compose,
  changelog, "not in current results" hint, article view.
  Page-switch entry points (top-bar sparkles, top-bar clock, sidebar
  row, "+ new article", changelog row) all converge on a single
  invariant - whichever surface the route + local flags resolve to
  is the only one rendered. Two $bindable triggers carry top-bar
  intent into the panel: `triggerLibrarianRun` opens the librarian,
  `triggerChangelogView` closes it and clears `wiki_article_id`. A
  route-watch effect closes the librarian whenever `wiki_article_id`
  becomes non-null so sidebar / changelog-row clicks don't get
  hidden behind an open librarian. `composing` is deliberately
  preserved across page switches - the user's typed draft is theirs
  to abandon via the form's own Cancel button, not for a tab switch
  to destroy. The librarian itself has no Cancel button (the way out
  is to navigate elsewhere); the done-state "Close" survives because
  dismissing the run result is a different operation from navigating
  away.
  **Librarian strip (detached run).** A librarian pass can run minutes
  (conversation reads over a multi-round loop), past the gateway's
  ~2.5min response window, so the manual run is **detached**: the
  route is `detachedManualRunHandler` (venice `index.ts`), which kicks
  the run under `EdgeRuntime.waitUntil` and responds `{accepted:true}`
  immediately - the run finishes under the ~7min wall-clock even though
  the request returned. The outcome the HTTP body used to carry now
  rides the `agent-runs` channel as a terminal **`result` event**. The
  client wraps this in `awaitDetachedRun` (`src/lib/agents/detached-run.ts`):
  subscribe-before-kick (runId-filtered), stream progress into the step
  list (`appendProgressStep`), resolve on the `result` event, reject on
  an inactivity backstop (180s of channel silence). The step transforms
  and `finalizeLibrarianSteps` are pure functions in
  `src/lib/ui/wiki-librarian-run.ts`, unit-tested at
  `tests/wiki-librarian-run.test.ts`; `awaitDetachedRun` at
  `tests/detached-run.test.ts`. `submitLibrarianRun` maps the result
  union (busy / ok / error), finalizes the steps, fires `emitWikiChange`,
  and on error/timeout appends `LIBRARIAN_PARTIAL_SAVE_NOTE` (the write
  tools commit each edit immediately, so a run that died mid-loop may
  have already landed edits - the refresh surfaces them).
  **Run liveness = the in-flight lease, for every client.** The robust
  signal is not a broadcast event but the `profiles` in-flight lease
  (`wiki_librarian_inflight_expires_at`, held = future expiry), watched
  via `wikiLibrarianLease` (`src/lib/agents/inflight-lease.svelte.ts`) -
  a realtime subscription on the `profiles` row plus an initial read and
  a TTL timer. Started in `Chat.svelte` with the session; read by the
  top-bar sparkle button (disabled while held) and the panel ("a run is
  in progress" low-fidelity spinner when a run THIS strip didn't start
  is active - an `<AsciiSpinner>`, the same cue the step list's
  in-flight row and its trailing "Working" tail row carry; see
  `docs/dev/components.md`. The wiki strip keeps the bar deliberately:
  the memory strip swapped to `<SleepSpinner>` because its passes are
  named after sleep stages, and wiki articles have no such conceit. The tail row shows whenever the run is
  live and the bottom row has already settled - `showsRunTail` in
  `src/lib/ui/librarian-run-tail.ts`, shared with the memory strip -
  so the list never goes still while more steps are coming).
  Because manual AND scheduled runs claim the same lease,
  the UI lights up for background sweeps too, and the lease clearing is
  the backstop that settles every client even if the `result` broadcast
  is dropped. Reusable across fleets via the generic
  `createInflightLeaseWatcher(column)` + the `getInflightLeaseExpiry` /
  `subscribeToInflightLease` data methods; the memory librarians flip to
  the detached route + a lease watcher the same way once confirmed.
  **Run outcome = the persisted last-run envelope, for reload recovery.**
  The lease recovers "is a run happening"; its twin recovers "what the
  last run did", so a reloaded tab can re-render the result card the
  fire-and-forget `result` broadcast already delivered and lost. When a
  detached run finishes, `detachedManualRunHandler` writes a
  `{ runId, source, finishedAt, result }` envelope to
  `profiles.wiki_librarian_last_run_outcome` (the venice function's
  `_shared/manual-run-outcome.ts`; a `busy` result is skipped - no run
  happened). The browser recovers it via `wikiLibrarianOutcome`
  (`createLastRunOutcomeWatcher`, the lease watcher's twin: initial read
  on mount + a `subscribeToLastRunOutcome` subscription on the SAME
  profiles realtime UPDATE, so a run that finishes while the tab watches
  arrives in the new tuple race-free). A `$effect` in `Wiki.svelte`
  bridges the watched outcome into `librarianResult` through the
  `outcomeToLibrarianResult` transform. A `librarianShownRunId` guard
  keeps a live run in this tab at full step fidelity and stops the same
  runId being re-applied on every profiles tick. The bridge also drops a
  stale outcome via `recoveredOutcomeIsFresh`
  (`$lib/ui/manual-run-recovery`, shared w/ the memory librarian): the
  `*_last_run_outcome` column never expires, so without the recency bound
  the sticky last result would re-enter the strip state on every cold
  load. A fresh realtime outcome (a run finishing while the tab watches)
  has `finishedAt ~= now`, so it still recovers. The recovered strip
  carries no step rows (they are gone after a reload) - just the result
  card.
  Renders a nested **table of contents** at the top of the article
  (between the title header and the body) for articles with two or
  more Markdown headings. ToC entries link to `#slug` anchors; a
  post-render effect walks `.wiki-content h1..h6` and assigns
  matching ids using `uniqueSlug` from `$lib/markdown` so the
  anchors resolve. Clicks on `#anchor` hrefs are intercepted by
  `onArticleClick` and smooth-scroll the heading into view within
  the `.wiki-body` scroll container instead of letting the browser
  append the fragment to the page URL. Heading extraction shares the
  slug helpers with `Help.svelte` (see the Heading slugger section
  of `$lib/markdown`). Below the heading outline the ToC also lists
  links to the article's appended sections that are present - Sources,
  See also, Records - assembled by buildSectionTocLinks in
  `$lib/ui/wiki-toc-sections.ts`, which also owns the prefixed anchor
  ids (wiki-sources / wiki-see-also / wiki-records, prefixed so they
  can't collide with a bare heading slug). These section links relax
  the two-heading visibility gate, so a short article with records
  still gets navigation. Because the Records section renders outside
  the article element, onArticleClick falls back to
  document.getElementById when the in-article lookup misses. The
  record count that gates the Records link is reported up from the
  WikiRecords component via its onCount prop on each unfiltered load.
- `src/lib/ui/wiki-screen.ts` - the screen-scoped UI primitives for
  Wiki.svelte (named `-screen` because `src/lib/wiki.ts` is the domain
  module): selected-article resolution against the loaded lists /
  Favorites bucket / read-through fallback, the edit-compose-delete
  form validation + error copy (including the duplicate-title
  rephrase), the edit form's save-state footer, the favorite and
  offline-disabled button copy, the untitled-source label, and the
  `?key=val` article-link -> route-patch mapping. Feature-specific
  decisions route to the narrower companions instead: heading-outline
  nesting and the ToC visibility gates live in `wiki-toc-sections.ts`,
  the preview-diff / instructions validation / abort sniff in
  `wiki-manual.ts`, and the step glyphs, result meta line, busy copy,
  lease predicate, and reload-recovery guard in
  `wiki-librarian-run.ts`. Unit-tested at `tests/wiki-screen.test.ts`.
- `src/components/WikiChangelogPanel.svelte` - the inline changelog.
  Cursor-paged list (`listWikiChangelog`); kind chips
  (Added/Edited/Deleted), per-entry article link when the article
  still exists, plain title snapshot for deletes. Mounted by
  Wiki.svelte's no-article empty state. Listens on `onWikiChange` so
  a write that happens while the panel is visible refreshes the
  first page - including server-side agent writes arriving via the
  realtime subscription. Optional `onAddArticle` prop renders a
  "+ new article" button in the header. Composition-only: every
  decision (kind-label mapping, compact timestamp formatter with ISO
  fallback, the "can-link-this-row" gate, the exhausted-page check)
  lives in `src/lib/ui/wiki-changelog-panel.ts` and is unit-tested
  at `tests/wiki-changelog-panel.test.ts`.
- `src/components/WikiSkippedPanel.svelte` - the inline panel
  mounted by Wiki.svelte when `skippedViewOpen` is set. Lists
  threads whose `wiki_last_skip_at` is non-null (the agent gave up
  after the per-thread failure cap) with the trimmed Venice error
  reason; clicking a row navigates to the conversation. The per-row
  Retry button calls `SupabaseService.retryWikiThread` - the whole
  retry cycle runs server-side - and shows the resulting tool-call
  count + reasoning inline before the user dismisses the row.
  Subscribes to `onWikiChange` so a successful run draining a skip
  marker is reflected without reopening the panel. Composition-only:
  the timestamp formatter, the "[untitled conversation]" title
  fallback, and the retry-success headline picker (the "0 / 1 / N
  edits landed" copy that calls out a no-edit retry distinctly) all
  live in `src/lib/ui/wiki-skipped-panel.ts` and are unit-tested at
  `tests/wiki-skipped-panel.test.ts`.
- `src/screens/Chat.svelte` - tab, drawer branch, main-panel branch,
  top-bar branch, change-event listener, and the wiki realtime
  wiring: an effect subscribes
  `SupabaseService.subscribeToWikiArticleChanges(userId,
  emitWikiChange)` so server-side writes flow into the same event
  bus every wiki surface already listens on. Top-bar branch carries
  the `librarian-run-btn` (sparkles) next to the
  `wiki-changelog-btn` (clock). Both buttons drive `$bindable` flags
  (`wikiLibrarianTrigger`, `wikiChangelogTrigger`) on `<WikiComp>`
  rather than navigating directly - the librarian's open/closed
  state is a local flag in `Wiki.svelte`, and a clock-button click
  while the librarian is open has to touch both the route AND that
  flag. Wiki.svelte resets each flag after consuming it. The
  librarian sparkle button stays ENABLED while a run is in flight - it
  navigates to the librarian page, so disabling it would lock the user
  out of the page that shows the in-flight state. The in-flight signal
  (`wikiLibrarianLease`, realtime off the `profiles` row, covering
  scheduled and chat-dispatched runs too) instead disables the Run
  button ON the page and renders a "running in the background" spinner.
  The server-side in-flight guard's `busy` result remains the
  authoritative collision surface for the gap before the lease
  propagates.
- `src/screens/Settings.svelte` - the "Wiki" group with the
  `wikiAutomaticEnabled` and `wikiLibrarianEnabled` toggles.

Tests:

- `supabase/functions/tests/wiki.test.ts` - the safety-critical
  composition guards: toolbox membership (wiki CRUD + full record
  management `record_list`/`create`/`update`/`delete` + read-only
  memory_search, no memory writes, no ask_user), the content-filter
  sentinel match staying narrow, and the prompt invariants
  (anti-name-fabrication, profile-block rendering rules).
- `supabase/functions/tests/wiki_librarian.test.ts` - the
  librarian's composition guards: toolbox membership (the four
  reads plus wiki_update / wiki_delete; no `wiki_create`, no memory
  writes, no `ask_user`), the prompt's variant selection (custom
  instructions swap in the bounded body; whitespace falls back to
  the standard five-step sweep), and the corrective profile-block
  rules.
- `supabase/functions/tests/wiki_behavior.test.ts` - behavioral
  coverage for the wiki agent's retry path, driven through the
  runner's completion seam: primary-then-fallback ordering, the
  "only the classifier sentinel triggers the fallback" branch, and
  the pointer / skip-marker semantics around it.
- `supabase/functions/tests/agent_run.test.ts` - the runner itself:
  the completion seam scripting model rounds, the progress hook's
  event stream, and the `activity` param injection staying
  conditional on an attached listener.
- `supabase/functions/tests/wiki_manual.test.ts` - the manual
  agent's parser/validator (hallucinated-id rejection, the
  records-only-noop detection, per-op normalisation) and prompt
  invariants (the anti-name-fabrication block, the do-not-discard-
  facts rule). Deno; runs against `agents/wiki_manual.ts`'s `__test`.
- `tests/wiki-manual.test.ts` - the browser preview-display
  primitives only (`describeRecordOps` / `recordOpsHeadline`). The
  parser coverage moved to the Deno suite above with the agent.

Docs:

- `docs/user/wiki.md` (this feature's user-facing manual).
- `docs/dev/wiki.md` (this file).

## Entry points

- **Cron sweep**: pg_cron job `nak-wiki-sweep` (hourly, minute 7) ->
  `nak_trigger_wiki_sweep()` -> pg_net `POST /wiki-sweep` with the
  service-role bearer -> `runWikiSweepTick(adminClient)`. Each tick
  claims up to 3 eligible threads across all users and runs the
  agent's tool loop on each; the hourly schedule resumes a long
  drain. In local dev, `scripts/dev-backfill-cron.mjs` plays the
  cron role.
- **Manual retry**: the Skipped panel's Retry button ->
  `SupabaseService.retryWikiThread(threadId)` -> `POST /wiki-retry`
  (user JWT) -> `retryWikiThread(adminClient, userId, threadId)`.
- **Record extraction sweep**: pg_cron job `nak-wiki-records-sweep`
  (hourly, minute 17, offset from the wiki sweep at 7 and the
  librarian at 37) -> `nak_trigger_wiki_records_sweep()` -> pg_net
  `POST /wiki-records-sweep` -> `runWikiRecordsSweepTick(adminClient)`
  in `agents/wiki_records.ts`. Claims settled threads whose owner has
  `wikiRecordExtractionEnabled` and at least one article, and logs
  discrete dated events as records via `record_create`. Independent
  per-thread pointer (`last_wiki_record_processed_msg_id`) and claim
  columns so it runs concurrently with the article sweep. The dev shim
  ticks this route too.
- **Librarian cron sweep**: pg_cron job `nak-wiki-librarian-sweep`
  (hourly, minute 37) -> `nak_trigger_wiki_librarian_sweep()` ->
  pg_net `POST /wiki-librarian-sweep` with the service-role bearer ->
  `runWikiLibrarianSweepTick(adminClient)`. One user per tick:
  `claim_next_user_for_wiki_librarian` stamps the cadence column for
  the most-overdue eligible user and the tick runs the standard
  five-step review for them. The dev shim ticks this route too.
- **Librarian manual run**: the Wiki panel's sparkles button ->
  `SupabaseService.runWikiLibrarian({ instructions, runId })` ->
  `POST /wiki-librarian-run` (user JWT) -> `runWikiLibrarianManual`.
  Live step events publish to `agent-runs:<userId>`; the browser
  subscribes BEFORE posting. Never touches the cadence stamp, and
  skips the min-articles check - the user explicitly asked.
- **Librarian chat dispatch**: the gated `wikiToolbox`'s registered
  `wiki_librarian` ToolDef, always the custom-instructions prompt
  variant, run inline in the chat round's tool call.
- **Manual per-article update**: the article view's "Ask agent to
  update" panel -> `SupabaseService.runWikiManualUpdate({ articleId,
  instructions })` -> `POST /wiki-manual-update` (user JWT) ->
  `runWikiManualUpdate(adminClient, userId, ...)`. Reads the
  persisted article + its records server-side, runs ONE completion
  with `response_format: {type: 'json_object'}` (no tool loop), and
  returns `{ kind: 'preview', title, content, reason, recordOps }` or
  `{ kind: 'noop', reason }` (or `{ kind: 'error', error }`, which the
  browser method turns into a thrown banner). The article's own
  records scope the record `update`/`delete` ops the model may
  propose (hallucinated-id rejection); `noop` means body unchanged
  AND no record ops. Writes nothing - the browser persists the
  article + records on Accept.
- `wiki_search` tool - registered in `alwaysOnToolbox.tools` so
  every chat request can reach it without a toolbox toggle.

Per claimed thread, the agent slices history at the claimed terminal
message (`loadThreadSliceUpTo`), appends the autonomous prompt (with
the owner's profile, freshly read from `profiles.settings`) as the
final user turn, and runs the tool loop via `runHeadlessAgent`. Side
effects (the `wiki_*` tool calls) ARE the persistent output; the
model's final text is a one-or-two-sentence operator-facing summary
of its choices ("Updated Nak article with March 2026 logo details" /
"No edits - generic Q&A with no user-centric subject") that the
sweep inlines as `reasoning="..."` on the finished-thread log line.
The prompt's "Final reply" block instructs the model to surface both
decisions made and decisions skipped (e.g. why a topic that came up
was deliberately NOT given its own article), so a human skimming the
log drawer can see WHY a cycle was a no-op without re-reading the
conversation.

## Data model

`wiki_articles`:

- `id uuid pk default gen_random_uuid()`
- `user_id uuid not null references auth.users on delete cascade`
- `title text not null`
- `content text not null`
- `embedding vector(2048)` - padded by the server-side embeddings
  backfill, same shape as memories and journal entries.
- `embedding_model text`, `embedding_claim_holder text`,
  `embedding_claim_expires timestamptz` - same claim-protocol
  columns as memories and journal entries (note: `_expires` not
  `_expires_at`, matching the existing convention).
- `created_at`, `updated_at timestamptz default now()`
- `unique (user_id, title)` - the agent's `wiki_create` tool
  surfaces a unique-violation as actionable text so the autonomous
  agent reads the conflict and falls through to `wiki_search` +
  `wiki_update`.
- Index `(user_id, lower(title))` for the alphabetical drawer
  listing.
- Trigger `clear_wiki_embedding_on_change` nulls the embedding and
  claim columns on title or content change; the backfill re-embeds
  on its next poll.
- Member of the `supabase_realtime` publication - the browser's
  refresh subscription rides the replication stream.

`threads` extension columns:

- `last_wiki_processed_msg_id uuid references messages(id) on
  delete set null` - pointer the autonomous agent advances after
  each cycle.
- `wiki_claim_holder text`, `wiki_claim_expires_at timestamptz` -
  per-thread claim columns (note: `_at` suffix here, matching
  `journal_claim_expires_at`).
- `wiki_failure_count int not null default 0` - consecutive agent
  errors against the current terminal message. Incremented by
  `record_wiki_failure_or_skip`, reset by a successful
  `mark_thread_wiki_processed_if_claimed`.
- `wiki_last_skip_at timestamptz`, `wiki_last_skip_reason text` -
  skip marker set when the failure counter reaches the cap.
  Surfaced in the Wiki tab's Skipped panel
  (`WikiSkippedPanel.svelte`) so the user can see which
  conversations the agent gave up on. Cleared on the next
  successful run; the panel naturally drains.
- `wiki_skip_fallback_attempted boolean not null default false` -
  true when the per-thread skip was stamped after the agent already
  retried with the uncensored fallback model
  (`venice-uncensored-1-2` per
  `CONTENT_FILTER_FALLBACK_MODEL` in the edge agent). The
  eligibility predicate's OR clause uses this to re-eligibilise
  legacy content-classifier skips (rows skipped before the fallback
  path existed) without looping forever on threads where the
  fallback also failed. Reset to false by the success path so a
  future skip on the same thread starts a fresh recovery budget.

These are independent of the memory-reflection
(`last_reflected_msg_id`) and journal (`last_journaled_msg_id`)
pointers. All three agents can run concurrently against the same
thread.

`wiki_records` (the dated journey layer):

- `id uuid pk`, `user_id uuid not null references auth.users on
  delete cascade`.
- `article_id uuid not null references wiki_articles on delete
  cascade` - a record always belongs to exactly one article and dies
  with it. There is deliberately NO uniqueness constraint: many
  records per article (and two records on one date) are the point.
- `date date not null` - the day the event occurred, distinct from
  `created_at` (when the row was written). The list sorts by `date
  desc`.
- `content text not null` (Markdown), `tags jsonb not null default
  '[]'` (a freeform keyword array for filtering).
- `source_conversation_id uuid references threads on delete set null`
  - extraction provenance; `set null` (not cascade) so deleting the
  source thread leaves the record - the event still happened.
- Same embedding/claim quartet as `wiki_articles`
  (`embedding vector(2048)`, `embedding_model`,
  `embedding_claim_holder`, `embedding_claim_expires`). The embed
  input is `date + content` (`buildWikiRecordEmbedInput`); tags are
  excluded so a noisy tag can't dominate the vector.
- Indexes: `(article_id, date desc)` (the per-article list),
  `(user_id, date desc)` (cross-article chronological), and a GIN
  index on `tags` (containment filtering). No ANN index - rows are
  claimed by `updated_at`-ordered scan, same as `wiki_articles`.
- Triggers: `touch_wiki_record_updated_at` (BEFORE UPDATE stamps
  `updated_at`, since three surfaces write records and none can be
  trusted to set it), and `clear_wiki_record_embedding_on_change`
  (nulls the embedding/claim columns when `content` or `date`
  changes).
- Member of `supabase_realtime` with a `(id, user_id)` replica-
  identity index so DELETE events reach the browser's user-filtered
  subscription (the same gotcha as `wiki_articles` / memories).
- Embedding RPCs `claim_next_pending_wiki_record` /
  `save_wiki_record_embedding_if_claimed` /
  `search_wiki_records_by_embedding` clone the article trio;
  `wiki-records` is registered in `EMBED_SOURCES` so the generic
  backfill loop drains it.
- Changelog: every record write (create / update / delete) appends a
  `wiki_changelog` row scoped to the parent `article_id`, with a
  `record_*` kind. Both write paths do it: the edge tools via
  `appendRecordChangelog` in `tools/_record_helpers.ts` (best-effort,
  swallowed on failure), and the in-app compose form via
  `SupabaseService.appendRecordChangelog`. The message wording is built
  by `buildRecordChangelogMessage`, mirrored in `src/lib/wiki.ts` and
  `_record_helpers.ts` so both paths read identically
  ("Added record (2026-06-17): ..."). The `WikiChangelogPanel`
  refetches on `onWikiRecordChange` as well as `onWikiChange`.

`threads` extension columns for the extraction agent
(`last_wiki_record_processed_msg_id`, `wiki_record_claim_holder`,
`wiki_record_claim_expires_at`, `wiki_record_failure_count`,
`wiki_record_last_skip_at`, `wiki_record_last_skip_reason`) mirror the
article agent's, minus the content-filter fallback flag (the
extraction model has no uncensored-fallback path). Independent pointer
so extraction and article maintenance run concurrently.
`reset_wiki_data` clears these alongside the article columns and
deletes `wiki_records` rows explicitly.

### Record files and cross-links

Two relations hang off `wiki_records`, both keyed by their own
`user_id` (direct RLS, not via-parent) and members of
`supabase_realtime` with `(id, user_id)` replica-identity indexes for
DELETE delivery:

`wiki_record_files` (per-record attachments - crumb photos, scanned
cards, PDFs):

- `id`, `user_id`, `record_id uuid not null references wiki_records on
  delete cascade`, `position int`, `filename`, `mime_type`,
  `size_bytes`, `storage_path text not null`, `extracted_text` (Venice
  text-parser output for non-image docs, so `record_get` can hand the
  model a document's text; null for images), `created_at`.
- Bytes live in the **persistent** `wiki-record-files` Storage bucket
  (key `<user_id>/<file_id>/<filename>`), following the
  `docs/dev/file-storage.md` model. Unlike `attachments` it never
  expires - a record is permanent, so its evidence is too. Orphaned
  objects (left when a record/article delete cascades the row away) are
  reclaimed by the daily `wiki-record-file-gc` edge function backed by
  `list_orphan_wiki_record_file_objects` (a clone of `attachment-gc`).
- The browser uploads through `SupabaseService.uploadAndAttachWikiRecordFile`
  (image downscale + non-image text-extract reuse the chat composer's
  helpers) and reads via `listWikiRecordFiles` +
  `createWikiRecordFileSignedUrls`. The chat reaches files through the
  `record_file_attach` tool, which **promotes a file the conversation
  already holds** (a user upload OR a `generate_image` output - both are
  `message_attachments` rows) by copying the bytes from the
  `attachments` bucket into `wiki-record-files`. The model can't upload
  bytes; it names a live thread file by filename (expired source ->
  actionable error). See the Attachments interaction.
- **Per-record content dedup.** Both write paths key on
  `wiki_record_files.content_hash` (lowercase hex SHA-256 of the bytes)
  and probe `(record_id, content_hash)` before writing - if the record
  already holds those exact bytes they no-op (no upload, no insert, no
  changelog) and return the existing row. This is load-bearing for the
  agent path: a second extraction/wiki pass over the same thread re-names
  the same source file, and without the probe it stacked a duplicate
  thumbnail on the record. Content-keyed, not filename, so two genuinely
  different files that share a name still both attach. `content_hash` is
  NULL on legacy rows written before the column; the probe simply misses
  them (so a fresh attach onto a pre-existing legacy copy can still dup
  once - a one-time data condition, not an ongoing leak).
- **Collapsed-row attachment badge.** `listWikiRecords` embeds
  `wiki_record_files(count)` (-> `WikiRecord.fileCount`) so a collapsed
  record row shows a paperclip + count without fetching each record's
  file strip. `recordFileBadgeLabel` (in `ui/wiki-records.ts`) owns the
  pluralization / null-when-zero; the badge hides while the row is
  expanded (the strip itself is then visible). The row reloads via the
  `onWikiRecordChange` bus, so the count refreshes after attach/remove.

`wiki_record_links` (a directed, labelled graph between records):

- `id`, `user_id`, `from_record_id` / `to_record_id` (both `references
  wiki_records on delete cascade`), `label text` (freeform, capped at
  `MAX_RECORD_LINK_LABEL_CHARS` = 120), `created_at`.
- `check (from_record_id <> to_record_id)` (no self-links) +
  `unique (from_record_id, to_record_id)` - a **simple directed graph**:
  one edge per ordered pair, the label is the edge's editable attribute,
  A->B and B->A are distinct rows. Re-linking a pair updates the label
  (the create path is an upsert on the pair).
- `SupabaseService.listWikiRecordLinks` projects a record's edges from
  its own point of view (`WikiRecordLinkView`: direction + the other
  endpoint's date/content). The chat reaches links through
  `record_link_create` / `record_link_delete`.

**Changelog.** File and link mutations ARE record changes, so each lands
a `wiki_changelog` row reusing the **`record_update`** kind (no
constraint change) with descriptive wording - "Attached image (date):
crumb.jpg", "Linked to (date) ... - based on" - built by
`buildRecordFileChangelogMessage` / `buildRecordLinkChangelogMessage`,
mirrored in `src/lib/wiki.ts` and edge
`tools/_record_helpers.ts` so the in-app and tool/agent paths read
identically. They render under the panel's "Edited" chip.

**Reads.** `record_get` returns the record plus its `files` (metadata +
bounded `extracted_text`) and `links` (outgoing/incoming with the other
endpoint's dated excerpt); `record_list` annotates each row with
`file_count` / `link_count` (two batched queries over the listed ids,
not N+1).

**Embeddings unchanged.** A record's embed input stays `date + content`;
attached-file text does NOT feed the record vector (a noisy OCR dump
shouldn't dominate retrieval). Files reach the model through
`record_get`, not through search ranking.

**UI.** Files + links live in the EXPANDED record body in
`WikiRecords.svelte` (a new record has no id yet, so management sits
where the record exists, beside Edit/Export/Delete): an upload zone
(drag/drop + picker), an image-thumbnail / doc-download strip, and a
link picker (target select + label). Decision logic is in the
`src/lib/ui/wiki-records.ts` primitives (`partitionRecordFiles`,
`describeLink`, `linkCandidates`, `validateLinkLabel`,
`formatRecordFileMeta`, `recordFileIsImage`), unit-tested in
`tests/wiki-records.test.ts`. The `subscribeToWikiRecordChanges` relay
covers all three tables, so a server-side file/link write refreshes an
open article view. The link picker currently offers only the current
article's records (the same-article "attempt N based on attempt N-1"
case); the schema supports cross-article links for a later widening.

### Eligibility predicate

`claim_next_thread_for_wiki` is a global sweep: one SECURITY DEFINER
query joins `threads` to `profiles` and evaluates every user's
eligibility in a single pass. The per-user inputs come off the
joined profile rather than parameters:

- the day-gate timezone is `settings->>'displayTimezone'`, resolved
  through `nak_safe_timezone` (UTC fallback) so one malformed value
  cannot wedge the all-users sweep;
- the Settings "automatic wiki updates" toggle gates eligibility via
  `(p.settings->>'wikiAutomaticEnabled') is distinct from 'false'` -
  only the literal string `'false'` disables; anything else,
  including a missing key, means enabled, matching the client's
  `?? true` default. A boolean cast would let one malformed value
  raise and wedge the sweep, so the comparison stays a string
  compare on purpose.

It differs from `claim_next_thread_for_journal` in two further ways:

1. **Newest-message lateral.** The journal RPC reads
   `threads.updated_at` for the cooldown bucket. The wiki RPC reads
   the newest message's `created_at` directly via a second lateral.
   Both columns move on every insert, but reading from
   `messages.created_at` is more honest about "when did the
   conversation actually last move" - a future bump to
   `threads.updated_at` from an unrelated write would shift the
   gate.
2. **Strict-yesterday gate.** The normal-eligibility branch includes
   `(newest.created_at at time zone tz)::date <
   (now() at time zone tz)::date` - newest message must land on a
   calendar day strictly before today in the user's tz. Effect: chat
   Monday -> eligible Tuesday; user resumes Wednesday -> the new
   newest msg lands on Wednesday and the inequality fails again
   until Thursday. The day-gate sits INSIDE the normal branch (see
   below), not at the top of the WHERE, so the skip-recovery branch
   can ignore it.

Same depth guard (>= 2 user messages) and `for update of t skip
locked` fairness as the journal RPC. Returns `user_id` alongside the
thread columns so the agent can scope its run (and its log lines) to
the owner.

The eligibility check is a two-branch OR:

- **Normal:** `term.msg_id is distinct from
  t.last_wiki_processed_msg_id` AND the day-gate above. There's new
  work past the pointer and the thread has settled past today's
  boundary.

- **Recovery:** the thread carries a content-classifier skip the
  uncensored fallback hasn't tried yet (`wiki_last_skip_reason ilike
  '%inappropriate content%' AND NOT wiki_skip_fallback_attempted`).
  This branch INTENTIONALLY ignores the day-gate. A skipped thread
  is by definition no longer in-flight (the agent already tried it
  and gave up), and gating the recovery sweep on next-day would mean
  adding a turn to nudge the agent actually pushes eligibility OUT
  to tomorrow rather than making the thread retryable sooner. The
  success path clears both the skip reason and the
  fallback-attempted flag together, and the failure-cap path stamps
  the flag to true, so a thread can't loop the recovery branch
  indefinitely: at most one re-entry per terminal message.

The same predicate logic is what re-eligibilises legacy skips - rows
skipped before the uncensored-fallback retry path existed, which
carry the default `false` flag.

## Contracts

### Claim/mark atomicity

The sweep's per-thread cycle (`runWikiSweepTick`) is:

1. `claim_next_thread_for_wiki(holderId, ttl)` - returns
   `{ thread_id, user_id, terminal_msg_id, title, newest_msg_at }`
   or nothing (queue empty). A fresh `crypto.randomUUID()` holder is
   minted per claim; nothing else needs to recognise it. There is no
   lease coordinator - the claim RPC's atomic per-thread claim + TTL
   IS the mutual exclusion, same rationale as reflection.
2. `runWikiAgentOnThread(...)` - tool calls are the side effects.
3. `mark_thread_wiki_processed_if_claimed(threadId, holderId,
   terminalMsgId, userId)` - returns true on success, false on
   claim-lost.

Mark is **unconditional on `done`**. Even a no-op cycle (agent
decided no topic warranted a wiki update) advances the pointer so
the same conversation isn't re-processed every tick. New turns added
later trigger eligibility again via the next-day predicate. An empty
slice (a thread with no messages) is also marked, so a pathological
row can't pin the queue.

The **error branch** does not call mark. Instead it routes through
`record_wiki_failure_or_skip`, which atomically:

- increments `wiki_failure_count` under our claim,
- below the cap (`MAX_FAILURES_PER_THREAD`, 3): clears the claim so
  the next sweep tick retries quickly,
- at the cap: advances the pointer, resets the counter, stamps
  `wiki_last_skip_at` + `wiki_last_skip_reason` (truncated to 500
  chars), and stamps `wiki_skip_fallback_attempted` when the reason
  matches the content-filter sentinel.

This is the give-up path for conversations the agent can't process -
dominantly Venice's content classifier rejecting the body with HTTP
400, but also any other persistent agent error. Without the cap, a
permanently-filtered conversation would pin the queue at one failed
call per claim-TTL window (10 min) forever. With the cap, the agent
burns three attempts and moves on; the user sees the skip in the
Wiki tab's Skipped panel and can either click Retry on the row or
wait for the recovery branch of the eligibility predicate.

An infrastructure failure (the claim RPC itself errors) stops the
tick rather than burning failure counters across the queue; the next
cron tick retries. `runWikiSweepTick` is non-throwing by contract
and returns a `WikiSweepSummary` of per-outcome counters (claimed /
processed / emptySlice / skipped / released / claimLost / errors) to
the route, which pg_net ignores but the dev shim prints.

**Content-classifier fallback (in `runWikiAgentOnThread`).** Before
the per-thread failure counter ever increments for a classifier
rejection, the agent itself retries the tool loop once against
`CONTENT_FILTER_FALLBACK_MODEL` (`venice-uncensored-1-2`,
which does not run the same input classifier; it must support
function calling and is a non-reasoning model, so the fallback
attempt keeps `reasoning_effort` off the wire). Only the
content-filter sentinel (`"Input text data may contain inappropriate
content"`, matched as a substring of the error message) triggers the
retry; any other error (network blip, 500, parse failure) returns
as-is so the failure counter handles it. On a successful fallback
run the cycle marks normally and the mark path clears any prior skip
marker. If the fallback also fails, the failure counter takes over -
and when the counter eventually advances the pointer,
`record_wiki_failure_or_skip` stamps
`wiki_skip_fallback_attempted=true` for a classifier-shaped reason
so the eligibility predicate's OR clause can't loop the same thread
back into the queue.

**Context-window handling (distill-then-act, `_accumulator.ts`).**
Both per-thread agents (article + record extraction) bound what they
send to Venice. Every tool-loop round carries an explicit
`max_completion_tokens` (8192); without it, the serving backend
reserves its own default output budget - observed at 65536 tokens -
out of the context window, which on 2026-07-23 starved two long
threads of input room and skipped them ("maximum context length is
163840 tokens"). The registry's `contextWindow` for the wiki models
says 1M, but the enforced ceiling demonstrably moves between
backends serving the same model id, so the agents budget against the
conservative `WORKING_CONTEXT_TOKENS` (96k) in
`agents/_accumulator.ts` instead. A transcript estimated over that
window is **distilled before the tool loop**: the accumulator
renders the slice to text (tool traffic excerpted), chunks it, and
folds each chunk into an accumulated notes buffer via one completion
per chunk - fnord's accumulator pattern - then the normal tool loop
runs once over the notes instead of the raw transcript, so all
writes still happen with the full toolbox and dedup discipline
(chunk passes are read-only by design). A context-length 400 from a
direct run triggers the same distill path reactively; a 400 during
distillation backs off the chunk budget (0.2 steps, 0.6 floor)
before giving up. A context-length error that survives all of that
is marked `deterministic` on the run outcome and the sweep skips the
thread on the FIRST failure (`p_max_failures = 1`) with the honest
reason, instead of burning the transient 3-strike budget on an error
that repeats identically.

This differs from the journal flow, which uses an atomic
`upsert_journal_entry_and_mark_thread` RPC because the entry write
and the pointer advance must happen in lockstep. The wiki agent's
writes are independent tool calls landing through the registered
`wiki_create` / `wiki_update` / `wiki_delete` tools - those rows are
owned by the user, not the claim, so a claim-lost during the cycle
leaves any already-landed writes intact and just drops the
pointer-advance for that cycle. The next claim will reprocess the
conversation.

### Manual retry (Skipped panel)

The Skipped panel's Retry button is a thin authenticated POST
(`SupabaseService.retryWikiThread` -> `/wiki-retry`); the whole
cycle runs server-side in `retryWikiThread`:

1. `claim_wiki_thread_for_retry(threadId, holder, ttl, userId)` claims
   the named thread via the per-thread `wiki_claim_*` columns. A held
   claim (the sweep, or a concurrent retry) returns `kind: 'busy'` -
   the run does not start. This is the change from the original
   claim-free retry: claiming makes the run a durable, reload-
   recoverable fact (see "Reload recovery" below) and gives real mutual
   exclusion against a concurrent sweep claim.
2. `compute_wiki_terminal_msg_id(threadId, userId)` resolves the
   same anchor the sweep's claim RPC would have picked. Null (no
   assistant message to process) returns `kind: 'no-op'`.
3. `runWikiAgentOnThread` runs the primary -> fallback two-shot. The
   wiki tools commit their writes immediately, so any tool-call side
   effects land regardless of what happens next.
4. On success, `manual_advance_wiki_pointer(threadId, msgId,
   userId)` clears the skip marker, advances
   `last_wiki_processed_msg_id`, AND nulls the claim. The RPC is scoped
   to the owning user (`auth.uid()` or the gateway-validated id the
   service-role caller passes).
5. On any exit, the `finally` calls
   `release_wiki_thread_retry_claim(threadId, holder, userId)` -
   holder-checked, so it is a no-op when step 4 already cleared the
   claim or when a sweep stole a lapsed one. On error the skip marker
   is left in place so the user sees the thread is still problematic.

The route responds with the `WikiRetryResult` union -
`{ kind: 'ok', terminalMsgId, toolCalls, reasoning }` /
`{ kind: 'no-op', reason }` / `{ kind: 'busy' }` / `{ kind: 'error', error }`.
Agent-level failures are an application outcome (`kind: 'error'`),
not a transport error, so the panel renders them without sniffing
status codes; only transport/auth failures throw on the browser
side. `SupabaseService.retryWikiThread` boundary-validates the shape
and collapses anything unrecognised to an error result.

**Reload recovery.** `handleWikiRetry` runs the retry under
`edgeWaitUntil`, so a reload mid-retry doesn't kill the run - it
finishes and the claim/skip-marker settle even though the response
never reaches the reloaded tab. The reloaded tab recovers the
in-flight state from the claim: `list_wiki_skipped_threads` returns a
`retrying` flag (`wiki_claim_expires_at` in the future), and
`WikiSkippedPanel` renders the disabled "Retrying..." button from
`retrying[threadId] || row.retrying` - the local in-memory flag for the
responding tab, the server claim for everyone else. This is liveness
recovery only: the result chip (tool-call count + reasoning) stays
in-memory and is not recovered across a reload. The claim's TTL (the
sweep's `WIKI_CLAIM_TTL_SECONDS`) is the backstop that clears a stale
`retrying` flag if a run dies without releasing.

### Librarian cadence and mutual exclusion

Two independent coordination mechanisms, deliberately separate
because the cadence stamp cannot express "running right now":

- **Cadence** (scheduled path only).
  `claim_next_user_for_wiki_librarian` stamps
  `profiles.wiki_librarian_last_run_at` inside the claiming UPDATE -
  BEFORE the run - so a run that dies mid-flight waits out the 12h
  interval instead of retrying hot against whatever killed it. The
  same stamp-before-run shape means a tick that ends in `too-small`
  (the post-claim `LIBRARIAN_MIN_ARTICLES` check) or
  `inflight-blocked` deliberately consumes that user's 12h slot: a
  tiny wiki is rechecked next interval rather than re-probed every
  tick, and the run that holds the guard IS that cycle's librarian
  activity. Manual and chat runs never touch the stamp - user-driven
  runs don't reset the scheduled clock.
- **In-flight guard** (all three paths).
  `claim_wiki_librarian_inflight` /
  `release_wiki_librarian_inflight` - an atomic holder + TTL pair
  (600s) on profiles, taken before any review and released in each
  entry point's `finally`. A collision surfaces as the `busy` result
  on the manual route and as a tool error the chat model can relay
  ("try again in a moment"). The TTL unwedges a guard a crashed run
  left behind; release is holder-checked, so a lapsed-and-stolen
  guard is left to its new owner.

`runWikiLibrarianSweepTick` and `runWikiLibrarianManual` are
non-throwing by contract: the sweep returns a
`WikiLibrarianSweepSummary` outcome (`no-user` / `inflight-blocked`
/ `too-small` / `reviewed` / `error`) that pg_net ignores and the
dev shim prints; the manual route returns the
`WikiLibrarianManualResult` union (`ok` / `busy` / `error`).

### Librarian live progress

The manual run is the only librarian path a user watches in real
time, so it is the only one that pays for narration. The route
builds `createAgentProgressPublisher` bound to the user plus the
client-minted runId and forwards every `LibrarianProgressEvent`
(`preparing` with the article-snapshot count, the runner's
`thinking` / `tool`, a closing `done`) to the private
`agent-runs:<userId>` Broadcast topic. The browser subscribes
BEFORE the POST (the pre-subscribe rule streaming chat established)
and filters on runId - the topic is per-user, not per-run, so the
one literal-equality policy on `realtime.messages` covers every run
and the payload's runId is the demux key. Attaching the runner's
`onProgress` hook is also what injects the required `activity`
narration parameter into every tool's wire schema; the scheduled and
chat-dispatched paths attach no listener, so their wire bytes stay
narration-free. The route awaits `publisher.flush()` before
responding so the `done` event (the one the UI needs to stop its
spinner) lands no later than the response body.

### UI refresh for server-side writes

Both wiki agents run where the browser's `emitWikiChange` event
bus is unreachable, so an open Wiki panel learns about background
writes through `SupabaseService.subscribeToWikiArticleChanges` - a
user-scoped `postgres_changes` subscription on `wiki_articles`
(filter `user_id=eq.<id>`), wired in Chat.svelte to fire
`emitWikiChange`. Coarse on purpose: no per-event payloads, just
"something changed" - the wiki surfaces refetch their own lists, and
pushing row deltas through would duplicate their loaders for no win.
User edits fire the bus directly, and the manual librarian strip
fires it once on a successful run so the panel refreshes ahead of
the realtime echo; the subscription means those surfaces also see
their own writes echoed back, which is harmless (the refetch is
idempotent). The librarian's tool writes themselves are server-side
and reach the panel only through this subscription.

### Edge logging

The agent logs through `createEdgeLogger(userId, 'wiki')`, which
mirrors every line to the in-app Logs drawer over the
`logs:<userId>` Broadcast channel (see `docs/dev/logging.md`,
"Edge-to-main relay"). The sweep binds the logger to each claimed
thread's OWNER, so each user only sees their own wiki activity, and
flushes per thread so a later infrastructure failure can't drop
lines an earlier thread earned. Drawer source tag: `wiki`. The
librarian logs as `wiki-librarian` on all three of its trigger paths
(each entry point binds `createEdgeLogger(userId, 'wiki-librarian')`
and flushes in its `finally`); the manual per-article flow uses
`wiki-manual` for BOTH halves of the lifecycle (one tag, same as
`samskara` / `bias`): the edge `/wiki-manual-update` route logs the
start (info) and the preview-stage outcome - preview / noop /
unparseable (debug) - via `createEdgeLogger(userId, 'wiki-manual')`
flushed in `runWikiManualUpdate`'s `finally`, and the browser panel
(`Wiki.svelte`, `createLogger('wiki-manual')`) logs the user's
accept/decline choice (debug) and, on Accept, the record-op and body
commits (trace).

### Embedding pipeline

`wiki_articles.embedding` is populated by the server-side embeddings
backfill. Its input builder
(`supabase/functions/_shared/embed-input.ts`) builds the input
string as `${title}\n\n${content}` (mirroring memories'
label-and-data shape), truncates content to
`MAX_WIKI_CONTENT_CHARS = 16000`, and drives
`claim_next_pending_wiki_article` /
`save_wiki_article_embedding_if_claimed`.

The same `text-embedding-bge-m3` model and 2048-dim padded vectors
as memories and journal entries.

### Autonomous vs manual agent split

Two distinct flows, both server-side, but different shapes:

| Aspect      | Autonomous (`wiki.ts`) | Manual (`wiki_manual.ts`) |
| ----------- | ---------------------- | ------------------------- |
| Runs in     | venice function        | venice function           |
| Trigger     | Cron / Retry button    | User clicks "Ask agent to update" |
| Route       | `/wiki-sweep`, `/wiki-retry` | `/wiki-manual-update` |
| Inputs      | Whole conversation     | One article + its records + instructions |
| Tools       | Yes (`buildWikiToolbox`) | No (one JSON completion) |
| Output      | Tool side effects      | JSON preview (body + record ops) |
| Persistence | Tool calls write       | Browser persists article + records on Accept |
| Prompt      | `buildWikiAutonomousPrompt` | `buildWikiManualPrompt` |

Both run `deepseek-v4-flash` and share the encyclopedic-third-person
voice, the "preserve facts unless explicitly contradicted"
discipline, and - now that both live in the same runtime - the
literal `renderUserProfileBlock` from `agents/_wiki_profile.ts`. They
differ on scope (whole wiki vs one article), input shape
(conversation vs explicit instructions), output shape (tool calls vs
JSON), and whether they write (the manual flow proposes a preview the
browser persists, the autonomous flow's tool calls ARE the writes).

### Tool toolbox split

- `alwaysOnToolbox` (browser, `src/lib/tools/index.ts`) includes the
  read surfaces - `wiki_search` (semantic + substring), `wiki_list`
  (alphabetical projection with head-of-content excerpts), `wiki_get`
  (primary-key body fetch), and `wiki_recall` (sub-agent that
  synthesises a topic note). All four ride every chat request; reads
  are idempotent and cheap, and the wiki blurb in the system prompt
  tells the model which one to reach for in which case.
- `wikiToolbox` (browser, main-chat registry) is the single gated
  toolbox the chat model toggles for every wiki write. It carries the
  direct article CRUD (`wiki_create` / `wiki_update` / `wiki_delete`),
  the `wiki_librarian` delegation (the server-side sub-agent for
  multi-article consolidations - merge / split / rewrite across the
  whole wiki), AND the record writes (see "Record toolbox split"
  below). The chat model reaches for a one-shot `wiki_update` when a
  targeted edit is enough and delegates to the librarian when the job
  needs a read-everything-then-plan pass over many articles. The
  direct article writes wrap the same registered tool impls the
  autonomous agents use; the chat dispatch's current thread is
  attached as the article's source automatically (the chat schemas
  omit the librarian-only `source_thread_ids`).
- The autonomous agent's toolbox (`buildWikiToolbox` in
  `supabase/functions/venice/agents/wiki.ts`) bundles wiki_search +
  create + update + delete plus READ-ONLY `memory_search`, each
  wrapped via `asAgentTool` so the agent calls the same registered
  tool impls the rest of the function uses. The agent receives
  delete because consolidation (subsuming a stale duplicate into
  another article it just updated) is a legitimate wiki-maintenance
  operation; the prompt explicitly forbids deleting on the basis of
  "the user said something different today" alone. memory_search
  rides along so the agent can ground article content in atomic
  facts the reflection agent already extracted; the wiki agent never
  gets memory write tools. Composition is asserted in
  `supabase/functions/tests/wiki.test.ts`.
- The librarian's toolbox (`buildLibrarianToolbox` in
  `agents/wiki_librarian.ts`) bundles four reads (wiki_search,
  conversation_search, conversation_get, memory_search) plus
  wiki_update + wiki_delete - **no wiki_create** (the librarian
  consolidates what exists, it never invents) and no memory writes.
  `conversation_search` returns only title + topic summary, so the
  attribution pass (workflow step 3c) and the stale-fact pass (step
  4) use `conversation_get` to read the actual role-tagged turns -
  the summary cannot tell the librarian whether a claim came from the
  user or was merely explained by the assistant. The write tools
  are the registered ports wrapped via `asAgentToolNoThread`, which
  blanks the context's threadId before the registered execute()
  sees it: the registered write tools auto-attach a non-empty
  `ctx.threadId` to the article's bibliography (correct for the
  per-conversation agent, which processes exactly that thread), but
  a librarian dispatched from a chat thread must not auto-attach the
  delegating conversation as a source - the librarian attributes
  only through model-supplied `source_thread_ids`, on every path.
  Composition is asserted in
  `supabase/functions/tests/wiki_librarian.test.ts`.

### Record toolbox split

Record writes live in the SAME `wiki` toolbox as the article writes -
one toggle gates the whole chat-driven wiki write surface. They were
once their own `wiki_records` box; folding them in matches the user's
mental model (enabling "wiki" turns on wiki editing, articles and
records alike) and removes a toolbox the user otherwise had to discover
separately.

- `alwaysOnToolbox` carries the record READS - `record_list` (one
  article's timeline), `record_get` (by id), `record_search`
  (semantic across every article's records). They ride every request
  like the wiki reads.
- `wikiToolbox` (gated, `name: 'wiki'`) carries the record WRITES -
  `record_create` / `record_update` / `record_delete` plus the
  file + link writes `record_file_attach` / `record_file_remove` /
  `record_link_create` / `record_link_delete` - alongside the article
  writes. Gated via the composer popover / `toggle_toolbox` like the
  cooking and memory write boxes. The membership tripwire lives in
  `tests/tools.test.ts`.
- The extraction agent's toolbox (`buildWikiRecordsToolbox` in
  `agents/wiki_records.ts`) is read-heavy with three writes,
  `record_create` + `record_link_create` + `record_file_attach`:
  `wiki_search` + `wiki_list` find the home article, `record_list`
  dedupes, read-only `memory_search` grounds, and `analyze_image` lets
  the text-tier model verify a posted photo before attaching it. It
  conservatively
  cross-links a continuation (only when the conversation explicitly
  frames the new event as a follow-up to a specific prior record) and,
  because it creates a record from a live event, can attach a photo the
  user posted in the SAME conversation (a crumb shot, a scan) onto that
  record - the natural moment for chat evidence to become permanent. It
  attaches but never detaches (`record_file_remove` is a maintenance
  act), never touches article bodies or memory, and never links in
  reverse (`record_link_delete` is the librarian's). Asserted in
  `supabase/functions/tests/wiki_records.test.ts`.
- The article worker and the librarian both get the full record-
  management set: `record_list` + `record_create` + `record_update` +
  `record_delete` + `record_link_create`. Both prompts encode the
  body/records separation: the article BODY is the current state,
  records are the journey. Behaviours that follow:
  - **Promote - without duplicating**: fold durable learnings from
    records INTO the body, but never delete a record because its
    learning was promoted (records are historical documentation), and
    never let the body re-narrate what a record already holds. Both
    prompts call out the **date-titled body section** (a header like
    "Dutch oven boule (late June 2026)" recounting one bake) as the
    duplication smell to migrate out and replace with distilled
    current-state prose.
  - **Migrate**: relocate inline dated history that legacy bodies
    accreted (the pre-records worker prompt told it to append dated
    entries to the body) OUT into records, then trim the body to
    current-state prose. `record_create` here is scoped to MIGRATION
    only - neither agent re-extracts new conversation events into
    records (that stays with the extraction agent). The discipline is
    strict and dedup-first: `record_list` to check the event is not
    already a record (the extraction agent or the user may have logged
    it), `record_create`, and only THEN trim the body line - never
    drop a dated line before its record exists. The worker also stops
    appending NEW dated entries to bodies; the journey goes to records.
  - **Clean up**: `record_update` to correct or merge a record,
    `record_delete` for a true duplicate or clearly-irrelevant entry -
    opportunistic on the records of articles the agent is already
    touching. The librarian's pass is wider: its workflow step 7
    explicitly targets the articles with the most recent record
    activity (the article-list projection annotates per-article
    record counts + latest record dates to make that actionable),
    and its step 7d names the same-event duplicate shape and the
    merge discipline - see the "Same-event record duplicates"
    gotcha. The hard rule on both: never `record_delete` a record
    because its learning was promoted; records survive promotion.
  - **Link**: `record_link_create` to wire up an explicit continuation
    chain (one record is a revision of / based on / supersedes another)
    the records state but were never linked; conservative, never
    invented on a vague resemblance. The librarian ALSO gets
    `record_link_delete` to prune a link a merge/delete left dangling or
    a redundant reverse edge (the worker leaves pruning to the
    wiki-wide pass).
  The worker scopes its record edits to the article whose subject the
  current conversation is about; the librarian works wiki-wide. Only
  `record_create`-from-conversation stays carved out to the extraction
  agent, so the worker and librarian never duplicate its event-capture
  job.
- **File attach is per-thread, and needs perception plumbing.** The
  worker and the extraction agent both get `record_file_attach` - each
  processes a specific conversation, so a photo the user posted there (a
  crumb shot, a scanned card) can be hung on the record that documents it.
  The librarian does NOT: it runs wiki-wide with no conversation in
  context (`asAgentToolNoThread` blanks the thread), so it has no chat
  file to pull from.

  Two facts make a naive wiring useless, so both per-thread agents get the
  same support the non-vision chat tiers get:
  - **The agent can't see attachment filenames.** `loadThreadSliceUpTo`
    selects only message text - no attachment join - and the chat path's
    `<thread_attachments>` note is assembled per-turn in the browser
    (`src/lib/chat/prompt-assembly.ts`), never stored. So the agents call
    `loadThreadAttachmentsNote` (`agents/_agent_tools.ts`) and prepend a
    `<thread_attachments>` note (live image + file filenames) to their
    final prompt turn. Without it the model has no real filename to pass
    and `record_file_attach` is uncallable.
  - **The agent model is text-tier** (`deepseek-v4-flash`,
    `supportsVision: false`) - it cannot see image pixels. So both agents
    also get `analyze_image` (read-only, thread-scoped via
    `requireThreadId`), the same vision-sub-model indirection the chat
    path uses for non-vision tiers. The prompt requires verifying an
    image with `analyze_image` before attaching when more than one image
    is present, so the agent can't blind-guess the wrong photo onto a
    record.

  Asserted in `supabase/functions/tests/wiki_records.test.ts`,
  `wiki_librarian.test.ts`, and `wiki.test.ts`.

## Interactions

- **Offline cache** (`docs/dev/offline-cache.md`) - the
  `wiki_articles.favorite` flag, its header toggle, the sidebar
  Favorites bucket, and `setWikiArticleFavorite` /
  `listFavoriteWikiArticles` / `getWikiArticleById` exist for offline
  caching: favoriting an article is what mirrors it into IndexedDB.
  The article detail view resolves its open article through that
  feature's read-through (`getArticleCached`) so a favorited article
  opens with no network. Favorite toggles deliberately skip
  `updated_at` so the cache treats a bookmark flip as "no content
  change".
- **File storage** (`docs/dev/file-storage.md`) - record files use the
  persistent `wiki-record-files` bucket and the signed-URL read model;
  the `wiki-record-file-gc` orphan sweep is a clone of `attachment-gc`.
- **Attachments** (`docs/dev/attachments.md`) - `record_file_attach`
  promotes a thread file (user upload OR `generate_image` output) onto a
  record by copying its bytes out of the `attachments` bucket, reusing
  the thread-scoped filename resolver `analyze_image` uses. The chat
  attachment can expire; the record copy is permanent.
- **Memory** (`docs/dev/memory.md`) - the wiki agent grounds article
  content via read-only `memory_search`; the wiki's embedding shape
  and claim-protocol columns are clones of memories.
- **Reflection** (`docs/dev/memory.md`) - the server-side agents
  share `agents/_agent_tools.ts` (`asAgentTool`,
  `loadThreadSliceUpTo`, `MEMORY_SEARCH_WIRE_SCHEMA`), the
  `runHeadlessAgent` runner in `agents/_run.ts` (including its
  completion seam and `onProgress` hook), and the same no-lease
  claim+TTL posture. The eligibility predicate in
  `claim_next_thread_for_wiki` is the deliberate divergence (global
  profile join, day-gate, recovery branch).
- **Embeddings** (`docs/dev/embeddings.md`) - the
  `clear_wiki_embedding_on_change` trigger nulls the embedding on
  every article change; the server-side backfill re-embeds. The wiki
  sweep's cron dispatch (`nak_trigger_wiki_sweep`) is a clone of the
  backfill's vault + pg_net pattern, offset to minute 7; the
  librarian's (`nak_trigger_wiki_librarian_sweep`) to minute 37; the
  record extraction sweep's (`nak_trigger_wiki_records_sweep`) to
  minute 17. `wiki_records` is an `EMBED_SOURCES` member, so records
  embed through the same backfill loop
  (`buildWikiRecordEmbedInput` = date + content).
- **Logging** (`docs/dev/logging.md`) - the agents' edge loggers
  relay to the in-app Logs drawer over the `logs:<userId>`
  Broadcast channel; drawer source tags `wiki` (autonomous agent),
  `wiki-librarian` (librarian, all three paths), `wiki-manual`
  (the per-article manual update, edge-side). The librarian's manual run additionally
  publishes live step events over the sibling `agent-runs:<userId>`
  Broadcast topic (`_shared/agent-progress.ts`), which follows the
  same transport + flush-before-respond contract as the log relay.
- **Chat / tools** (`docs/dev/chat.md`, `docs/dev/tools.md`) -
  `wiki_search` and the other read tools (plus the record reads
  `record_list` / `record_get` / `record_search`) are always-on in
  every chat request. The gated `wikiToolbox` is the single toggle for
  every chat-driven write: direct article CRUD (`wiki_create` /
  `wiki_update` / `wiki_delete`), the `wiki_librarian` delegation for
  multi-article consolidations, and the record writes
  (`record_create` / `record_update` / `record_delete` plus the file +
  link tools).
- **Edge function auth** (`docs/dev/edge-function-auth.md`) - the
  venice function is b-strict: `/wiki-sweep`,
  `/wiki-records-sweep`, and `/wiki-librarian-sweep` are gated on
  `isServiceRole`; `/wiki-retry`, `/wiki-manual-update`, and
  `/wiki-librarian-run` on the gateway-validated user JWT (the manual
  route reads the article + records under that id, never trusting the
  client to supply them). `claim_next_user_for_wiki_librarian` is a SECURITY
  DEFINER global sweep locked to `service_role`; the in-flight guard
  pair carries the `coalesce(p_user_id, auth.uid())` b-strict escape
  hatch; and every wiki tool / helper / RPC carries explicit
  `user_id` scoping because the service-role client bypasses RLS.
- **Settings** (`docs/dev/settings.md`) - the `wiki` group exposes
  three toggles, all consumed server-side by claim predicates:
  `wikiAutomaticEnabled` by the wiki sweep,
  `wikiRecordExtractionEnabled` by the record extraction sweep,
  `wikiLibrarianEnabled` by the librarian sweep. `displayTimezone`
  (owned by the journal pane) is consumed server-side by the
  day-gate.
- **Local stack** (`docs/dev/local-stack.md`) - no pg_cron / pg_net
  locally; `scripts/dev-backfill-cron.mjs` ticks `/wiki-sweep`,
  `/wiki-records-sweep`, and `/wiki-librarian-sweep` alongside
  `/backfill`.

## Gotchas

- **DELETE events need the (id, user_id) replica identity.** The
  `subscribeToWikiArticleChanges` relay filters on `user_id`, but a
  DELETE's WAL record carries only the table's replica identity -
  with the default primary-key identity, realtime can't match the
  filter and silently drops the event, so a librarian delete never
  refreshes an open Wiki panel. `wiki_articles_replident_idx` in
  `schema.sql` exists solely to put `user_id` into the old tuple;
  dropping it silently degrades the identity to NOTHING and breaks
  DELETE replication. Full rationale on the schema block.
- **The wiki is user-centric, not a general encyclopedia.** The
  per-conversation prompt has historically slipped on this - a
  brainstorm about app naming that mentioned the 1980s "Kermit"
  protocol produced a standalone "Kermit protocol" article. Both the
  autonomous prompt and the librarian prompt carry an explicit scope
  block (IN: projects, people, places, learning, work, hobbies,
  experiments / OUT: generic technical concepts, world history,
  public figures the user does not know, tutorials). The librarian's
  workflow step 1 is "delete out-of-scope articles", deliberately
  ahead of duplicate consolidation so it doesn't tidy two off-topic
  articles into one off-topic article. External topics referenced
  inside a user-centric article get a Markdown link (Wikipedia
  conventionally), not their own page. If you relax the scope rule,
  leave the historical failure mode noted somewhere or the
  per-thread shape will silently re-introduce it.
- **Speaker attribution: the assistant's turns are not a source of
  user-facts.** The agents read a role-tagged transcript
  (`messageToVenice` preserves user / assistant / tool roles
  verbatim), but the model historically blurred the two - folding the
  assistant's own explanations and suggestions into the article as
  things "the user" said, learned, or adopted. Both the autonomous
  prompt (opening framing) and the librarian prompt (the discipline
  block plus a self-correction pattern in the "fix references to the
  user" step, which conversation_search-corroborates and re-attributes
  or drops assistant-sourced claims already on disk) now carry an
  explicit rule: a fact enters the wiki only when the USER originated
  or accepted it; an assistant having explained or proposed something
  the user did not take up is never grounds for a user-fact. The
  middle case is real and must be attributed, not dropped: content the
  user adopted or asked to save (a reading list saved on request, an
  approach the user took up) belongs in the wiki, but framed by its
  provenance ("Jeff saved a recommended list", not "Jeff concluded")
  so a future assistant can tell what the user worked out from what
  the user was handed and kept. This pairs with
  the dual-purpose framing (biographical record for the user + context
  a future assistant loads via wiki_search) - both readers want what
  is true of the user, not a transcript. Don't soften it; "document
  the user's learning" framings are exactly what reintroduce the
  conflation (the assistant teaching X is not the user knowing X).
- **`nak_safe_timezone` is load-bearing for the global sweep.** The
  claim evaluates the day-gate for every user inside one query; a
  single profile carrying a malformed `displayTimezone` would make
  `at time zone` raise and wedge the sweep for ALL users (one bad
  row pins the queue). The guard probes the value per row and falls
  back to UTC. Don't "simplify" it away to a direct
  `settings->>'displayTimezone'` read.
- **`wikiAutomaticEnabled` is a string compare on purpose.** The
  predicate is `(p.settings->>'wikiAutomaticEnabled') is distinct
  from 'false'` - only the literal string `'false'` disables, and
  anything else (missing key, `null`, garbage) means enabled,
  matching the client's `?? true` default. A `::boolean` cast would
  raise on one malformed value and wedge the global sweep, same
  failure shape as the timezone case above.
  `claim_next_user_for_wiki_librarian` gates on
  `wikiLibrarianEnabled` with the identical shape, for the identical
  reason.
- **Wiki write tools are registered but not chat-reachable.**
  `wiki_create` / `wiki_update` / `wiki_delete` live in
  performToolCall's global registry (the barrel imports in
  `supabase/functions/venice/tools/index.ts`) so `asAgentTool` can
  wrap the registered impls, but they are deliberately absent from
  the chat wire tools array - the chat model cannot name them. Any
  chat-driven wiki edit goes through the `wiki_librarian` sub-agent.
  If you add a registry-wide dispatch path that skips the wire-array
  gate, these tools become a write surface the chat model was never
  supposed to have.
- **The runner's completion seam is the unit-test path for
  orchestration.** `runHeadlessAgent` takes an injectable completion
  call (`RunHeadlessAgentOptions.complete`; defaults to
  `toolComplete`, the live Venice call), so behavior that lives
  between model rounds - the primary-then-fallback ordering, the
  "only the sentinel triggers the fallback" branch,
  `retryWikiThread`'s advance-clears-the-skip-marker flow - is
  covered without a network in
  `supabase/functions/tests/wiki_behavior.test.ts` (the seam itself
  in `agent_run.test.ts`). New agent-side orchestration behavior
  should land with seam-driven coverage, not live verification.
- **Build agent toolboxes from the registered tool ports; never
  inline private copies.** The librarian's write tools are the
  registered `wiki_update` / `wiki_delete` executes wrapped via
  `asAgentToolNoThread`. An inlined copy drifts silently: an earlier
  inlined pair carried validation caps of 300 title / 50000 content
  chars while the real tools enforce 200 / 16000, so the same write
  validated in one path and rejected in another. Sharing the
  registered execute() is what keeps every writer byte-identical;
  when an agent needs a context tweak (the librarian's blanked
  threadId), wrap the context, don't fork the tool.
- **The librarian cadence stamp lands at claim time, before the
  run.** `claim_next_user_for_wiki_librarian` stamps
  `wiki_librarian_last_run_at` inside the claiming UPDATE, so a run
  that crashes mid-flight waits out the 12h interval rather than
  retrying hot. Deliberate consequences: a tick whose post-claim
  checks end in `too-small` (under `LIBRARIAN_MIN_ARTICLES`) or
  `inflight-blocked` still consumes that user's 12h slot - a tiny
  wiki is rechecked next interval instead of being re-probed every
  hour, and a blocked tick means another run already IS this cycle's
  librarian activity. Don't "fix" the stamp to land after a
  successful review without rethinking the crash-retry shape.
- **The progress channel is per-USER, not per-run.** Live step
  events publish to `agent-runs:<userId>` with the runId inside the
  payload; consumers demux client-side. One literal-equality policy
  on `realtime.messages` covers every run - per-run topics would
  need a policy that parses the topic string. Consequence: a
  subscriber MUST filter on runId, or events from a concurrent or
  stale run bleed into its step list.
- **The in-flight state disables the Run button, NOT the sparkle.** The
  top-bar sparkle navigates to the librarian page, so it stays enabled
  while a run is in flight - disabling it would lock the user out of the
  page that shows the run. The in-flight guard lives on `profiles`; with
  `profiles` in the realtime publication, `wikiLibrarianLease` gives the
  browser a live view of ANY run - manual, scheduled, or chat-dispatched,
  on any device. On the page that drives `runInFlightElsewhere`, which
  disables the Run button and renders a "running in the background"
  spinner. The server-side guard is still the real mutual exclusion (and
  surfaces `busy` if a run is kicked in the gap before the lease
  propagates). The lease is a TTL'd server fact, so it also clears a
  stale spinner after a crashed run without an explicit release.
- **A detached manual run must publish its outcome over the channel.**
  `detachedManualRunHandler` responds `{accepted:true}` and runs under
  `EdgeRuntime.waitUntil`, so the result the synchronous
  `manualRunHandler` returned in the HTTP body now rides the
  `agent-runs` channel as a terminal `result` event. A `runId` is
  therefore REQUIRED on the detached route (no channel, no result).
  The browser's real terminal backstop is the lease clearing, not the
  `result` event (fire-and-forget broadcast) - so dropping the result
  costs the operator-summary text, not a hung UI. Don't "simplify"
  the route back to awaiting the run synchronously: that reinstates
  the gateway-504 on long passes this whole path exists to dodge.
- **Use `messages.created_at` for the day-gate, not
  `threads.updated_at`.** The journal RPC reads `threads.updated_at`
  because journals fire on a same-day cooldown predicate that
  already matches the journal's semantics. The wiki gate is "newest
  message's calendar day is strictly before today" - reading off the
  messages lateral keeps the predicate stable against future bumps
  to `threads.updated_at` from unrelated writes.
- **`unique(user_id, title)` + the rephrased violation.** The
  autonomous agent is told to always `wiki_search` before writing,
  but a near-duplicate title can still slip through (the search
  returned an unrelated article, or caching missed). The unique
  constraint surfaces the collision as a tool error the agent reads
  as "fall through to wiki_search + wiki_update". The raw Postgres
  `duplicate key value violates unique constraint` message is opaque
  to the model, so the function-side `wiki_create` rephrases it as
  "An article titled X already exists. Run wiki_search to find its
  id, then call wiki_update." Removing the constraint would silently
  allow duplicate articles.
- **Manual agent must NOT discard facts unless told to.** The
  "rewrite for tone" / "fix paragraph 2" / "add a sentence" patterns
  all preserve the rest of the article. This is encoded in the
  manual prompt (`buildWikiManualPrompt` in `agents/wiki_manual.ts`)
  and is load-bearing for the trust contract with the user. Reviewer
  note: a future change that broadens the prompt to "make it better"
  would silently rewrite parts the user wanted left alone.
- **Pointer-advance is unconditional on `done`.** Even a no-op cycle
  (agent issued zero tool calls) advances the pointer. Without this,
  every sweep would re-process the same "the model decided this
  conversation has nothing worth wiki-ing" conversation forever.
- **Final-text is load-bearing.** The model's final reply is the
  operator-facing reasoning surfaced as `reasoning="..."` on the
  cycle's `finished thread` / `librarian finished` log line. The
  prompts ask for one or two plain-text sentences naming what the
  agent did or skipped and why; `normaliseReasoning` collapses
  whitespace and inlines that string. Do not change the prompt to
  "reply with a single word" without also dropping the reasoning
  surface on the driver side - users debug "why did the agent decide
  X" by reading those summaries in the log drawer, and the
  librarian's "two articles I considered merging but left alone"
  case is only visible there.
- **Three prompt bodies, one shared profile block.** The autonomous
  (`agents/wiki.ts`), manual (`agents/wiki_manual.ts`), and librarian
  (`agents/wiki_librarian.ts`) prompts now all live in the venice
  function, so they CAN share imports - and the autonomous + manual
  agents share the literal `renderUserProfileBlock` from
  `agents/_wiki_profile.ts` (the librarian keeps its own CORRECTIVE
  variant). The three prompt BODIES stay separate by design (different
  framing per surface), so a change to the voice rules or the
  body-vs-records discipline still has to land on each body it
  applies to - but the anti-name-fabrication block is now edited in
  exactly one place. Model pins are edge mirrors of the registry:
  `WIKI_MODEL`, `WIKI_MANUAL_MODEL`, `WIKI_LIBRARIAN_MODEL` (all
  `deepseek-v4-flash`) mirror `AGENT_MODELS` in
  `src/lib/models/index.ts`; the char caps in `src/lib/wiki.ts`
  mirror the function tools. Keep mirrors in sync.
- **`embedding_claim_expires` (no `_at`).** Schema convention for
  the embedding-side claim columns matches memories and
  journal_entries. The thread-side claim columns
  (`wiki_claim_expires_at`) DO have the suffix, matching
  `journal_claim_expires_at`. Easy to flip when cloning; both are
  canonical.
- **Same-event record duplicates are a real production failure
  mode.** Three weeks of live data produced ~8 redundant records out
  of 127, in two shapes: two conversations covering one event each
  yielded a record (two "attended the weekly meeting" records for
  one meeting), and an ongoing conversation re-describing
  yesterday's event got re-captured by the next day's extraction
  pass (two records for one bake, one of them contradicting the
  other on an ingredient ratio). The defenses live in two prompts
  and must survive rewording: the extraction prompt's step 3
  ("One event, one record" - no second record for a same-date
  same-happening event regardless of source conversation; attach
  new photos to the EXISTING record instead) and the librarian's
  step 7d (merge same-date same-event siblings; the record carrying
  a file attachment is the keeper because `record_delete` cascades
  attachments away; reconcile contradictions against the source
  conversation, never average). Records on DIFFERENT dates that
  continue one arc are the journey model working - link, don't
  merge. Asserted in `wiki_records.test.ts` / `wiki_librarian.test.ts`.
- **The terminal message is the latest PLAIN-TEXT assistant reply.**
  The claim RPCs' terminal lateral skips assistant rows with tool
  calls or empty content, so a conversation whose tail is tool-call
  rounds anchors at the last plain reply - the tail is invisible to
  the wiki agents until a later normal reply lands. By design
  (tool-call rounds without closing text carry little), but it fools
  eligibility replicas: an audit that picks "newest assistant
  message" will see phantom backlog that the real predicate
  correctly excludes.
- **Cron run history detaches on every deploy.** The schema sync
  re-registers the pg_cron jobs, minting new jobids;
  `cron.job_run_details` rows stay keyed to the OLD jobid, so
  per-job queries show an empty history right after a deploy. When
  auditing sweep health, query `cron.job_run_details` by command
  text (`where command ilike '%wiki%'`), not by jobid.
- **`wiki_agent_log` is the durable health surface.** The
  changelog only records cycles that CHANGED something; most cycles
  are no-ops whose reasoning previously evaporated with the 24h
  edge logs. The audit log rows (one per completed cycle, reasoning
  included) are what a "is the feature healthy / why didn't it
  write about X" analysis queries. Best-effort writes: a lost row
  is acceptable, so don't build anything on its completeness -
  pointer state on `threads` remains the source of truth for
  what was processed.

## Verification

End-to-end manual smoke test:

1. `mise run sync` against a dev Supabase. Confirm `wiki_articles`,
   the trigger, the wiki RPCs (claim / mark / failure / skipped-list
   / compute-terminal / manual-advance / `nak_safe_timezone` /
   `nak_trigger_wiki_sweep`), the librarian RPCs
   (`claim_next_user_for_wiki_librarian`, the in-flight guard pair,
   `nak_trigger_wiki_librarian_sweep`), the `threads` and `profiles`
   columns, the "agent-run channel: owner subscribe" policy, and the
   `supabase_realtime` membership land. Re-run for idempotency.
2. **Drawer alphabetical sort.** Add "Zebra", "Apple", "Mango" via
   the panel. Tab reads Apple, Mango, Zebra (server `title ASC`,
   paged in by `listWikiArticlesPage`).
3. **Infinite scroll.** With more than one page of articles, scroll
   the drawer to the bottom and confirm the next page loads
   automatically (no duplicate or skipped rows at the seam).
4. **Search.** Type "ze" -> "Zebra" only. Clear -> alphabetical
   browse list returns.
5. **Create / edit / delete** round-trip via the panel. The drawer
   reflects each change via `WIKI_CHANGE_EVENT`.
6. **Ask agent to update - preview / accept / cancel / try again.**
   Open an article, type instructions -> preview populates with the
   agent's `reason` rendered above the body -> Accept persists and
   writes a changelog row using the agent's `reason` as the message;
   Cancel dismisses; Try again regenerates.
7. **Changelog page.** Open the Wiki tab with no article selected.
   The panel renders the user's create/update/delete history
   newest-first, kind chips visible. Click an Edit/Add entry's
   title -> the article opens in the same panel. Delete-kind titles
   are non-interactive. "Load more" appends the next 50 rows; the
   button hides once the tail is reached.
8. **Required commit messages.** The direct create / edit / delete
   strips on the Wiki panel all require a one-line change message
   before the destructive action enables; the function-side tools
   enforce the same via the `message` parameter on each schema.
9. **Sweep fires the day after.** With `mise run dev-start` (the dev
   shim ticks `/wiki-sweep`): a thread whose newest message is today
   is not claimed; a thread whose newest message is yesterday-in-tz
   gets picked up, the shim prints a non-zero `processed` count,
   articles land, and `last_wiki_processed_msg_id` advances. The
   Logs drawer shows the `wiki`-tagged pickup / finished lines.
10. **Eligibility re-opens after continuation.** New message in that
    thread today -> the sweep skips it again until tomorrow.
11. **Realtime refresh.** With the Wiki tab open, let the sweep (or
    a manual `curl` to `/wiki-sweep` with the service-role key)
    write an article. The open panel refreshes without a reload -
    the `wiki_articles` subscription fired `emitWikiChange`.
12. **Skipped-panel retry.** On a thread carrying a skip marker,
    click Retry. The row shows the tool-call count + reasoning, and
    the marker clears (row drains) on success; on failure the error
    renders inline and the marker stays.
13. **Manual librarian run.** Sparkles button -> confirmation strip;
    Run -> the live step list populates while the run executes
    server-side ("Loading N articles", thinking rounds, tool rows
    carrying the model's `activity` narration), then the result
    paragraph renders the final text and the changelog gains one row
    per edit. The Logs drawer shows the `wiki-librarian`-tagged
    lines.
14. **Librarian busy collision.** While a manual run is in flight,
    start a second one (another tab, or ask the chat to dispatch
    `wiki_librarian`) - the second surfaces the busy / try-again
    message instead of running concurrently.
15. **Scheduled librarian sweep.** With `mise run dev-start` (the
    shim ticks `/wiki-librarian-sweep`): an eligible user (toggle
    on, stale or null `wiki_librarian_last_run_at`, at least 3
    articles) gets a `reviewed` outcome with a tool-call count; a
    freshly-stamped user yields `no-user` on the next tick.
16. **Recall tool.** Ask the chat "what do you know about my green
    tea preference?" - the model issues `wiki_search` and grounds
    its answer.
17. **Embeddings filled.** New article -> `embedding is null`
    initially, populates after the next backfill tick.
18. **Settings toggles.** Disable "Automatic wiki" -> the wiki sweep
    claims nothing for this user; disable the librarian toggle ->
    the librarian sweep's claim skips them. Enable -> resumes. No
    worker starts or stops; both are plain settings writes read by
    the server-side claim predicates.
19. `mise run check` green; no `(!)` build warnings or
    `plugin:vite:reporter` chunking warnings introduced.
