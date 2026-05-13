# Wiki

Flat encyclopedic articles about the user. A fourth peer to chats,
memories, and journal entries. The user authors articles directly
through the Wiki drawer tab; two distinct background agents keep them
healthy:

- The **per-conversation wiki agent** reads settled threads a day
  after the newest message and updates / creates articles based on
  topics that came up.
- The **wiki librarian** runs every 12 hours, reads the wiki as a
  whole, and consolidates duplicates / fact-checks claims against
  conversation history. It cannot create new articles; only update
  and delete. Cross-device coordination via an atomic claim RPC
  (`claim_wiki_librarian_run`).

Both agents share the encyclopedic-third-person voice and the
"preserve facts unless explicitly contradicted" discipline.

## Role

Three knowledge surfaces with deliberately different shapes:

- **Memory** (`docs/dev/memory.md`) - atomic labelled facts, surfaced
  inline by the chat-loop's opening recall.
- **Journal** (`docs/dev/journal.md`) - dated reflective prose, with
  today's automatic entry included in the opening-turn system prompt.
- **Wiki** (this doc) - longer-form encyclopedic articles, **never
  auto-injected** into the chat. The main LLM reaches them only
  through the always-on `wiki_search` tool.

Articles are titled, single-level (no nesting), and unique per
`(user_id, title)`. The voice is encyclopedic third-person prose -
intentionally different from chat-style or journal-reflective
registers.

## Files

Schema:

- `supabase/schema.sql` - the "User Wiki" block defines
  `wiki_articles`, the `clear_wiki_embedding_on_change` trigger,
  RLS policies, three new `threads` columns
  (`last_wiki_processed_msg_id`, `wiki_claim_holder`,
  `wiki_claim_expires_at`), and five RPCs:
  `claim_next_thread_for_wiki`,
  `mark_thread_wiki_processed_if_claimed`,
  `claim_next_pending_wiki_article`,
  `save_wiki_article_embedding_if_claimed`,
  `search_wiki_articles_by_embedding`.
  Plus, for the librarian: a new `profiles.wiki_librarian_last_run_at`
  column and an atomic-claim RPC `claim_wiki_librarian_run(int)`
  that returns true at most once per `min_interval_seconds` across
  all devices.
  Plus, for the changelog: a `wiki_changelog` table (one row per
  create/update/delete; `article_id` is `on delete set null` so a
  deleted article doesn't take its history with it; `title_at_change`
  snapshot keeps the row readable when `article_id` is nulled;
  `message` has a column-level `char_length` between 1 and 200
  CHECK that mirrors `MAX_WIKI_CHANGELOG_MESSAGE_CHARS`) plus
  append-only RLS (select + insert only, no update/delete) and a
  `(user_id, created_at desc)` index for the modal's cursor-paged
  listing. `reset_wiki_data` clears `wiki_changelog` alongside
  `wiki_articles` so a wipe leaves no orphan history.

Data layer (main thread + workers):

- `src/lib/supabase.ts` - `WikiArticle` interface,
  `coerceWikiArticle`, plus the `SupabaseService` methods:
  `listWikiArticles`, `getWikiArticleById`, `getWikiArticleByTitle`,
  `createWikiArticle`, `updateWikiArticle`, `deleteWikiArticle`,
  `searchWikiArticles`, `claimNextThreadForWiki`,
  `markThreadWikiProcessedIfClaimed`,
  `claimNextPendingWikiArticle`, `saveWikiArticleEmbedding`. The
  `UserSettings` interface gains `wikiAutomaticEnabled?: boolean`.
  For the changelog: `WikiChangelogKind` union,
  `WikiChangelogEntry` interface, `coerceWikiChangelogEntry`
  helper, plus the `createWikiChangelogEntry` (append) and
  `listWikiChangelog({ limit, before })` (cursor-paged listing)
  methods.
