# Topics

Background worker that tags each thread with a short flat set of
topic strings, plus the drawer UI that uses those tags to filter
the conversation list.

Two sibling workers do the same job for the other drawer surfaces:

- `src/lib/agents/memory_topics/*` tags `memories.topics` for the
  Memories tab. See "Memory topics" below.
- `src/lib/agents/recipe_topics/*` tags `recipes.topics` for the
  Cookbook drawer tab. See "Recipe topics" below.

All three implementations mirror each other file-for-file and share
the `TopicsFilter.svelte` component plus the `topicsFilterClause`
helper. Differences are noted in the subsections.

## Role in the app

When a thread accumulates a terminal assistant message past
`last_topics_msg_id`, the topics worker claims it, asks the fast
model for 1-4 short topic tags (with the user's existing topic
vocabulary inlined for normalisation), and writes the result back
via a claim-guarded RPC. The drawer's `[Topics ▾]` dropdown reads
the per-user vocabulary on mount and after a tag-update arrives via
the realtime channel; selecting one or more topics narrows the
conversation list via a `topics &&` overlap predicate.

The dropdown also offers a synthetic `(untagged)` entry that
filters to rows whose `topics` column is empty - either the worker
hasn't reached them yet, or the agent ran and chose to emit no
topics. Multi-select is OR semantics: `baking` + `bread` shows
threads tagged with either.

## Files

- `src/lib/agents/topics/agent.ts` — `TopicsAgent.run`; one tagging
  call per invocation. Parses + normalises the model's JSON output
  (lowercase, strip non-alphanum-or-hyphen, dedupe, cap at 4). No
  tool calls.
- `src/lib/agents/topics/prompt.ts` — the user-turn instruction.
  `buildTopicsPrompt(existing)` inlines the user's current
  vocabulary so the model can reuse names rather than minting near-
  duplicates.
- `src/lib/agents/topics/loop.ts` — `runOneCycle`, `napForResult`.
  Same lease-acquire → claim → work → save shape as summary; the
  wrinkle is the claim returns an extra `existing_topics` column
  that the agent forwards to the prompt.
- `src/lib/agents/topics/worker.ts` — Web Worker entry point.
  Mirrors `../summary/worker.ts`; builds the per-worker Supabase +
  Venice clients and drives `runOneCycle` until abort.
- `src/lib/agents/topics/manager.ts` — main-thread supervisor.
  Cross-tab Web Lock (`nak:topics-worker`), starts/stops the
  Worker, builds the `StartMessage`.
- `src/components/TopicsFilter.svelte` — the drawer's dropdown +
  pill row. Pure presentation; the parent passes the vocabulary +
  selection in and gets an `onChange` callback out. The Svelte file
  owns only what is genuinely framework-specific: prop wiring,
  `$state` / `$derived` declarations, DOM refs, the document-level
  click/key listeners, and the markup. Every UI-behavior decision
  is composed in from the primitives module.
- `src/lib/ui/topics-filter.ts` — pure UI-behavior primitives for the
  topic filter. `computeOptions(topics)`, `labelFor(topic)`,
  `isUntagged(topic)`, `selectionAfterToggle(selected, topic)`,
  `selectionAfterClearOne(selected, topic)`. No runes, no Svelte
  imports - this file is what a port to another framework would
  carry across unchanged. Unit-tested directly in
  `tests/topics-filter.test.ts` (plain vitest, no harness).
- `src/screens/Chat.svelte` — owns `selectedTopics` /
  `topicsVocabulary` state, threads `selectedTopics` through the
  three bucket fetches + search + window-fetch, refreshes the
  vocabulary on the realtime `onUpdate` path when the row's topics
  changed.
- `src/lib/supabase.ts` — `topicsFilterClause()` helper,
  `claimNextThreadForTopics` / `saveThreadTopicsIfClaimed` /
  `clearTopicsClaim` / `listUserTopics` RPC wrappers, the
  `UNTAGGED_TOPIC_SENTINEL` export.
- `supabase/schema.sql` (topics section) — `threads.topics`,
  `last_topics_msg_id`, the claim columns, the GIN index, and the
  four RPCs.

## Entry points

- **`activate()` in `state.svelte.ts`** — calls
  `topicsManager.start({ supabase, config })` fire-and-forget
  alongside the other agent managers.
- **`lock()`** — calls `topicsManager.stop()`. Releases the Web
  Lock and the Supabase lease.
