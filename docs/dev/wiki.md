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
  paths mutually exclusive. No wiki feature code runs in the browser
  except the Wiki UI itself and the manual `updateOne` flow.

Both agents share the encyclopedic-third-person voice and the
"preserve facts unless explicitly contradicted" discipline.

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
  that mirrors `MAX_WIKI_CHANGELOG_MESSAGE_CHARS`) plus append-only
  RLS (select + insert only, no update/delete) and a
  `(user_id, created_at desc)` index for the panel's cursor-paged
  listing. `reset_wiki_data` clears `wiki_changelog` alongside
  `wiki_articles` so a wipe leaves no orphan history.
- Embeddings RPCs: `claim_next_pending_wiki_article`,
  `save_wiki_article_embedding_if_claimed`,
  `search_wiki_articles_by_embedding`.

Edge function (`supabase/functions/venice/`):

- `agents/wiki.ts` - the autonomous agent. Exports
  `runWikiSweepTick` (cron path) and `retryWikiThread` (user path).
  Owns the autonomous prompt (`buildWikiAutonomousPrompt` plus the
  "About the user" profile block, read fresh from
  `profiles.settings.userName` / `userLocation` per run), the wiki
  tool wire schemas, `buildWikiToolbox`, the content-filter sentinel
  and fallback constants, and the per-run tunables: model
  `deepseek-v4-flash` (hardcoded mirror of `agentModel('wiki')` -
  `AGENT_MODELS` is a static role->model map, not a per-user tier),
  fallback `arcee-trinity-large-thinking`, `reasoningEffort:
  'medium'`, claim TTL 600s, failure cap 3, sweep bound 3
  threads/tick. Test-only invariants exported via `__test`.
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
  stay narration-free).
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
  `POST /wiki-retry` and `POST /wiki-librarian-run` (user JWT; the
  gateway-validated id scopes every RPC). The librarian-run route
  takes `{ instructions, runId }`, builds the progress publisher
  when a runId is present (capped at 64 chars - an opaque demux key,
  not identity), and awaits `publisher.flush()` before responding so
  the `done` event can't be dropped behind the response body.
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
  `subscribeToWikiArticleChanges` (user-scoped `postgres_changes`
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
- `src/lib/tools/wiki_librarian.schema.ts` + the `wikiToolbox`
  entry in `src/lib/tools/index.ts` - the main-chat delegation
  surface (see "Tool toolbox split" below).

Browser agents:

- `src/lib/agents/wiki/agent.ts` - the `WikiAgent` class, which owns
  only the manual flow: `updateOne()` for the per-article "Ask agent
  to update" preview. Single Venice completion, `response_format`
  pinned to JSON, no tool loop. Logger source `wiki-manual`.
- `src/lib/agents/wiki/prompt.ts` - `buildWikiManualPrompt({
  userProfile })` plus the `WikiUserProfile` type. Folds an "About
  the user" block into the prompt when the profile carries a name or
  location (Settings -> AI -> About you). The autonomous prompt is a
  separate copy living with its agent in
  `supabase/functions/venice/agents/wiki.ts`; the two share the
  encyclopedic voice and the anti-name-fabrication rules but differ
  in framing (autonomous reads a conversation and decides per-topic;
  manual applies explicit instructions to one article). The
  librarian has no browser agent code at all - its prompt and runner
  live entirely in `supabase/functions/venice/agents/wiki_librarian.ts`.

Model registry:

- `src/lib/models/index.ts` - `AgentRole` includes `'wiki'` and
  `'wikiLibrarian'`; `AGENT_MODELS.wiki` and
  `AGENT_MODELS.wikiLibrarian` both pinned to `deepseek-v4-flash`
  (rationale documented inline above the table). The manual flow
  resolves `agentModel('wiki')` at runtime; the edge agents hardcode
  the mirror constants `WIKI_MODEL` (agents/wiki.ts) and
  `WIKI_LIBRARIAN_MODEL` (agents/wiki_librarian.ts) - keep them in
  sync with the registry.

Main-thread plumbing:

- `src/lib/state.svelte.ts` - no wiki workers or managers at all;
  both wiki agents run server-side. `app.wikiAutomaticEnabled` and
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
- `src/lib/chat-prompt.ts` - `WIKI_BLOCK` after `JOURNAL_BLOCK` in
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
  would write; Accept passes it through. When no article is selected
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
  **Librarian strip.** The manual run is subscribe-then-POST: the
  strip mints a `runId`, subscribes via
  `SupabaseService.subscribeToAgentRunProgress` filtering events on
  that id, then POSTs through `SupabaseService.runWikiLibrarian`.
  While the run executes server-side, the step events (preparing /
  thinking / tool / done; tool events carry the model-emitted
  `activity` narration) render as a live step list with a spinner on
  the pending row. A `busy` result (the shared server-side in-flight
  guard) renders a try-again message; an `ok` result fires
  `emitWikiChange` locally so the panel refreshes ahead of the
  realtime echo.
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
  of `$lib/markdown`).
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
  librarian button has no preemptive busy gray-out: the browser has
  no live view of the scheduled sweep or a chat-dispatched run, so
  the server-side in-flight guard's `busy` result is the collision
  surface instead.
