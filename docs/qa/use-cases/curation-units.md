# Curation units: auto-title, summary, and topic tagging

## Covers

The venice function's five curation units - auto_title, thread
topics, summary, memory_topics, recipe_topics
(`supabase/functions/venice/agents/curation.ts` and the per-unit
modules beside it) - and both of their drivers: the chat-turn
waitUntil tail and the hourly `/curation-sweep` cron route
([dev: auto-title](../../dev/auto-title.md),
[dev: summaries](../../dev/summaries.md),
[dev: topics](../../dev/topics.md),
[dev: logging](../../dev/logging.md)). Mutual exclusion is the
per-row claim columns; drawer sources are `auto-title`, `topics`,
`summary`, `memory-topics`, `recipe-topics`.

## Preconditions

- Local stack up, signed in as the dev user, Logs drawer open at
  `Debug+` (picked-up/saved lines are info; claim-lost lines are
  debug). The drawer lines arrive over the `logs:<userId>` realtime
  relay - no browser worker is involved.
- Memory and recipe rows to re-arm (capture their current `topics`
  first if you care about restoring them - the agent will replace
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

1. Run the memory/recipe re-arm SQL from Preconditions BEFORE the
   chat turn - the turn's tail is what should drain them.
2. Start a new conversation and send one message with a clear,
   nameable subject (e.g. "My sourdough starter smells like acetone -
   what does that mean?"). Let the turn complete. Note the thread id:

   ```sql
   select id, title from threads order by created_at desc limit 1;
   ```

3. Watch the drawer: the curation chain fires in the turn's tail,
   within seconds of the reply finishing.
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
   and Cookbook's topic dropdowns include the re-armed rows' topics;
   the sidebar title updated without the thread re-sorting.
6. Sweep driver: re-arm the memory row again (re-run its UPDATE from
   Preconditions), then POST the sweep route with the service-role
   key (`SR` from `supabase status -o json`):

   ```sh
   curl -s -X POST "http://127.0.0.1:54321/functions/v1/venice/curation-sweep" \
        -H "Authorization: Bearer $SR" -H "Content-Type: application/json" -d '{}'
   ```

## Expected

- (2) The new thread appears in the sidebar titled
  "New conversation" (the placeholder auto-title keys on).
- (3) Drawer shows, in unit order (auto-title -> topics -> summary
  -> memory-topics -> recipe-topics, the tail's sequential chain),
  within ~30s of the turn's `end terminalKind=completed` line: `[auto-title]` picked-up + `titled thread <id>: <title>`;
  `[topics]` picked-up (with `vocab=N`) + `tagged thread <id>:
  [...]`; `[memory-topics]` and `[recipe-topics]` picked-up + tagged
  pairs; `[summary]` picked-up + `finished thread <id> (N messages
  in)`.
- (3) The sidebar title flips from the placeholder WITHOUT the
  thread re-sorting (saves do not bump `updated_at`); the title
  arrives seconds after the turn ends, not on a rotation interval.
- (4) Thread row: real title, `title_manually_set` false, summary
  non-null, summary stamped, topics non-empty, topics stamped, all
  three claim-holder columns null. Memory and recipe rows: topics
  non-empty, `last_topics_at` not null.
- (5) All three topic dropdowns list the new topics. Conversation
  search is semantic (thread embedding): the summary save re-queues
  the thread for embedding - an `[embeddings] embedded 1 item(s)`
  line lands within the embed cron's 5-minute cadence - and a
  summary-only term (one absent from the title and every message)
  then surfaces the thread among the semantic matches.
- (6) The route answers `{"accepted":true}` immediately; the
  re-armed memory's `last_topics_at` repopulates and a
  `[memory-topics]` picked-up/tagged pair lands in the drawer
  (cross-user sweep claims attribute lines to the row's owner). An
  empty-queue sweep emits no drawer lines.
- Topics ordering wrinkle: the topics claim excludes
  placeholder-titled threads so auto-title gets first crack;
  auto-title runs first in the same chain, so the thread titles and
  tags in one pass.

## Cleanup

None required - the agents performed real work on real rows. If the
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
| 2026-06-11 | local | cd7eaee | pass (1-5) | post-C1 port, tail driver: full chain ran in 6.6s starting 3ms after `end terminalKind=completed` (baseline waited a 5-min rotation) - [auto-title] titled "Sticky cast iron after seasoning", [topics] tagged [cooking] reusing existing vocab (vocab=10), [summary] finished, [memory-topics] + [recipe-topics] re-tagged the re-armed rows w/ identical values; DB stamps all green, terminal-msg match, claims null, updated_at untouched; sidebar title flipped LIVE via realtime (the port's open-tab-freshness risk cleared); thread dropdown cooking 2->3; [embeddings] embedded the changed thread on the next browser-worker poll |
| 2026-06-11 | local | cd7eaee | pass (6) | sweep driver: POST /curation-sweep answered {"accepted":true}; the re-armed memory re-tagged ~1.2s later via the cross-user SECURITY DEFINER claim, drawer pair attributed to the owning user over the logs relay; empty queues emitted no lines |