- **Drawer onMount in `Chat.svelte`** — fires
  `refreshTopicsVocabulary()` on first auth event and on each
  subsequent auth event. Also fired from the realtime `onUpdate`
  handler when the incoming row's `topics` differ from the
  existing copy.
- **`$effect` watching `selectedTopics`** — refetches all three
  buckets when the user changes the filter. Cursors reset because
  the predicate changed.
- **Cycle result driver** — inside the Worker, `runOneCycle`
  returns a `CycleResult` (`acquired-lease` / `polling` /
  `empty-queue` / `tagged` / `claim-lost` / `empty-topics` /
  `error`). `napForResult` maps each to a sleep before the next
  cycle.

## Data model

- **`threads.topics text[] not null default '{}'`** — the flat tag
  list. Empty array means "untagged" (either the worker hasn't run
  yet, or it chose to emit nothing). The `UNTAGGED_TOPIC_SENTINEL`
  (`'(untagged)'`) is a UI-side primitive only; it never lands in
  this column.
- **`threads.last_topics_msg_id`** — terminal assistant message id
  the tags cover up to. A new terminal message past this id
  re-qualifies the thread on the next poll; the next tagging pass
  overwrites `topics` rather than appending.
- **`threads.topics_claim_holder`** + **`threads.topics_claim_expires`**
  — per-row claim columns. Same shape as summary / reflection;
  partial index on `topics_claim_holder is not null` keeps it
  tiny.
- **GIN index `threads_topics_gin_idx`** — backs the `topics &&`
  overlap predicate the drawer uses to filter the conversation
  list. RLS narrows reads per user implicitly.
- **`worker_leases` row** — `worker_kind='topics'`. Partitioned
  from the other workers so a device can hold every lease at once.

## Contracts

- `TopicsAgent.run(req): Promise<AgentRunResult<TopicsOutput>>` —
  `TopicsOutput.topics: string[]` is the validated tag list, or
  `[]` when the model produced unparseable output, no valid items,
  or only the reserved sentinel. The loop treats empty as a non-
  result and calls `clearTopicsClaim` so the row re-enters the
  queue immediately rather than waiting for the TTL.
- `runOneCycle(ctx): Promise<CycleResult>` — one observable state
  transition; same shape as the other agent loops.
- `claim_next_thread_for_topics` RPC (schema) — returns
  `(thread_id, terminal_msg_id, existing_topics)`. The third
  column is the user's per-account vocabulary at claim time,
  fetched in the same round trip so the agent can normalise
  without a second SELECT. Eligibility excludes threads still on
  the `'New conversation'` placeholder (auto-title runs first).
- `save_thread_topics_if_claimed` RPC — only writes if
  `topics_claim_holder = $me AND topics_claim_expires > now()`.
  Does NOT bump `updated_at` (tagging is a side-effect; bumping
  would re-promote the thread in the drawer).
- `list_user_topics` RPC — returns the sorted vocabulary for the
  calling user as a jsonb object `{ topics: [{topic, count}],
  untagged }`. `count` is the per-topic tally the dropdown shows in
  parens; `untagged` backs the synthetic `(untagged)` row's count.
  Computed server-side because the thread list is paginated - a client
  tally would only see the loaded page. Scoped to `archived = false`:
  the dropdown filters the active list, so both the counts and the
  vocabulary itself exclude archived threads (a topic living only on
  archived threads drops off the dropdown rather than showing "(0)").
  This is the one place threads diverge from the memory/recipe
  siblings, which have no archived dimension and count their whole
  corpus. Empty `topics` on accounts where the agent hasn't run yet.
  The supabase-service wrapper parses it into a `TopicVocabulary` (see
  `supabase.ts`); the sibling `list_user_memory_topics` /
  `list_user_recipe_topics` RPCs return the same shape.
- `topicsFilterClause(selected)` (helper in `supabase.ts`) — turns
  a `selectedTopics` array into a PostgREST `or(...)` clause.
  Handles the untagged sentinel specially (`topics.eq.{}`) and
  the real-topic case via `topics.ov.{a,b,c}`. Returns null when
  the selection is empty so the caller skips the predicate
  entirely.

## Interactions with other features

- **Chat** — owns the drawer state (`selectedTopics`,
  `topicsVocabulary`) and the `$effect` that refetches buckets on
  filter change. Also threads `selectedTopics` through the three
  list functions, the search, and the window-fetch for
  cross-bucket search-result-opens. See `./chat.md`.