- `src/screens/Settings.svelte` - the "Wiki" group with the
  `wikiAutomaticEnabled` and `wikiLibrarianEnabled` toggles.

Tests:

- `supabase/functions/tests/wiki.test.ts` - the safety-critical
  composition guards: toolbox membership (wiki CRUD + read-only
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
- `WikiAgent.updateOne({ articleId, currentTitle, currentContent,
  userInstructions, signal })` - the main-thread per-article manual
  entry. Single Venice completion with
  `response_format: {type: 'json_object'}`, no tool loop. Returns
  `{ kind: 'preview', title, content, reason }` or
  `{ kind: 'noop', reason }`.
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
  (`arcee-trinity-large-thinking` per
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
`CONTENT_FILTER_FALLBACK_MODEL` (`arcee-trinity-large-thinking`,
which does not run the same input classifier). Only the
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

The Skipped panel's Retry button bypasses the sweep and the claim
protocol entirely. The browser side is a thin authenticated POST
(`SupabaseService.retryWikiThread` -> `/wiki-retry`); the whole
cycle runs server-side in `retryWikiThread`:

1. `compute_wiki_terminal_msg_id(threadId, userId)` resolves the
   same anchor the sweep's claim RPC would have picked. Null (no
   assistant message to process) returns `kind: 'no-op'`.
2. `runWikiAgentOnThread` runs the primary -> fallback two-shot. The
   wiki tools commit their writes immediately, so any tool-call side
   effects land regardless of what happens next.
3. On success, `manual_advance_wiki_pointer(threadId, msgId,
   userId)` clears the skip marker and advances
   `last_wiki_processed_msg_id`. This bypasses the claim guard
   `mark_thread_wiki_processed_if_claimed` uses - the manual button
   never went through the claim protocol, so requiring a claim would
   block it. The RPC is scoped to the owning user (`auth.uid()` or
   the gateway-validated id the service-role caller passes).
4. On error, the skip marker is left in place. The user sees the
   failure inline on the row and can retry again.

The route responds with the `WikiRetryResult` union -
`{ kind: 'ok', terminalMsgId, toolCalls, reasoning }` /
`{ kind: 'no-op', reason }` / `{ kind: 'error', error }`.
Agent-level failures are an application outcome (`kind: 'error'`),
not a transport error, so the panel renders them without sniffing
status codes; only transport/auth failures throw on the browser
side. `SupabaseService.retryWikiThread` boundary-validates the shape
and collapses anything unrecognised to an error result.

The worst-case race (a sweep claims the thread mid-retry) just means
two agent runs whose tool-level writes are idempotent at the
contract level - `wiki_create` collides on the unique title and
falls through to `wiki_update`.

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
and flushes in its `finally`); the browser-side manual article flow
logs as `wiki-manual`.

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

Two distinct flows, two distinct homes:

| Aspect      | Autonomous (edge)   | Manual (`updateOne`) |
| ----------- | ------------------- | -------------------- |
| Runs in     | venice function     | Browser main thread  |
| Trigger     | Cron / Retry button | User clicks button   |
| Inputs      | Whole conversation  | One article + instructions |
| Tools       | Yes (`buildWikiToolbox`) | No              |
| Output      | Tool side effects   | JSON preview         |
| Persistence | Tool calls write    | UI persists on Accept |
| Prompt      | `buildWikiAutonomousPrompt` (edge) | `buildWikiManualPrompt` (browser) |

Both run `deepseek-v4-flash` and share the encyclopedic-third-person
voice, the "preserve facts unless explicitly contradicted"
discipline, and the anti-name-fabrication profile rules. They differ
on scope (whole wiki vs one article), input shape (conversation vs
explicit instructions), and output shape (tool calls vs JSON).

### Tool toolbox split

