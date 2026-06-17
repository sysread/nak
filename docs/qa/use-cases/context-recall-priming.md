# Context recall: boundary-triggered priming injection

## Covers

The deterministic, topic-boundary recall pipeline that fires
automatically at a topic boundary (thread start / mood shift / stale
fuse), gathers a works-cited index across the three persistent layers
(memories inline, prior conversations + wiki by id), and injects it as
a synthetic `<think>` assistant turn the conscious response reads as
its own recollection. Also exercises the umbrella `context` tool as the
explicit on-demand path over the same gather
([dev: context-recall](../../dev/context-recall.md),
[dev: intuition](../../dev/intuition.md) for the shared trigger
evaluator, [dev: memory](../../dev/memory.md),
[dev: conversation-recall](../../dev/conversation-recall.md),
[dev: wiki](../../dev/wiki.md), [dev: logging](../../dev/logging.md)).

This case covers the AUTOMATIC, reflexive, deterministic pipeline and
its `<think>` injection. The model-callable per-layer recall AGENTS
(`memory_recall` and siblings, which spawn LLM sub-agent loops) are a
different tier and are covered by
[chat-recall-agents](./chat-recall-agents.md) - do not conflate the
two. The pipeline never calls those agents; it runs three vector /
ILIKE searches and inlines the result verbatim.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user
  (`dev@nak.local` / `devpass123`).
- Logs drawer open with the level filter set to `debug` (the most
  permissive setting - it shows debug + info + warn + error). The
  pipeline logs under source `context-recall`; the umbrella tool under
  source `context-tool`. Use the source dropdown to pin `context-recall`
  once the run has produced entries.
- Seed one recallable row in EACH of the three layers, all keyed on a
  single distinctive nonsense token so retrieval is deterministic and
  isolated from real corpus noise. The token must not collide with
  anything already present. This walkthrough uses `Quolffin`.

  The seed rows leave `embedding` NULL on purpose. Every layer's search
  runs an ILIKE / exact-title probe in parallel with the vector RPC
  (`searchUnembeddedMemoriesByText` filters `embedding is null`;
  `searchThreads` always ILIKEs `title`; `searchWikiArticles` ILIKEs
  `title` / `content`). A NULL-embedding row carrying the token is
  therefore matched through the ILIKE half regardless of whether the
  Venice embed for the live query succeeds - which is what makes the
  gather deterministic for this test rather than dependent on cosine
  scores.

  ```sql
  -- Dev user id.
  select id from auth.users where email = 'dev@nak.local';

  -- Layer 1 - memory (inlined verbatim in the index). confidence 1.0
  -- reads as a plain fact (no hedge tag); see classifyMemoryConfidence.
  insert into public.memories (user_id, label, data, confidence, embedding)
  values ('<user>', 'Quolffin preference',
          'The user keeps a pet axolotl named Quolffin.', 1.0, null);

  -- Layer 2 - a prior conversation (referenced by id -> conversation_get).
  -- The token rides in the TITLE so searchThreads' ILIKE matches it.
  insert into public.threads (user_id, title, summary)
  values ('<user>', 'Caring for Quolffin the axolotl',
          'We discussed tank temperature and feeding schedule for Quolffin.')
  returning id;

  -- Layer 3 - a wiki article (referenced by id -> wiki_get). Token in
  -- the title so searchWikiArticles' ILIKE matches it. No source rows,
  -- so it is an orphan article, not sole-sourced from any thread - it
  -- survives the pipeline's sole-source exclusion.
  insert into public.wiki_articles (user_id, title, content, embedding)
  values ('<user>', 'Quolffin (axolotl)',
          'Quolffin is the user''s axolotl. Lives in a chilled tank.',
          null)
  returning id;
  ```

  Note the two `returning id` values - the Expected section checks that
  these exact ids appear in the injected `<think>` block.

- Force the boundary via COLD START. A brand-new thread has no
  `context_recall_payload`, so `evaluatePreRoundTrigger` returns `cold`
  and the pipeline fires unconditionally on the first response. This is
  the cleanest controlled boundary - no mood manipulation or
  round-counting needed. (`mood` and `stale` are the other two live
  triggers; the `title` member of the union is legacy-only.) The
  `stale` arm fires on EITHER `STALE_FUSE_ROUNDS` user-rounds OR
  `STALE_FUSE_MS` (1h) wall-clock since the cached write - the shared
  evaluator behaves identically for both pipelines. The injection of
  this `<think>` block is also gated by `isPayloadFreshForInjection`:
  a payload older than `STALE_FUSE_MS` is suppressed rather than
  injected. Both behaviors are exercised in depth by
  [intuition-pipeline](./intuition-pipeline.md) steps 7-8 against the
  shared code; not re-forged here.