- **Search** — `searchThreads` accepts a `selectedTopics`
  parameter. Exact (ILIKE) hits are filtered server-side via the
  same `topicsFilterClause`; semantic hits are filtered client-
  side because the embedding RPC doesn't read the topics column.
  Same outcome: "search within the active topic filter."
- **Auto-title** — runs first by design. The topics claim's
  eligibility predicate excludes threads still on the placeholder
  title, so the topic vocabulary doesn't get seeded with junk on
  brand-new threads that haven't been auto-titled yet.
- **Summaries** — sibling background loop, same plumbing shape.
  Both write a derived column on the thread row; tagging doesn't
  invalidate the embedding (the
  `clear_thread_embedding_on_change` trigger only fires on
  `title` / `summary` changes).
- **Logging** — the loop driver emits progress and error
  breadcrumbs through `createLogger('topics-worker')`. Same
  worker-to-main relay as summary / reflection.

## Gotchas

- **The `(untagged)` sentinel is UI-only.** It never lands in the
  database `topics` column. The agent prompt forbids it; the
  normaliser also blocks the literal string. The filter UI
  synthesises it from a `topics = '{}'` predicate. If you ever
  surface the column to a non-UI consumer (a tool, an API),
  remember the sentinel is not part of the data model.
- **Topic-changed detection on realtime updates is elementwise.**
  Every realtime UPDATE materialises a fresh array; `===` would
  never match. The `topicsChanged` comparison in the `onUpdate`
  handler compares lengths and entries pairwise. Don't simplify
  to `prev !== next`.
- **Cursors reset on filter change.** The `$effect` that watches
  `selectedTopics` calls `refreshThreads()`, which resets both
  pagination cursors. Paginating from a cursor recorded against
  the prior predicate would skip rows that should appear at the
  top of the narrowed list.
- **Multi-select is OR (overlap), not AND (contains).** The
  PostgREST operator is `ov` (array overlap, `&&`), which means
  at least one of the selected topics must appear in the row's
  array. `cs` (contains, `@>`) would require ALL listed topics
  to be present. The UX decision (see the design discussion that
  led to this feature) is OR, and the operator choice locks
  that in.
- **Worker_kind is just a string.** Adding a new agent
  (`'topics'` here) doesn't need a schema change to
  `worker_leases` — the column is free-form text. The agent
  itself defines the value; the LeaseCoordinator passes it
  through verbatim to `acquire_worker_lease` and friends.
- **Topic re-tagging is overwrite, not append.** Same shape as
  summary: a new terminal-assistant-message past
  `last_topics_msg_id` reopens the claim and the next pass
  overwrites `topics`. A long conversation's earlier topic
  ceases to appear in the filter once a later pass dropped it.
  Acceptable because the vocabulary self-corrects across the
  user's thread set.

## Memory topics

Same shape as above but the input is one `memories` row instead of
a conversation transcript, and the output writes to
`memories.topics` so the Memories drawer can offer its own topic-
filter dropdown. Two pieces differ vs threads:

- **Eligibility predicate.** A memory has no message stream, so
  "needs (re)tagging" is `memories.last_topics_at is null` rather
  than "terminal message past `last_topics_msg_id`". A
  `clear_memory_topics_on_change` trigger nulls `last_topics_at`
  (plus the claim columns) on `label` / `data` change - the same
  shape as the existing `clear_memory_embedding_on_change` trigger
  next to it. Confidence-only updates (bump / decay / reaffirm /
  doubt) don't touch label or data, so they don't re-queue the row
  - tags stay stable across volitional nudges the same way the
  embedding does.
- **Prompt.** The model is asked to pick the SUBJECT AREA of a
  memory, not a summary of its assertion. "Allergic to shellfish"
  belongs under "allergies", not under "shellfish-allergy". The
  prompt has worked examples for that distinction since the
  thread topics prompt's framing produced verbose paraphrases when
  pointed at single facts.

Files mirror the topics tree under
`src/lib/agents/memory_topics/` (`agent.ts`, `prompt.ts`,
`loop.ts`, `worker.ts`, `manager.ts`). Cross-tab lock name:
`nak:memory-topics-worker`. Worker_kind in the lease table:
`memory-topics`. RPC quartet:
`claim_next_memory_for_topics` /
`save_memory_topics_if_claimed` /
`clear_memory_topics_claim` / `list_user_memory_topics`. The UI
is `src/components/MemoryList.svelte` (which mounts the same
`TopicsFilter.svelte` the conversation drawer uses) backed by
`memoriesStore.topicsVocabulary` + `memoriesStore.selectedTopics`
in `src/lib/memories-store.svelte.ts`.

