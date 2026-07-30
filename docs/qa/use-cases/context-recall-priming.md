# Context recall: smoothed recollection, citations, and self-healing

## Covers

The topic-boundary recall pipeline and everything that keeps its
injected recollection honest:

- **Smoothing render.** At a topic boundary (thread start / mood shift /
  stale fuse) the pipeline gathers deterministically across the three
  persistent layers (memories, prior conversations, wiki), then runs ONE
  fast-tier completion that compresses the hits into a first-person,
  past-anchored, relevance-bridged recollection with `^N^` citations,
  and injects it as a synthetic `<think>` turn the conscious response
  reads as its own.
- **Temporal laundering.** A stored memory whose text carries
  encoding-time framing ("this session", a write-date) is re-anchored on
  the row's real recorded date at recall time, so the model never reads a
  recalled fact as a current-chat event.
- **Citations UI.** The Recall diagnostics modal renders each entry's
  `^N^` superscripts and a Sources slide-down that links to the cited
  memory / conversation / wiki.
- **Self-healing writes.** The reflection writer produces timeless
  memories; the rem / deep-sleep librarians carry a framing-only reshape
  that de-poisons older rows on their cadence.

Dev refs: [context-recall](../../dev/context-recall.md),
[memory](../../dev/memory.md),
[conversation-recall](../../dev/conversation-recall.md),
[wiki](../../dev/wiki.md),
[intuition](../../dev/intuition.md) (shared trigger evaluator),
[logging](../../dev/logging.md).

This case is the AUTOMATIC, reflexive pipeline plus its write-side
hygiene. The model-callable per-layer recall AGENTS (`memory_recall` and
siblings) are a different tier, covered by
[chat-recall-agents](./chat-recall-agents.md) - do not conflate the two.
The librarian sweep mechanics (cadence, claim, guard) are covered in
depth by [memory-librarians](./memory-librarians.md); the reflection
drain by [reflection-drain](./reflection-drain.md). This case checks only
the recall-quality properties those subsystems now owe.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev user
  (`dev@nak.local` / `devpass123`).
- A working Venice key configured for the local stack: the smoothing
  render is a live model call. With no key the pipeline degrades to "no
  recall injected this turn" and steps 3-7 cannot pass - confirm the key
  before starting.
- Logs drawer open, level filter `debug`. The pipeline logs under source
  `context-recall`; pin that source once entries appear.
- Seed recallable rows across the three layers, anchored on a
  distinctive token (`Quolffin`) so the seeds rank as a STRONG semantic
  match for the test query. Retrieval here is vector/semantic, not
  token-matching: the token makes the seeds rank high, it does NOT
  isolate them. The populated dev store returns other semantically-near
  rows too, so the seeds are a subset of each layer's hits, not the
  whole of it.

  The MEMORY layer is seeded as a small CLUSTER of related-but-distinct
  rows, each carrying ENCODING-TIME POISON ("this session", "today",
  "just now") in its body and a BACKDATED `created_at`. The cluster
  serves two steps: the smoothing pass must launder the framing and
  anchor the facts on the April dates (step 5), and the rows must be
  cosine-near enough that the deep-sleep similarity sweep fetches them
  as ONE batch (step 9 - a lone memory has no neighbors above the
  threshold and is never visited). Capture every `returning id`.

  ```sql
  -- Dev user id.
  select id from auth.users where email = 'dev@nak.local';

  -- Layer 1 - memory CLUSTER. Three cosine-near axolotl-care rows, each
  -- POISONED ("this session"/"today"/"just now") and backdated. The
  -- smoothing pass must launder the framing and anchor on the April
  -- dates while preserving the facts (Quolffin, 18C); deep-sleep must
  -- see the rows as one similarity batch.
  insert into public.memories
         (user_id, label, data, confidence, embedding, created_at)
  values
    ('<user>', 'AXOLOTL CARE LOG (this session)',
     'AXOLOTL CARE LOG (this session): The user keeps a pet axolotl '
     || 'named Quolffin, and today we set the tank to 18C.',
     1.0, null, '2026-04-01T12:00:00Z'),
    ('<user>', 'AXOLOTL TANK NOTES (this session)',
     'AXOLOTL TANK NOTES (this session): just now we noted Quolffin''s '
     || 'tank needs a chiller to hold 18C through summer.',
     1.0, null, '2026-04-01T12:05:00Z'),
    ('<user>', 'AXOLOTL TANK RANGE (this session)',
     'AXOLOTL TANK RANGE (this session): today we agreed Quolffin''s '
     || 'tank should stay between 16C and 18C and never go above 20C.',
     1.0, null, '2026-04-01T12:10:00Z')
  returning id;
  -- All three center on Quolffin's tank temperature, so they cluster:
  -- each row has at least one neighbor at cosine >= 0.80 (the deep-sleep
  -- neighbor threshold), so whichever row deep-sleep seeds on, a batch
  -- of >= 2 forms and the cluster gets visited. Drifting one row onto a
  -- different topic (feeding, habitat) drops it below 0.80 and it stops
  -- clustering - keep the three on temperature.

  -- Layer 2 - a prior conversation (cited by id). Token in the TITLE.
  insert into public.threads (user_id, title, summary)
  values ('<user>', 'Caring for Quolffin the axolotl',
          'We discussed tank temperature and feeding schedule for Quolffin.')
  returning id;

  -- Layer 3 - a wiki article (cited by id). Token in the title; no
  -- source rows, so it survives the sole-source exclusion.
  insert into public.wiki_articles (user_id, title, content, embedding)
  values ('<user>', 'Quolffin (axolotl)',
          'Quolffin is the user''s axolotl. Lives in a chilled tank.', null)
  returning id;
  ```