- `src/lib/wiki.ts` - the search helper
  (`searchWikiArticlesSemantic`) plus the `MAX_WIKI_TITLE_CHARS`
  (200), `MAX_WIKI_CONTENT_CHARS` (16000), and
  `MAX_WIKI_CHANGELOG_MESSAGE_CHARS` (200) ceilings.
- `src/lib/wiki-store.svelte.ts` - the shared `wikiStore`,
  `runWikiSearch`, and the `patchWikiRow` / `removeWikiRow` /
  `addWikiRow` mutators the panel and tools call.
- `src/lib/wiki-events.ts` - the `WIKI_CHANGE_EVENT` window-event
  bus parallel to `journal-events.ts` / `cookbook-events.ts`.

Tools:

- `src/lib/tools/wiki_search.{schema.,}ts` - the always-on recall
  tool (registered in `src/lib/tools/index.ts`'s
  `alwaysOnToolbox`).
- `src/lib/tools/wiki_create.{schema.,}ts`,
  `wiki_update.{schema.,}ts`, `wiki_delete.{schema.,}ts` - the
  agent-only write tools. Each takes a required `message` param
  (the git-commit-style one-line summary that lands in the wiki
  changelog) and appends a `wiki_changelog` row via
  `supabase.createWikiChangelogEntry` after the underlying
  mutation. Best-effort logging: a failed changelog write does
  not roll back the mutation that already succeeded.
- `src/lib/tools/wiki_toolbox.ts` - the per-conversation agent's
  toolbox; bundles wiki search/create/update/delete plus
  read-only `memory_search` so the agent can ground article
  content in atomic facts the reflection agent has already
  extracted (people, projects, preferences). Lazy-loaded
  schemas. Parallel to `memory_toolbox.ts`.
- `src/lib/tools/wiki_librarian_toolbox.ts` - the librarian's
  toolbox; bundles wiki_search + wiki_update + wiki_delete +
  conversation_search + memory_search. **No wiki_create** and
  no memory writes - the librarian consolidates / fact-checks
  read-only.

Embeddings:

- `src/lib/embeddings/sources/wiki.ts` - the `EmbeddingSource`
  adapter. The generic worker (`src/lib/embeddings/worker.ts`)
  picks it up alongside memories, threads, samskara substrate, and
  journal entries.

Per-conversation autonomous agent:

- `src/lib/agents/wiki/types.ts` - `WikiInput`, `WikiOutput`.
- `src/lib/agents/wiki/prompt.ts` -
  `buildWikiAutonomousPrompt({ userProfile })` and
  `buildWikiManualPrompt({ userProfile })`, plus the shared
  `WikiUserProfile` type. Both builders fold an "About the user"
  block into the prompt when the profile carries a name or
  location (Settings -> AI -> About you). The autonomous prompt
  biases hard toward "update over create" - the historical
  failure mode was one new article per conversation; the prompt
  opens with an explicit rule that update is the default and
  create is rare, and workflow step 1 mandates at least two
  different wiki_search angles before considering wiki_create.
  Both prompts also encourage `memory_search` to ground article
  content in atomic facts the reflection agent has already
  extracted.
- `src/lib/agents/wiki/agent.ts` - the `WikiAgent` class. Two
  entry points: `run()` for the worker path and `updateOne()` for
  the main-thread per-article manual flow.
- `src/lib/agents/wiki/loop.ts` - cycle driver (acquire ->
  claim -> run -> mark).
- `src/lib/agents/wiki/worker.ts` - Web Worker entry point.
  Lease partition `'wiki'`.
- `src/lib/agents/wiki/manager.ts` - `BaseWorkerManager`
  subclass. Lock name `nak:wiki-worker`, logger source
  `wiki-worker`. Bubbles `progress: 'processed'` to
  `emitWikiChange()`.

Librarian:

