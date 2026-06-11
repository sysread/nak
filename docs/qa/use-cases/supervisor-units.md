# Supervisor units: auto-title, summary, and topic tagging

## Covers

The browser supervisor worker (`src/lib/agents/supervisor/`) and the
five claim-based units it rotates through: auto_title, topics,
memory_topics, recipe_topics, summary
([dev: auto-title](../../dev/auto-title.md),
[dev: summaries](../../dev/summaries.md),
[dev: topics](../../dev/topics.md),
[dev: logging](../../dev/logging.md)). One lease
(`worker_kind = 'supervisor'`), per-row claim RPCs, per-unit drawer
sources (`auto-title-worker`, `topics-worker`, `memory-topics-worker`,
`recipe-topics-worker`, `summary-worker`, plus `supervisor-worker`
for lease events).

## Preconditions

- Local stack up, signed in as the dev user, Logs drawer open at
  `Debug+` (picked-up/saved lines are info; claim-lost lines are
  debug).
- The tab has been open long enough for the supervisor to hold its
  lease. Confirm:

  ```sql
  select worker_kind, holder_id, expires_at
    from worker_leases where worker_kind = 'supervisor';
  ```

  A hard reload can orphan the lease until its TTL (300s) expires -
  if `expires_at` is in the past or the holder never heartbeats,
  wait it out; the new worker polls every 20s.
- Memory and recipe rows to re-arm (capture their current `topics`
  first if you care about restoring them - the worker will replace
  them with fresh model output):

  ```sql
  update memories set last_topics_at = null,
         topics_claim_holder = null, topics_claim_expires = null
   where id = (select id from memories order by updated_at limit 1);
  update recipes set last_topics_at = null,
         topics_claim_holder = null, topics_claim_expires = null
   where id = (select id from recipes order by updated_at limit 1);
  ```

## Steps

1. Start a new conversation and send one message with a clear,
   nameable subject (e.g. "My sourdough starter smells like acetone -
   what does that mean?"). Let the turn complete. Note the thread id:

   ```sql
   select id, title from threads order by created_at desc limit 1;
   ```

2. Run the memory/recipe re-arm SQL from Preconditions.
3. Wait for the next supervisor rotation - up to 5 minutes
   (`idleIntervalMs` 300000). Watch the drawer. On `progress` the
   supervisor re-rotates immediately, so all seeded work drains in
   one burst once it wakes.
4. Verify the DB stamps:

   ```sql
   select title, title_manually_set, summary is not null as has_summary,
          last_summarised_msg_id is not null as summary_stamped,
          topics, last_topics_msg_id is not null as topics_stamped,
          auto_title_claim_holder, topics_claim_holder, summary_claim_holder
     from threads where id = '<thread-id>';
   select topics, last_topics_at from memories
    where id = '<re-armed-memory-id>';
   select topics, last_topics_at from recipes
    where id = '<re-armed-recipe-id>';
   ```

5. UI surfaces: the conversation drawer's topic-filter dropdown
   includes the new thread topics with counts; the Memories panel's
   and Cookbook's topic dropdowns include the re-armed rows' topics.

## Expected

- (1) The new thread appears in the conversation drawer titled
  "New conversation" (the placeholder auto-title keys on).
- (3) Drawer shows, within one or two rotations, in unit order
  (auto_title -> topics -> memory_topics -> recipe_topics ->
  summary): `[auto-title-worker]` picked-up + `titled thread <id>:
  <title>` lines; `[topics-worker]` picked-up (with `vocab=N`) +
  `tagged thread <id>: [...]`; `[memory-topics-worker]` and
  `[recipe-topics-worker]` picked-up + tagged pairs;
  `[summary-worker]` picked-up + `finished thread <id> (N messages
  in)`. The sidebar title flips from the placeholder WITHOUT the
  thread re-sorting (title/topics/summary saves do not bump
  `updated_at`).
- (3) Ordering wrinkle: the topics claim excludes placeholder-titled
  threads so auto-title gets first crack. Auto_title runs first in
  the same rotation, so the thread usually titles and tags in one
  burst; tagging landing one rotation later is also a pass.
- (4) Thread row: real title, `title_manually_set` false, summary
  non-null, summary stamped, topics non-empty, topics stamped, all
  three claim-holder columns null. Memory and recipe rows: topics
  non-empty, `last_topics_at` not null.
- (5) All three topic dropdowns list the new topics. Conversation
  search is semantic (thread embedding): the summary save re-queues
  the thread for embedding - an `[embeddings] embedded 1 item(s)`
  line follows the `[summary-worker] finished` line - and a
  summary-only term (one absent from the title and every message)
  then surfaces the thread among the semantic matches.
- Idle posture: once the queues drain, subsequent rotations emit no
  info-level drawer lines - an empty pass is silent at `Debug+`.

## Cleanup

None required - the worker performed real work on real rows. If the
re-armed memory/recipe topics must match their prior values, restore
the captured arrays:

```sql
update memories set topics = '{<prior>}' where id = '<id>';
update recipes set topics = '{<prior>}' where id = '<id>';
```

(Direct topic writes don't null `last_topics_at` - only label/data
or title/cooklang changes re-queue the row.)

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-11 | local | 3f43943 | pass (1-4) | browser-supervisor baseline (pre-C1 port): all five units drained in one rotation burst at the 5-min idle wakeup, in UNITS order within 8s - auto-title picked-up/titled, topics tagged [baking, sourdough] (vocab=9), memory + recipe tagged, summary finished; same-rotation title-then-tag confirmed (topics claim 9ms after title save); DB stamps all green incl. terminal-msg match on both summary and topics; updated_at untouched by the saves; claim columns null |
| 2026-06-11 | local | 3f43943 | pass (5) | thread dropdown gained baking/sourdough w/ counts; Memories dropdown untagged (0); Cookbook dropdown untagged (0); summary-only term "starvation" surfaced the thread via semantic search after the post-summary re-embed ([embeddings] line followed summary-worker finish). Bonus: a reflection-minted memory entered the memory_topics queue mid-run and tagged in the same burst |