- The seeds insert with `embedding` NULL, but the gather is VECTOR
  search (`search_memories_by_embedding` and siblings skip
  NULL-embedding rows) - so the rows are invisible to recall until the
  dev backfill cron embeds them. Before sending the turn, watch the
  Logs drawer (source `embeddings`) for an `embedded N items in the
  background` line covering the seeds. A turn sent BEFORE that lands
  gathers nothing - that is a timing race, not a feature failure.

- Force the boundary via COLD START: a brand-new thread has no cached
  recall payload, so the trigger evaluator returns `cold` and the
  pipeline fires unconditionally on the first response. (`mood` and
  `stale` are the other live triggers; their evaluator behaviour is
  exercised by [intuition-pipeline](./intuition-pipeline.md).)

## Steps

1. Start a NEW conversation. Send a first message strongly aligned to
   the seeds (axolotl + tank + temperature, not just the bare token) so
   the derived query is a strong semantic match, e.g.:

   > What temperature should I keep Quolffin the axolotl's tank at?

2. While the reply forms, watch the streaming card's subconscious
   checklist for the `recall` row (start -> clear).

3. After the reply settles, read the `context-recall` source in the Logs
   drawer: a `pipeline starting` line `{ trigger: 'cold', round: 1 }`,
   then a `pipeline complete` line with per-layer hit counts and a
   `citationCount`.

4. Inspect the persisted cache:

   ```sql
   select context_recall_payload -> 'trigger'    as trigger,
          context_recall_payload -> 'note'       as note,
          context_recall_payload -> 'citations'  as citations,
          context_recall_payload -> 'v'          as version
     from public.threads where id = '<new-thread-id>';
   ```

5. Read the `note` value against the laundering + fidelity contract
   (Expected 5).

6. Confirm the injected recollection reached the model: the reply should
   answer the tank question using the recalled facts WITHOUT a preceding
   tool call, treating the memory as something recalled (not as the user
   having just said it).

7. **Citations UI.** Open the Recall modal (the light-bulb pill, bottom-right pill
   column). On the entry for this turn: (a) confirm the note renders with
   superscript citation numbers; (b) click a superscript - the Sources
   panel opens and the matching row pulses; (c) click that source row -
   the app navigates to the cited memory / conversation / wiki article
   and the modal closes.

8. **Timeless writer (reflection).** In a SEPARATE existing thread (>= 2
   user messages, last activity on a prior calendar day so the drain is
   eligible), hold a short exchange that teaches one clear new fact about
   the user. Let reflection run (the hourly sweep; see
   [reflection-drain](./reflection-drain.md) to force it). Inspect the
   newest memory:

   ```sql
   select label, data, created_at from public.memories
    where user_id = '<user>' order by created_at desc limit 3;
   ```