- `alwaysOnToolbox` (browser, `src/lib/tools/index.ts`) includes the
  read surfaces - `wiki_search` (semantic + substring), `wiki_list`
  (alphabetical projection with head-of-content excerpts), `wiki_get`
  (primary-key body fetch), and `wiki_recall` (sub-agent that
  synthesises a topic note). All four ride every chat request; reads
  are idempotent and cheap, and the wiki blurb in the system prompt
  tells the model which one to reach for in which case.
- `wikiToolbox` (browser, main-chat registry) is the gated toolbox
  the chat model toggles to call `wiki_librarian` - a server-side
  sub-agent that lets the model delegate maintenance work (merge /
  split / delete / rewrite) inside the conversation. The model never
  gets `wiki_create` / `wiki_update` / `wiki_delete` directly; every
  chat-driven edit goes through the librarian's
  read-everything-then-plan loop.
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

## Interactions

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
  librarian's (`nak_trigger_wiki_librarian_sweep`) to minute 37.
- **Logging** (`docs/dev/logging.md`) - the agents' edge loggers
  relay to the in-app Logs drawer over the `logs:<userId>`
  Broadcast channel; drawer source tags `wiki` (autonomous agent),
  `wiki-librarian` (librarian, all three paths), `wiki-manual`
  (browser manual flow). The librarian's manual run additionally
  publishes live step events over the sibling `agent-runs:<userId>`
  Broadcast topic (`_shared/agent-progress.ts`), which follows the
  same transport + flush-before-respond contract as the log relay.
- **Chat / tools** (`docs/dev/chat.md`, `docs/dev/tools.md`) -
  `wiki_search` and the other read tools are always-on in every chat
  request; the gated `wikiToolbox` delegates writes to the
  `wiki_librarian` sub-agent.
- **Edge function auth** (`docs/dev/edge-function-auth.md`) - the
  venice function is b-strict: `/wiki-sweep` and
  `/wiki-librarian-sweep` are gated on `isServiceRole`;
  `/wiki-retry` and `/wiki-librarian-run` on the gateway-validated
  user JWT. `claim_next_user_for_wiki_librarian` is a SECURITY
  DEFINER global sweep locked to `service_role`; the in-flight guard
  pair carries the `coalesce(p_user_id, auth.uid())` b-strict escape
  hatch; and every wiki tool / helper / RPC carries explicit
  `user_id` scoping because the service-role client bypasses RLS.
- **Settings** (`docs/dev/settings.md`) - the `wiki` group exposes
  the two toggles, both consumed server-side by claim predicates:
  `wikiAutomaticEnabled` by the wiki sweep, `wikiLibrarianEnabled`
  by the librarian sweep. `displayTimezone` (owned by the journal
  pane) is consumed server-side by the day-gate.
- **Local stack** (`docs/dev/local-stack.md`) - no pg_cron / pg_net
  locally; `scripts/dev-backfill-cron.mjs` ticks `/wiki-sweep` and
  `/wiki-librarian-sweep` alongside `/backfill`.

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
- **No preemptive busy gray-out on the librarian button.** The
  in-flight guard lives on profiles, server-side, and the browser
  has no live view of the scheduled sweep or a chat-dispatched run -
  so the top-bar sparkles button stays enabled and a collision
  surfaces as the guard's `busy` result with a try-again message in
  the strip. A client-side gray-out could only cover runs this tab
  started and would imply a safety the server guard already
  provides.
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
  manual prompt and is load-bearing for the trust contract with the
  user. Reviewer note: a future change that broadens the prompt to
  "make it better" would silently rewrite parts the user wanted left
  alone.
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
- **Two prompt copies, two pairs of model constants.** The manual
  prompt (browser) and the autonomous prompt (edge) live in
  different runtimes and cannot share an import; same for
  `agentModel('wiki')` / `agentModel('wikiLibrarian')` vs the edge
  mirrors `WIKI_MODEL` / `WIKI_LIBRARIAN_MODEL`, and the char caps
  in `src/lib/wiki.ts` vs the mirrors in the function tools. A
  change to the voice rules, the anti-name-fabrication block, a
  model pin, or the caps has to land on both sides. (The librarian
  prompt itself has a single copy - it lives only in
  `agents/wiki_librarian.ts`.)
- **`embedding_claim_expires` (no `_at`).** Schema convention for
  the embedding-side claim columns matches memories and
  journal_entries. The thread-side claim columns
  (`wiki_claim_expires_at`) DO have the suffix, matching
  `journal_claim_expires_at`. Easy to flip when cloning; both are
  canonical.

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