- `src/lib/agents/wiki-librarian/types.ts` -
  `WikiLibrarianInput` (a snapshot of all articles - id, title,
  excerpt), `WikiLibrarianOutput`, plus tunables
  `LIBRARIAN_EXCERPT_CHARS = 400` and `LIBRARIAN_MIN_ARTICLES = 3`.
- `src/lib/agents/wiki-librarian/prompt.ts` - `buildWikiLibrarianPrompt`
  takes the rendered article list and embeds it into a system
  prompt that frames the agent as a librarian (consolidate,
  fact-check, tighten boundaries; no wiki_create access).
- `src/lib/agents/wiki-librarian/agent.ts` - the
  `WikiLibrarianAgent` class. `run()` reads the snapshot from
  input, builds the prompt, runs `runHeadlessToolLoop` against
  `wikiLibrarianToolbox`. No per-thread context; threadId in the
  ToolContext is set to the empty string (the wiki tools and
  conversation_search both ignore it - they're scoped by RLS on
  user_id).
- `src/lib/agents/wiki-librarian/loop.ts` - different cycle shape
  from the per-conversation loop. No claim of a thread; instead
  acquires the lease, then calls `claimWikiLibrarianRun` to gate
  on the cross-device interval, then snapshots
  `listWikiArticles({limit: 500})` and either runs the agent or
  bails on `too-soon` / `too-small`.
- `src/lib/agents/wiki-librarian/worker.ts` - Web Worker entry
  point. Lease partition `'wiki-librarian'`.
- `src/lib/agents/wiki-librarian/manager.ts` - `BaseWorkerManager`
  subclass. Lock name `nak:wiki-librarian-worker`, logger source
  `wiki-librarian-worker`. Defaults to 12h min-interval and a 1h
  idle nap; bubbles `progress: 'reviewed'` to `emitWikiChange()`.

Model registry:

- `src/lib/models/index.ts` - `AgentRole` adds `'wiki'` and
  `'wikiLibrarian'`; `AGENT_MODELS.wiki` and
  `AGENT_MODELS.wikiLibrarian` both pinned to
  `deepseek-v4-flash` (same family as journal/reflection;
  rationale documented inline above the table).

Main-thread plumbing:

- `src/lib/state.svelte.ts` - lazy-imports both managers,
  `app.wikiAutomaticEnabled` + `app.wikiLibrarianEnabled`,
  `setWikiAutomaticEnabled` / `persistWikiAutomaticEnabled` /
  `setWikiLibrarianEnabled` / `persistWikiLibrarianEnabled`. Both
  toggles are independent in `applyServerSettings`,
  `startBackgroundWorkers`, and `lock()`.
- `src/lib/routing.svelte.ts` - extends `DrawerTab` with
  `'wiki'` and `Route` with `wiki_article_id`.
- `src/lib/chat-prompt.ts` - `WIKI_BLOCK` after `JOURNAL_BLOCK`
  in the section list.

UI:

- `src/components/WikiList.svelte` - drawer listing. Search
  input + alphabetical sort.
- `src/screens/Wiki.svelte` - main-panel article view, edit
  form, create form, delete confirmation, and the "ask agent
  to update" preview/accept/cancel flow. Each direct-edit flow
  carries a required one-line change-message input that lands
  in the wiki changelog after the mutation. The "ask agent to
  update" preview surfaces the agent's `reason` field as the
  changelog entry it would write; Accept passes it through.
- `src/screens/WikiChangelog.svelte` - the changelog modal
  itself. Cursor-paged list (`listWikiChangelog`); kind chips
  (Added/Edited/Deleted), per-entry article link when the
  article still exists, plain title snapshot for deletes.
  Lazy-loaded from `Chat.svelte` on `route.modal ===
  'wiki-changelog'`. Listens on `onWikiChange` so a write that
  happens while the modal is open refreshes the first page.