Topic-filter wiring: `searchMemoriesSemantic` (in
`src/lib/memories.ts`) takes an optional `selectedTopics`. Server-
side filtering covers the ILIKE / list-all / unembedded paths via
the same `topicsFilterClause` helper - the column happens to be
named `topics` on both tables so no per-table generalisation was
needed. Vector hits are filtered client-side because
`search_memories_by_embedding` returns `topics` on each row
(adding a topic-filter argument to the RPC would have distorted
the rank-then-limit pipeline; client-side post-filtering keeps
the contract simple). The assistant-facing `memory_search` tool
passes nothing for `selectedTopics`, so its behaviour is
unchanged.

Vocabulary refresh: `runMemoriesSearch` chains a
`list_user_memory_topics` fetch onto every successful search
resolution. No memories realtime channel today (see the
cookbook-events note in `memories-store.svelte.ts`), so this is
how the dropdown picks up newly-minted topics without a drawer
reopen. The RPC is a single distinct-array-agg per user and
costs essentially nothing at our row counts.

## Recipe topics

Same shape as Memory topics but the input is one `recipes` row
instead of a memory, and the output writes to `recipes.topics` so
the Cookbook drawer can offer its own topic-filter dropdown. Three
pieces differ vs the other two surfaces:

- **Eligibility trigger.** A `clear_recipe_topics_on_change` trigger
  nulls `last_topics_at` + claim columns when `title` or `cooklang`
  changes. Deliberately NOT on `source` / `source_url` (those are
  metadata about where the recipe came from, not what the dish IS)
  and NOT on the bookmark / rating columns (`upcoming`, `favorite`,
  `rating` - workflow state, not content). The existing
  `clear_recipe_embedding_on_change` trigger DOES include source in
  its dependency set because the embedded blob folds source in for
  semantic search; the topic agent reads title + cooklang only.

- **Cap is 1-6 instead of 1-4.** Recipes legitimately span four
  dimensions - primary ingredients, cuisine, course, technique -
  and the thread cap was forcing the model to drop cuisine or
  course on multi-dimensional dishes ("chicken tikka masala" wants
  chicken + indian + curry + dinner). Six lets all four dimensions
  land plus a second headline ingredient on dual-protein dishes.
  The cap lives in `MAX_RECIPE_TOPICS` in `recipe_topics/agent.ts`.

- **Prompt.** Targets the four dimensions explicitly with worked
  examples calibrating the "primary ingredients only - no pantry
  staples" bias. Pushing recipes through the memory prompt
  produced ingredient-name dumps (every `@ingredient{}` became a
  tag); the memory prompt's "subject area" framing doesn't fit
  structured Cooklang input. The prompt is the load-bearing part
  of the recipe-topics design - see `recipe_topics/prompt.ts` for
  the four-dimension rationale and the calibration examples.

Filter wiring. Recipe topics are applied client-side in
`src/components/RecipeList.svelte`: the cookbook is bounded
(`loadRecipes` pulls up to 200 rows into `cookbook.recipes`), so a
client-side predicate narrows the All / Upcoming / Favorites
buckets AND the search-results bucket uniformly without a second
round trip. Server-side filtering on `searchRecipes` would add
scope for no perceptible perf win at recipe scale. The same
predicate (real-topic overlap + `(untagged)` sentinel for empty
arrays) matches the helper used on the other two surfaces.

Vocabulary refresh. `loadRecipes` chains a
`list_user_recipe_topics` fetch onto every successful refresh, so
a newly-minted topic from the worker shows up in the dropdown the
next time the list reloads (tool mutations, modal opens, tab
switches all trigger reloads). The sibling
`refreshRecipesTopicsVocabulary` is also called from
`RecipeList.svelte`'s `onMount` so the dropdown is primed before
the first load resolves.

Files mirror the topics tree under
`src/lib/agents/recipe_topics/`. Cross-tab lock name:
`nak:recipe-topics-worker`. Worker_kind in the lease table:
`recipe-topics`. RPC quartet: `claim_next_recipe_for_topics` /
`save_recipe_topics_if_claimed` / `clear_recipe_topics_claim` /
`list_user_recipe_topics`.

## Where to go next

- `./summaries.md` — sibling worker, same shape.
- `./auto-title.md` — runs first; topics is gated on it.
- `./chat.md` — the drawer state that owns the filter UI.
- `./memory.md` — the store the memory-topics worker tags.
- `./cookbook.md` — the store the recipe-topics worker tags.
- `./architecture.md` — the worker model in context.