## Steps

1. Start a NEW conversation (the compose / new-thread control). Send a
   first message that contains the seed token so the derived recall
   query embeds toward it, e.g.:

   > What is the ideal water temperature for Quolffin?

2. While the response is forming, watch the streaming card's
   subconscious checklist for the `recall` row (the pipeline reports
   start/end through `onSubconsciousStart('recall')` /
   `onSubconsciousEnd('recall')`).

3. After the reply settles, read the `context-recall` source in the
   Logs drawer. Confirm the start and the complete lines.

4. Inspect the persisted cache on the new thread:

   ```sql
   select context_recall_payload -> 'trigger'  as trigger,
          context_recall_payload -> 'note'     as note,
          context_recall_payload -> 'computed_at_round' as round
     from public.threads
    where id = '<new-thread-id>';
   ```

5. Confirm the injected `<think>` reached the model: the conscious
   reply should be able to answer using the inlined memory fact
   (axolotl named Quolffin) WITHOUT having called any tool first, and
   may offer to pull up the referenced conversation / wiki article by
   name. The synthetic turn is reconstructed from the cache at request
   time and is not persisted as a message row, so it is observed
   through the model's behavior and the cache, not a `messages` row.

6. Exercise the umbrella `context` tool as the explicit on-demand
   path over the same gather. In a chat turn, instruct:

   > Call the context tool with the topic "Quolffin" and tell me the
   > raw result.

   Watch the `context-tool` source in the Logs drawer and the tool
   result row on the thread.

## Expected

- (2) The streaming card shows a `recall` subconscious row that
  appears while the pipeline runs and clears when it finishes. (On a
  fast local stack this can be brief.)
- (3) `context-recall` source shows an info `pipeline starting` line
  with `{ trigger: 'cold', round: 1 }`, then an info `pipeline
  complete` line carrying the per-layer hit counts -
  `memoryCount: 1, conversationCount: 1, wikiCount: 1` - plus a
  non-zero `noteLength`. Counts of 1/1/1 are the yes/no check that all
  three layers carried signal.
- (4) `trigger` is `"cold"`. `round` is `1`. `note` is a non-empty
  string that contains, in order: the verbatim memory fact ("The user
  keeps a pet axolotl named Quolffin."), then a `conversation_get`
  line with `- Caring for Quolffin the axolotl (id: <thread-id>)`,
  then a `wiki_get` line with `- Quolffin (axolotl) (id: <wiki-id>)`.
  The two ids match the `returning id` values seeded in
  Preconditions. The memory line has NO `(hedged recollection)` /
  `(shaky recollection)` suffix (confidence 1.0 reads as a plain fact).
- (5) The reply answers from the inlined memory fact without a
  preceding tool call (the fact was injected, not retrieved), and the
  conversation / wiki items read as offered leads rather than as
  already-read content. This is the user-visible proof the `<think>`
  block was injected and consumed.
- (6) `context-tool` source shows the umbrella tool firing; the tool
  result row carries the structured `ContextIndex`
  (`{ memories: [...verbatim...], conversations: [{id,title}],
  wiki: [{id,title}] }`) - structured, NOT wrapped in `<think>`, and
  with no cache write (the umbrella runs fresh every call, so no
  `context_recall_payload` change results from this step).
- Negative-state sanity (optional): starting a fresh thread whose
  first message shares no token with any seeded or real recallable
  row yields a `pipeline complete` line with all counts `0` and a
  cached payload with `note: ""`. That empty note is a VALID cached
  state (it holds the same-round debounce); no `<think>` block is
  injected for it - `buildContextRecallThinkMessage` returns null on
  an empty note. Do not read an all-zero run as a failure.

## Cleanup

Delete the seeded rows and the test thread. Run after recording
results.

```sql
delete from public.memories
 where user_id = '<user>' and label = 'Quolffin preference';
delete from public.wiki_articles
 where user_id = '<user>' and title = 'Quolffin (axolotl)';
delete from public.threads
 where user_id = '<user>'
   and title in ('Caring for Quolffin the axolotl')
    or id = '<new-thread-id>';
```

Deleting the test thread also drops its `context_recall_payload`
(the column lives on the row). No other state is dirtied - the
umbrella-tool step writes no cache.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