- `src/screens/Chat.svelte` - new tab, drawer branch,
  main-panel branch, top-bar branch, change-event listener.
  Top-bar branch carries the `librarian-run-btn` (sparkles)
  next to the `wiki-changelog-btn` (clock); the latter
  navigates to `modal: 'wiki-changelog'`. Lazy-import effect
  for `WikiChangelog.svelte` parallels the other modal
  components.
- `src/screens/Settings.svelte` - new "Wiki" group with the
  `wikiAutomaticEnabled` toggle.

Docs:

- `docs/user/wiki.md` (this feature's user-facing manual).
- `docs/dev/wiki.md` (this file).

## Entry points

- `wikiManager.start({ supabase, config, timezone, userName,
  userLocation })` - called from
  `state.svelte.ts:startBackgroundWorkers` when
  `app.wikiAutomaticEnabled === true`. Spawns the worker
  inside the `nak:wiki-worker` cross-tab Web Lock. Profile
  fields are forwarded to the agent and live-updated on
  Settings edits via `setProfile()`.
- `WikiAgent.run({ input: { threadId, terminalMsgId }, ... })`
  - the worker's per-cycle entry. Slices thread history at
  `terminalMsgId`, appends the user-turn rendered by
  `buildWikiAutonomousPrompt` (with the agent's current
  profile) as the
  final user turn, runs `runHeadlessToolLoop` against
  `wikiToolbox`. Side effects (the `wiki_*` tool calls) ARE
  the persistent output; the model's final text is a one-or-
  two-sentence operator-facing summary of its choices ("Updated
  Nak article with March 2026 logo details" / "No edits -
  generic Q&A with no user-centric subject") that the cycle
  driver inlines as `reasoning="..."` on the finished-thread
  log line, matching the journal worker's shape. The prompt's
  "Final reply" block instructs the model to surface both
  decisions made and decisions skipped (e.g. why a topic that
  came up was deliberately NOT given its own article), so a
  human skimming the log drawer can see WHY a cycle was a no-op
  without having to re-read the conversation.
- `WikiAgent.updateOne({ articleId, currentTitle,
  currentContent, userInstructions, signal })` - the
  main-thread per-article manual entry. Single Venice
  completion with `response_format: {type: 'json_object'}`,
  no tool loop. Returns `{ kind: 'preview', title, content }`
  or `{ kind: 'noop', reason }`.
- `wiki_search` tool - registered in
  `alwaysOnToolbox.tools` so every chat request can reach
  it without a toolbox toggle.

## Data model

`wiki_articles`:

- `id uuid pk default gen_random_uuid()`
- `user_id uuid not null references auth.users on delete cascade`
- `title text not null`
- `content text not null`
- `embedding vector(2048)` - padded by the generic embeddings
  worker, same shape as memories and journal entries.
- `embedding_model text`, `embedding_claim_holder text`,
  `embedding_claim_expires timestamptz` - same claim-protocol
  columns as memories and journal entries (note: `_expires`
  not `_expires_at`, matching the existing convention).
- `created_at`, `updated_at timestamptz default now()`
- `unique (user_id, title)` - the agent's `wiki_create` tool
  surfaces a unique-violation as actionable text so the
  autonomous agent reads the conflict and falls through to
  `wiki_search` + `wiki_update`.
- Index `(user_id, lower(title))` for the alphabetical drawer
  listing.
- Trigger `clear_wiki_embedding_on_change` nulls the embedding
  and claim columns on title or content change; the embedding
  worker re-embeds on its next poll.

`threads` extension columns:

- `last_wiki_processed_msg_id uuid references messages(id) on
  delete set null` - pointer the autonomous agent advances
  after each cycle.
- `wiki_claim_holder text`, `wiki_claim_expires_at timestamptz`
  - per-thread claim columns (note: `_at` suffix here, matching
  the existing journal claim columns).

These are independent of the memory-reflection
(`last_reflected_msg_id`) and journal
(`last_journaled_msg_id`) pointers. All three workers can run
concurrently against the same thread.

### Eligibility predicate

`claim_next_thread_for_wiki` differs from
`claim_next_thread_for_journal` in two specific ways:

1. **Newest-message lateral.** The journal RPC reads
   `threads.updated_at` for the cooldown bucket. The wiki RPC
   reads the newest message's `created_at` directly via a
   second lateral. Both columns move on every insert, but
   reading from messages.created_at is more honest about
   "when did the conversation actually last move" - a future
   bump to threads.updated_at from an unrelated write would
   shift the gate.
2. **Strict-yesterday gate.** The eligibility predicate is
   `(newest.created_at at time zone p_timezone)::date <
   (now() at time zone p_timezone)::date` - newest message
   must land on a calendar day strictly before today in the
   user's tz. Effect: chat Monday -> eligible Tuesday; user
   resumes Wednesday -> the new newest msg lands on Wednesday
   and the inequality fails again until Thursday.

Same depth guard (>= 2 user messages) and `for update of t
skip locked` fairness as the journal RPC.

## Contracts

### Claim/mark atomicity

The autonomous agent's loop is:

1. `claimNextThreadForWiki(holderId, ttl, tz)` - returns
   `{ threadId, terminalMsgId, title, newestMsgAt }` or null.
2. `WikiAgent.run({ ... })` - tool calls are the side effects.
3. `markThreadWikiProcessedIfClaimed(threadId, holderId,
   terminalMsgId)` - returns true on success, false on
   claim-lost.

Mark is **unconditional on `done`**. Even a no-op cycle
(agent decided no topic warranted a wiki update) advances the
pointer so the same conversation isn't re-processed every
cycle. New turns added later trigger eligibility again via
the next-day predicate.

This differs from the journal flow, which uses an atomic
`upsert_journal_entry_and_mark_thread` RPC because the entry
write and the pointer advance must happen in lockstep. The
wiki agent's writes are independent tool calls landing
through the main `wiki_create`/`wiki_update`/`wiki_delete`
RPCs - those rows are owned by the user, not the claim, so a
claim-lost during the cycle leaves any already-landed writes
intact and just drops the pointer-advance for that cycle.
The next claim will reprocess the conversation.

### Embedding pipeline

`wiki_articles.embedding` is populated by the generic
embeddings worker. Its source adapter
(`src/lib/embeddings/sources/wiki.ts`) builds the input
string as `${title}\n\n${content}` (mirroring memories'
label-and-data shape), truncates content to
`MAX_WIKI_CONTENT_CHARS = 16000`, and calls
`claimNextPendingWikiArticle` / `saveWikiArticleEmbedding`.

The same `text-embedding-bge-m3` model and 2048-dim padded
vectors as memories and journal entries.

### Autonomous vs manual agent split

Two distinct flows share the `WikiAgent` class:

| Aspect      | Autonomous (`run`) | Manual (`updateOne`) |
| ----------- | ------------------ | -------------------- |
| Runs in     | Web Worker         | Main thread          |
| Trigger     | Day-after thread   | User clicks button   |
| Inputs      | Whole conversation | One article + instructions |
| Tools       | Yes (`wikiToolbox`) | No                   |
| Output      | Tool side effects  | JSON preview         |
| Persistence | Tool calls write   | UI persists on Accept |
| Prompt      | `WIKI_AUTONOMOUS_PROMPT` | `WIKI_MANUAL_PROMPT` |

Both share `agentModel('wiki').id` (deepseek-v4-flash), the
encyclopedic-third-person voice, and the "preserve facts
unless explicitly contradicted" discipline. They differ on
scope (whole wiki vs one article), input shape (conversation
vs explicit instructions), and output shape (tool calls vs
JSON).

### Tool toolbox split

- `alwaysOnToolbox` includes only `wiki_search`. The main
  LLM never gets a path to write to the wiki - that's the
  spec's "articles are never auto-injected; recall is
  pulled, never pushed" stance applied symmetrically.
- `wikiToolbox` (in `src/lib/tools/wiki_toolbox.ts`) bundles
  search + create + update + delete for the autonomous
  agent. The agent receives delete because consolidation
  (subsuming a stale duplicate into another article it just
  updated) is a legitimate wiki-maintenance operation. The
  prompt explicitly forbids deleting on the basis of "the
  user said something different today" alone.

## Interactions

- **Memory** (`docs/dev/memory.md`) - the wiki's embedding
  shape, claim-protocol columns, and "polymorphic adapter"
  worker pattern are clones of memories. Both feature docs
  reference the canonical adapter contract in
  `embeddings.md`.
- **Journal** (`docs/dev/journal.md`) - the wiki's manager,
  worker, loop, and `wikiAutomaticEnabled` setting all clone
  the journal subsystem's shape. The eligibility predicate
  in `claim_next_thread_for_wiki` is the deliberate
  divergence; the rest is parallel structure. Both share the
  user's `journalTimezone` preference.
- **Embeddings** (`docs/dev/embeddings.md`) - the generic
  worker now polls four (now five) sources in round-robin:
  memories, threads, samskara substrate, journal entries,
  wiki articles. Adding a source is a one-line append to
  `worker.ts`'s sources array plus a new file under
  `sources/`.
- **Chat-prompt** (search `WIKI_BLOCK` in
  `src/lib/chat-prompt.ts`) - the WIKI_BLOCK paragraph names
  the wiki and the recall tool but stays short, since the
  framing is "articles are pulled, never pushed".
- **Settings** (`docs/dev/settings.md`) - the `wiki` group
  exposes only the toggle. The journal pane owns the
  user-tz preference, which the wiki shares.

## Gotchas

- **The wiki is user-centric, not a general encyclopedia.** The
  per-conversation prompt has historically slipped on this - a
  brainstorm about app naming that mentioned the 1980s "Kermit"
  protocol produced a standalone "Kermit protocol" article. Both
  the per-conversation prompt and the librarian prompt now carry
  an explicit scope block (IN: projects, people, places,
  learning, work, hobbies, experiments / OUT: generic technical
  concepts, world history, public figures the user does not
  know, tutorials). The librarian's workflow step 1 is "delete
  out-of-scope articles", deliberately ahead of duplicate
  consolidation so it doesn't tidy two off-topic articles into
  one off-topic article. External topics referenced inside a
  user-centric article get a Markdown link (Wikipedia
  conventionally), not their own page. If you relax the scope
  rule, leave the historical failure mode noted somewhere or
  the per-thread shape will silently re-introduce it.
- **Use `messages.created_at` for the day-gate, not
  `threads.updated_at`.** The journal RPC reads
  `threads.updated_at` because journals fired on a same-day
  cooldown predicate that already matched the journal's
  semantics. The wiki gate is "newest message's calendar day
  is strictly before today" - reading off the messages
  lateral keeps the predicate stable against future bumps to
  `threads.updated_at` from unrelated writes.
- **`unique(user_id, title)` + ON CONFLICT in the agent.**
  The autonomous agent is told to always `wiki_search`
  before writing, but a near-duplicate title can still slip
  through (the search returned an unrelated article, or
  caching missed). The unique constraint surfaces the
  collision as a tool error the agent reads as "fall through
  to wiki_search + wiki_update". Removing the constraint
  would silently allow duplicate articles.
- **Manual agent must NOT discard facts unless told to.**
  The "rewrite for tone" / "fix paragraph 2" / "add a
  sentence" patterns all preserve the rest of the article.
  This is encoded in the `WIKI_MANUAL_PROMPT` and is
  load-bearing for the trust contract with the user.
  Reviewer note: a future change that broadens the prompt to
  "make it better" would silently rewrite parts the user
  wanted left alone.
- **Pointer-advance is unconditional on `done`.** Even a
  no-op cycle (agent issued zero tool calls) advances the
  pointer. Without this, every cycle would re-process the
  same "the model decided this conversation has nothing
  worth wiki-ing" conversation forever.
- **Final-text is load-bearing now.** Both the per-conversation
  wiki agent and the librarian historically ended with "reply
  with a single word; the word is discarded" so the tool loop
  would terminate cleanly. That changed: the final reply is now
  the operator-facing reasoning surfaced as `reasoning="..."`
  on the cycle's `finished thread` / `librarian finished` log
  line. The prompts ask for one or two plain-text sentences
  naming what the agent did or skipped and why; the loop
  normalises whitespace and inlines that string. Do not revert
  the prompt to "single word" without also dropping the
  reasoning surface on the loop side - users debug "why did the
  agent decide X" by reading those summaries in the log drawer,
  and the librarian's "two articles I considered merging but
  left alone" case is only visible there.
- **`wiki_create` rephrases unique-violations.** The
  autonomous agent reads tool-error text as guidance; the
  raw Postgres `duplicate key value violates unique
  constraint` message is opaque. The tool's `execute`
  rephrases as "An article titled X already exists. Run
  wiki_search to find its id, then call wiki_update."
- **`embedding_claim_expires` (no `_at`).** Schema
  convention for the embedding-side claim columns matches
  memories and journal_entries. The thread-side claim
  columns (`wiki_claim_expires_at`) DO have the suffix,
  matching `journal_claim_expires_at`. Easy to flip when
  cloning; both are canonical.

## Verification

End-to-end manual smoke test (mirroring the plan's
verification list):

1. `mise run sync` against a dev Supabase. Confirm
   `wiki_articles`, the trigger, the five RPCs, and the
   three new `threads` columns land. Re-run for
   idempotency.
2. **Drawer alphabetical sort.** Add "Zebra", "Apple",
   "Mango" via the panel. Tab reads Apple, Mango, Zebra.
3. **Search.** Type "ze" -> "Zebra" only. Clear ->
   alphabetical returns.
4. **Create / edit / delete** round-trip via the panel.
   The drawer reflects each change via `WIKI_CHANGE_EVENT`.
5. **Ask agent to update - preview / accept / cancel /
   try again.** Open an article, type instructions ->
   preview populates with the agent's `reason` rendered above
   the body -> Accept persists and writes a changelog row
   using the agent's `reason` as the message; Cancel
   dismisses; Try again regenerates.
6. **Changelog modal.** Click the clock icon next to the
   sparkles librarian button in the Wiki top bar. Modal opens
   with the user's create/update/delete history newest-first,
   kind chips visible. Click an Edit/Add entry's title -> the
   drawer flips to Wiki and the article opens. Delete-kind
   titles are non-interactive. "Load more" appends the next
   50 rows; the button hides once the tail is reached.
7. **Required commit messages.** The direct create / edit /
   delete strips on the Wiki panel all require a one-line
   change message before the destructive action enables; the
   agent tools enforce the same via the `message` parameter
   on each schema.
8. **Autonomous agent fires the day after.** Substantive
   conversation today: `claim_next_thread_for_wiki` returns
   nothing. Thread whose newest message is yesterday-in-tz:
   agent runs, `wiki_search` then `wiki_create` /
   `wiki_update` lands, `last_wiki_processed_msg_id`
   advances.
9. **Eligibility re-opens after continuation.** New
   message in that thread today -> RPC returns nothing
   again until tomorrow.
10. **Recall tool.** Ask the chat "what do you know about
    my green tea preference?" - the model issues
    `wiki_search` and grounds its answer.
11. **Embeddings filled.** New article -> `embedding is
    null` initially, populates ~30s later.
12. **Settings toggle.** Disable "Automatic wiki" ->
    worker stops, no claims. Enable -> resumes.
13. `mise run check` green; no `(!)` build warnings or
    `plugin:vite:reporter` chunking warnings introduced.
