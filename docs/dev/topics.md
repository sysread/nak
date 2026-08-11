# Topics

Server-side curation unit that tags each thread with a short flat
set of topic strings, plus the drawer UI that uses those tags to
filter the conversation list. The tagging runs in the venice edge
function; there is no browser-side tagging code.

Two sibling units do the same job for the other drawer surfaces:

- `supabase/functions/venice/agents/memory_topics.ts` tags
  `memories.topics` for the Memories tab. See "Memory topics" below.
- `supabase/functions/venice/agents/recipe_topics.ts` tags
  `recipes.topics` for the Cookbook drawer tab. See "Recipe topics"
  below.

All three implementations mirror each other and share the
`TopicsFilter.svelte` component plus the `topicsFilterClause`
helper. Differences are noted in the subsections.

## Role in the app

When a thread accumulates a terminal assistant message past
`last_topics_msg_id`, the thread-topics unit claims it, asks the
fast model (`mistral-small-3-2-24b-instruct`, hardcoded in the
agent module) for 1-4 short topic tags (with the user's existing
topic vocabulary inlined for normalisation), and writes the result
back via a claim-guarded RPC. The drawer's `[Topics ▾]` dropdown
reads the per-user vocabulary on mount and after a tag-update
arrives via the realtime channel; selecting one or more topics
narrows the conversation list via a `topics &&` overlap predicate.

Two drivers run the unit (same shape for all five curation units):

- **Chat-turn tail** - `curateOnTurnTail(admin, userId)` fires from
  `getStreamingResponse.ts`'s `waitUntil` tail on every completed
  turn, per-unit drain cap 3. Thread topics runs second in the
  walk, after auto-title.
- **Hourly curation sweep** - the `/curation-sweep` route (pg_cron
  job `nak-curation-sweep`, minute 57) runs `runCurationSweepTick`
  cross-user via the SECURITY DEFINER `*_sweep` claim RPCs,
  per-queue cap 10.

Double-driving is safe: the per-row claim columns are the only
mutual exclusion - whichever driver claims first wins and the
other sees an empty queue. There are no worker leases for these
units.

The dropdown also offers a synthetic `(untagged)` entry that
filters to rows whose `topics` column is empty - either the unit
hasn't reached them yet, or the agent ran and chose to emit no
topics. Multi-select is OR semantics: `baking` + `bread` shows
threads tagged with either.

## Files

- `supabase/functions/venice/agents/thread_topics.ts` - the work
  unit: `tagOneThread` (per-user claim, tail driver),
  `sweepClaimAndTagThread` (cross-user claim, sweep driver), the
  topics prompt (existing vocabulary inlined), and the JSON parse +
  normalise step (lowercase, strip non-alphanum-or-hyphen, dedupe,
  cap at 4, reject the `(untagged)` sentinel).
- `supabase/functions/venice/agents/curation.ts` - the composition
  layer that orders the five units and owns the drain loops.
- `src/components/TopicsFilter.svelte` - the drawer's dropdown +
  pill row. Pure presentation; the parent passes the vocabulary +
  selection in and gets an `onChange` callback out. The Svelte file
  owns only what is genuinely framework-specific: prop wiring,
  `$state` / `$derived` declarations, DOM refs, the document-level
  click/key listeners, and the markup. Every UI-behavior decision
  is composed in from the primitives module.
- `src/lib/ui/topics-filter.ts` - pure UI-behavior primitives for the
  topic filter. `computeOptions(topics)`, `labelFor(topic)`,
  `isUntagged(topic)`, `selectionAfterToggle(selected, topic)`,
  `selectionAfterClearOne(selected, topic)`. No runes, no Svelte
  imports - this file is what a port to another framework would
  carry across unchanged. Unit-tested directly in
  `tests/topics-filter.test.ts` (plain vitest, no harness).
- `src/screens/Chat.svelte` - owns `selectedTopics` /
  `topicsVocabulary` state, threads `selectedTopics` through the
  three bucket fetches + search + window-fetch, refreshes the
  vocabulary on the realtime `onUpdate` path when the row's topics
  changed.
- `src/lib/supabase.ts` - the `topicsFilterClause()` helper, the
  `listUserTopics` / `listUserMemoryTopics` / `listUserRecipeTopics`
  vocabulary wrappers (all parsed through `parseTopicVocabulary`),
  and the `UNTAGGED_TOPIC_SENTINEL` export.
- `supabase/schema.sql` (topics sections) - `threads.topics`,
  `last_topics_msg_id`, the claim columns, the GIN index, and the
  RPCs (`claim_next_thread_for_topics`,
  `claim_next_thread_for_topics_sweep`,
  `save_thread_topics_if_claimed`, `clear_topics_claim`,
  `list_user_topics`).

## Entry points

- **`getStreamingResponse.ts` terminal tail** - on a `completed`
  turn, `curateOnTurnTail` walks the five units.
- **`/curation-sweep` route in `venice/index.ts`** - the hourly
  cron tick; `runCurationSweepTick` drains each queue cross-user.