9. **Reshape (librarian).** Deep-sleep seeds on the OLDEST
   never-visited memory, then pulls that seed's cosine-near neighbors
   into one batch. The backfill embed bumps the freshly-seeded cluster
   rows' `updated_at` to the BACK of the never-visited queue, so in a
   populated store a manual run would seed elsewhere and never reach
   the cluster. Make the cluster the next seed by stamping every OTHER
   never-visited memory as already visited:

   ```sql
   update public.memories set last_librarian_visit_at = now()
    where user_id = '<user>' and last_librarian_visit_at is null
      and label not like 'AXOLOTL %';
   ```

   Then open the Memories panel and trigger a MANUAL deep-sleep run
   (the moon button). A manual run ignores the cadence slot gate the
   scheduled sweep honours. The seed pick now lands on a cluster row,
   and the other two rows ride in as neighbors (a lone memory has no
   neighbors above the threshold and never forms a batch - which is why
   the seed is a cluster, not a single row). Note: rem is NOT a
   substitute here - it drains the recall-AGENT hint queue, which the
   deterministic pipeline and `memory_search` do not feed. After
   deep-sleep finishes, read its log for the batch it was handed (to
   confirm the cluster rows appear), then re-read the rows and the
   changelog:

   ```sql
   select id, data, confidence from public.memories
    where user_id = '<user>' and label like 'AXOLOTL %';
   select memory_id, kind, message, created_at from public.memory_changelog
    where memory_id = any('{<cluster-ids>}'::uuid[])
    order by created_at desc limit 5;
   ```

10. **On-demand + negative state.** Exercise the umbrella `context` tool as the explicit on-demand path
    over the same gather. In a chat turn:

    > Call the context tool with the topic "Quolffin" and tell me the raw
    > result.

    Watch the `context-tool` source and the tool-result row.

## Expected

- (2) The `recall` subconscious row appears while the pipeline runs and
  clears when it finishes (brief on a fast stack).
- (3) `context-recall` shows `pipeline starting` with
  `{ trigger: 'cold', round: 1 }`, then `pipeline complete`. The
  per-layer counts are corpus-dependent: each of `memoryCount`,
  `conversationCount`, `wikiCount` is `>= 1`, but the populated dev
  store contributes other semantically-near rows, so expect counts
  above 1 (a run observed 6 / 5 / 2). The seeds are a subset of those
  hits, NOT the whole count. `citationCount` is `>= 1`. The
  deterministic anchor is that the seeded memory surfaces and is cited
  (below), not the raw counts.
- (4) `trigger` is `"cold"`; `version` is `2`; `note` is a non-empty
  string; `citations` is an array whose entries are
  `{ index, kind, id, label }`, with `kind` in
  `memory|conversation|wiki`. At least one citation resolves to a
  SEEDED memory row (its fact is the cited claim, its `id` one of the
  cluster ids). The conversation / wiki seeds MAY also be cited but
  need not be - the smoothing pass cites a non-deterministic subset of
  the gathered index, so do not require all three seed ids to appear.
- (5) The `note`, read as prose:
  - **Laundered.** Does NOT contain "this session", "today", or any
    phrasing that places the facts in the CURRENT conversation. It reads
    as a past recollection (anchored on the April 2026 date or otherwise
    clearly prior), not a current-chat event. This is the core fix - a
    fail here is the original bug.
  - **Faithful.** Preserves the seeded specifics exactly - the name
    "Quolffin" and the figure "18C" survive unaltered (no drift to 17C /
    19C, no invented numbers).
  - **Bridged + cited.** Connects the recollection to the tank question,
    and carries `^N^` superscripts that resolve to the `citations` array.
- (6) The reply answers from the recalled tank fact (18C). The model
  MAY also drill in via `memory_search` / `memory_get` to verify the
  unfamiliar name - that is allowed, not a failure. But note the
  consequence: those drill-down reads return the RAW, still-poisoned
  row, so "today" / "this session" framing can leak into the REPLY
  until that row is reshaped (step 9). That interim leak is EXPECTED:
  read-time laundering sanitises the injected note (Expected 5), which
  is the contract; the stored row is cleaned over time by self-healing,
  not at every drill-down read. Do NOT read a "today" in the reply as a
  laundering failure - check the `note` (Expected 5).
- (7) The superscript click opens + flashes the Sources panel; the
  source-row click lands on the correct surface (the Quolffin memory card
  / the prior conversation / the wiki article) and dismisses the modal.
  (Cloud agents cannot run this; it is a browser check.)
- (8) The newly written memory's `data` states the taught fact
  TIMELESSLY: no "this session" / "this conversation" / "today", no
  write-date stamp, no first-person AI narration ("I had to...", "what I
  got wrong"). The fact itself is intact.
- (9) Deep-sleep VISITED the cluster: the batch in the `deep-sleep`
  log includes the seeded rows (this is the hard part of the check -
  if the batch never formed, the cluster is too small or not cosine-
  near, a precondition problem, not a librarian one). Reshape itself is
  OPPORTUNISTIC, not guaranteed: the LLM agent may reshape a poisoned
  row (dropping "(this session)" / "today" / "just now" while
  preserving the facts - Quolffin, 18C, the 16-18C range, the chiller),
  it may
  consolidate near-duplicate rows, or it may leave the batch alone. If
  ANY row was reshaped, verify the facts survive, `confidence` is
  unchanged from 1.0 (reshape never touches confidence), and a
  `memory_changelog` row of kind `update` records it. A visited-but-
  unreshaped batch is a SOFT pass worth noting, not a hard fail.
  Reshape is opportunistic store hygiene, not a gated guarantee.
- (10) `context-tool` shows the umbrella tool firing; its result row
  carries the structured index
  (`{ memories: [...], conversations: [{id,title}], wiki: [{id,title}] }`)
  - structured, NOT wrapped in `<think>`, and with no cache write.
- Negative state (optional): a fresh thread whose first message shares no
  token with any recallable row yields a `pipeline complete` with all
  counts `0` and a cached payload with `note: ""` and `citations: []`.
  The empty note is a VALID cached state (it holds the same-round
  debounce); no `<think>` block is injected. Do not read an all-zero run
  as a failure.

## Cleanup

Delete the seeded rows and the test threads. Run after recording
results.

```sql
delete from public.memories
 where user_id = '<user>' and label like 'AXOLOTL %';
delete from public.wiki_articles
 where user_id = '<user>' and title = 'Quolffin (axolotl)';
delete from public.threads
 where user_id = '<user>'
   and (title = 'Caring for Quolffin the axolotl' or id = '<new-thread-id>');
-- memory_changelog.memory_id is ON DELETE SET NULL, so reshape rows are
-- orphaned (memory_id null), not dropped, when the memories go - harmless
-- test residue. The step-8 reflection memory can be left or deleted by
-- its label.
```

Deleting the test thread also drops its `context_recall_payload` (the
column lives on the row).

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-25 | local (`dev-start`, dev@nak.local) | 07c6f10 | Pass (core); doc corrected | Baseline run, code sound; this commit rewrites the doc to match it. Smoothing note laundered (April-anchored, no "today"/"this session"), faithful (Quolffin/18C), `^N^` cited - the core fix (5) solid. Citations UI end-to-end browser-verified (7): superscript opens Sources, source row navigates to the memory, modal closes. `context` umbrella tool fires structured, no tool-layer cache write (10). Injected `<think>` reached the model (its reasoning quoted the block). Defects found + fixed in the doc: per-layer counts were 6/5/2 not 1/1/1 (retrieval is vector + backfill-embed, not token text-probe - precondition + (3)/(4) rewritten); step-9 reshape was unreachable for a lone memory, reworked into a cosine-clustered triple (>=0.80, validated) + a seed-priming UPDATE so deep-sleep visits it - manual run then reshaped all 3 (poison stripped, confidence 1.0, `update` changelog rows). Documented the interim drill-down leak: `memory_search`/`memory_get` return the raw poisoned row, so "today" can surface in the reply until reshape cleans the store ((6) rewritten; dev-doc note added). |