- **Drawer onMount in `Chat.svelte`** - fires
  `refreshTopicsVocabulary()` on first auth event and on each
  subsequent auth event. Also fired from the realtime `onUpdate`
  handler when the incoming row's `topics` differ from the
  existing copy.
- **`$effect` watching `selectedTopics`** - refetches all three
  buckets when the user changes the filter. Cursors reset because
  the predicate changed.
- **Outcome vocabulary** - each cycle returns a
  `ThreadTopicsOutcome` (`empty-queue` / `tagged` / `claim-lost` /
  `empty-topics` / `error`). The drain loops keep claiming on
  `tagged` and `claim-lost` and stop on the rest.

## Data model

- **`threads.topics text[] not null default '{}'`** - the flat tag
  list. Empty array means "untagged" (either the unit hasn't run
  yet, or it chose to emit nothing). The `UNTAGGED_TOPIC_SENTINEL`
  (`'(untagged)'`) is a UI-side primitive only; it never lands in
  this column.
- **`threads.last_topics_msg_id`** - terminal assistant message id
  the tags cover up to. A new terminal message past this id
  re-qualifies the thread on the next cycle; the next tagging pass
  overwrites `topics` rather than appending.
- **`threads.topics_claim_holder`** + **`threads.topics_claim_expires`**
  - per-row claim columns, the sole mutual exclusion between the
  two drivers. Same shape as summary / reflection; partial index on
  `topics_claim_holder is not null` keeps it tiny. Claim TTL is
  `CURATION_CLAIM_TTL_SECONDS` (120s), shared by all five curation
  units.
- **GIN index `threads_topics_gin_idx`** - backs the `topics &&`
  overlap predicate the drawer uses to filter the conversation
  list. RLS narrows reads per user implicitly.

## Contracts

- `tagOneThread(admin, userId, log): Promise<ThreadTopicsOutcome>` -
  one per-user cycle: claim, tag, save. Non-throwing. Empty or
  unparseable model output calls `clear_topics_claim` so the row
  re-enters the queue immediately rather than waiting for the TTL,
  and returns `empty-topics`.
- `sweepClaimAndTagThread(admin): Promise<ThreadTopicsOutcome>` -
  one cross-user sweep step; creates its own edge logger per claim
  and flushes before returning.
- `claim_next_thread_for_topics(holder, ttl, p_user_id)` RPC -
  returns `(thread_id, terminal_msg_id, existing_topics)`. The
  third column is the user's per-account vocabulary at claim time,
  fetched in the same round trip so the agent can normalise without
  a second SELECT. Eligibility excludes threads still on the
  `'New conversation'` placeholder (auto-title runs first).
  `p_user_id` is the b-strict escape hatch for the service-role
  caller.
- `claim_next_thread_for_topics_sweep(holder, ttl)` RPC - SECURITY
  DEFINER cross-user variant; returns `user_id`, and its vocab CTE
  scopes to the candidate row's owner so the model sees that user's
  vocabulary, not an aggregate across accounts.
- `save_thread_topics_if_claimed(thread_id, holder, topics, msg_id,
  p_user_id)` RPC - only writes if
  `topics_claim_holder = $me AND topics_claim_expires > now()`.
  Does NOT bump `updated_at` (tagging is a side-effect; bumping
  would re-promote the thread in the drawer).
- `list_user_topics` RPC - returns the sorted vocabulary for the
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
- `topicsFilterClause(selected)` (helper in `supabase.ts`) - turns
  a `selectedTopics` array into a PostgREST `or(...)` clause.
  Handles the untagged sentinel specially (`topics.eq.{}`) and
  the real-topic case via `topics.ov.{a,b,c}`. Returns null when
  the selection is empty so the caller skips the predicate
  entirely.

## Interactions with other features

- **Chat** - owns the drawer state (`selectedTopics`,
  `topicsVocabulary`) and the `$effect` that refetches buckets on
  filter change. Also threads `selectedTopics` through the three
  list functions, the search, and the window-fetch for
  cross-bucket search-result-opens. The completed turn's tail is
  what drives the tagging itself. See `./chat.md`.
- **Search** - `searchThreads` accepts a `selectedTopics`
  parameter. Exact (ILIKE) hits are filtered server-side via the
  same `topicsFilterClause`; semantic hits are filtered client-
  side because the embedding RPC doesn't read the topics column.
  Same outcome: "search within the active topic filter."
- **Auto-title** - runs first by design. The topics claim's
  eligibility predicate excludes threads still on the placeholder
  title, so the topic vocabulary doesn't get seeded with junk on
  brand-new threads that haven't been auto-titled yet.
- **Summaries** - sibling curation unit, same plumbing shape.
  Both write a derived column on the thread row; tagging doesn't
  invalidate the embedding (the
  `clear_thread_embedding_on_change` trigger only fires on
  `title` / `summary` changes).
- **Logging** - the drivers emit progress and error breadcrumbs
  through `createEdgeLogger(userId, 'topics')` (siblings:
  `'memory-topics'`, `'recipe-topics'`), which reach the in-app
  Logs drawer over the `logs:<userId>` Broadcast topic. See
  `./logging.md`.

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
- **Topic re-tagging is overwrite, not append.** Same shape as
  summary: a new terminal-assistant-message past
  `last_topics_msg_id` reopens the claim and the next pass
  overwrites `topics`. A long conversation's earlier topic
  ceases to appear in the filter once a later pass dropped it.
  Acceptable because the vocabulary self-corrects across the
  user's thread set.
- **The model id is hardcoded in the agent modules.**
  `mistral-small-3-2-24b-instruct` in all three topics units (and
  summary) mirrors the corresponding `agentModel(...)` entries in
  `src/lib/models/index.ts`. Change both together.
- **The 120-message cap does not bound request size.** Thread
  topics sends a transcript, and 120 turns of a tool-using thread
  (search dumps, article bodies, file reads) blew past the serving
  backend's real ceiling: `context_length_exceeded`, "maximum
  context length is 128000 tokens ... your prompt contains 131949
  input tokens". Note the registry entry for that model claims
  256k - the ceiling belongs to whichever backend is serving the id
  and is not a contract (see CLAUDE.md). Sizing now lives in
  `completeOverThreadSlice` (`_curation_helpers.ts`), shared with
  summary: message cap, then per-row excerpting (tool results at 2k
  chars, prose at 8k), then a middle-out drop until the estimate
  fits `CURATION_INPUT_TOKEN_BUDGET` (64k, deliberately half the
  smallest observed ceiling because the 4-chars-per-token estimate
  is optimistic for JSON), then one halved-budget retry if the
  backend rejects it regardless. The newest message always survives
  so a pathological final turn can't wedge the queue.

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

The unit lives in
`supabase/functions/venice/agents/memory_topics.ts`
(`tagOneMemory` / `sweepClaimAndTagMemory`). RPC family:
`claim_next_memory_for_topics` /
`claim_next_memory_for_topics_sweep` /
`save_memory_topics_if_claimed` /
`clear_memory_topics_claim` / `list_user_memory_topics`. This
queue's writers are mostly server-side (reflection on chat-turn
tails; rem / deep-sleep on cron), so the hourly sweep matters more
here than for threads - a 3am rem consolidation would otherwise
leave rows untagged until their owner next converses. The UI is
`src/components/MemoryList.svelte` (which mounts the same
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
  nulls `topics` + `last_topics_at` + claim columns whenever ANY of
  the recipe's own data changes - title, cooklang, source,
  source_url, rating, the bookmark flags. It compares the whole OLD
  and NEW rows instead of naming a column subset, so a new column is
  covered for free. The safety mask: before comparing it copies
  NEW's async-pipeline bookkeeping columns onto OLD, so churn
  confined to them reads as "no change." That covers this pipeline's
  own topic columns (otherwise `save_recipe_topics_if_claimed` would
  re-queue the row it just tagged - the recursion guard) and the
  embeddings backfill's `embedding*` columns (an embed compute/claim is
  not a recipe edit). Contrast `clear_recipe_embedding_on_change`,
  which fires only on title / cooklang / source because the embedded
  blob is built from just those three.

- **Cap is 1-6 instead of 1-4.** Recipes legitimately span four
  dimensions - primary ingredients, cuisine, course, technique -
  and the thread cap was forcing the model to drop cuisine or
  course on multi-dimensional dishes ("chicken tikka masala" wants
  chicken + indian + curry + dinner). Six lets all four dimensions
  land plus a second headline ingredient on dual-protein dishes.
  The cap lives in `MAX_RECIPE_TOPICS` in
  `supabase/functions/venice/agents/recipe_topics.ts`.

- **Prompt.** Targets the four dimensions explicitly with worked
  examples calibrating the "primary ingredients only - no pantry
  staples" bias. Pushing recipes through the memory prompt
  produced ingredient-name dumps (every `@ingredient{}` became a
  tag); the memory prompt's "subject area" framing doesn't fit
  structured Cooklang input. The prompt is the load-bearing part
  of the recipe-topics design - see the prompt constant in
  `recipe_topics.ts` for the four-dimension rationale and the
  calibration examples.

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
a newly-minted topic from the unit shows up in the dropdown the
next time the list reloads (tool mutations, modal opens, tab
switches all trigger reloads). The sibling
`refreshRecipesTopicsVocabulary` is also called from
`RecipeList.svelte`'s `onMount` so the dropdown is primed before
the first load resolves.

The unit lives in
`supabase/functions/venice/agents/recipe_topics.ts`
(`tagOneRecipe` / `sweepClaimAndTagRecipe`). RPC family:
`claim_next_recipe_for_topics` /
`claim_next_recipe_for_topics_sweep` /
`save_recipe_topics_if_claimed` / `clear_recipe_topics_claim` /
`list_user_recipe_topics`.

## Where to go next

- `./summaries.md` - sibling curation unit, same shape.
- `./auto-title.md` - runs first; topics is gated on it.
- `./chat.md` - the drawer state that owns the filter UI.
- `./memory.md` - the store the memory-topics unit tags.
- `./cookbook.md` - the store the recipe-topics unit tags.
- `./architecture.md` - background work in context.
