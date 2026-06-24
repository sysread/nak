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
- Seed one recallable row in EACH of the three layers, all keyed on a
  single distinctive nonsense token (`Quolffin`) so retrieval is
  deterministic and isolated. The memory row is seeded with
  ENCODING-TIME POISON in its body and a BACKDATED recorded date, so
  laundering and self-healing are observable. Capture the three
  `returning id` values - the Expected section checks them.

  The rows leave `embedding` NULL on purpose: each layer's text probe
  (ILIKE / exact-title) matches the token regardless of whether the live
  query embeds, which is what makes the gather deterministic for this
  test.

  ```sql
  -- Dev user id.
  select id from auth.users where email = 'dev@nak.local';

  -- Layer 1 - memory. POISONED body ("this session", "today") + a
  -- backdated created_at. The smoothing pass must launder the framing
  -- and anchor on the April date, while preserving the facts (the name
  -- Quolffin, 18C).
  insert into public.memories
         (user_id, label, data, confidence, embedding, created_at)
  values ('<user>',
          'AXOLOTL CARE LOG (this session)',
          'AXOLOTL CARE LOG (this session): The user keeps a pet axolotl '
          || 'named Quolffin, and today we set the tank to 18C.',
          1.0, null, '2026-04-01T12:00:00Z')
  returning id;

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

- Force the boundary via COLD START: a brand-new thread has no cached
  recall payload, so the trigger evaluator returns `cold` and the
  pipeline fires unconditionally on the first response. (`mood` and
  `stale` are the other live triggers; their evaluator behaviour is
  exercised by [intuition-pipeline](./intuition-pipeline.md).)

## Steps

1. Start a NEW conversation. Send a first message carrying the token so
   the derived query points at the seeds, e.g.:

   > What temperature should Quolffin's tank be?

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
   the user. Let reflection run (chat-turn tail, or the hourly sweep; see
   [reflection-drain](./reflection-drain.md) to force it). Inspect the
   newest memory:

   ```sql
   select label, data, created_at from public.memories
    where user_id = '<user>' order by created_at desc limit 3;
   ```

9. **Reshape (librarian).** With the poisoned Quolffin memory still
   present, open the Memories panel and trigger a manual deep-sleep run
   (the moon button) - or a rem run (the shuffle button). After it
   finishes, re-read the Quolffin memory and its changelog:

   ```sql
   select data from public.memories where id = '<memory-id>';
   select kind, message, created_at from public.memory_changelog
    where memory_id = '<memory-id>' order by created_at desc limit 3;
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
  `{ trigger: 'cold', round: 1 }`, then `pipeline complete` with
  `memoryCount: 1, conversationCount: 1, wikiCount: 1` and a
  `citationCount` >= 1 (the note cited at least one of the three).
- (4) `trigger` is `"cold"`; `version` is `2`; `note` is a non-empty
  string; `citations` is an array whose entries are
  `{ index, kind, id, label }`, with `kind` in
  `memory|conversation|wiki` and the `id`s drawn from the three seeded
  rows.
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
- (6) The reply answers from the recalled tank fact with no preceding
  tool call, and frames the conversation / wiki items as leads it could
  open, not as content already read.
- (7) The superscript click opens + flashes the Sources panel; the
  source-row click lands on the correct surface (the Quolffin memory card
  / the prior conversation / the wiki article) and dismisses the modal.
  (Cloud agents cannot run this; it is a browser check.)
- (8) The newly written memory's `data` states the taught fact
  TIMELESSLY: no "this session" / "this conversation" / "today", no
  write-date stamp, no first-person AI narration ("I had to...", "what I
  got wrong"). The fact itself is intact.
- (9) The Quolffin memory's `data` has been rewritten to drop the
  "(this session)" / "today" framing while preserving the facts (Quolffin,
  18C); a `memory_changelog` row of kind `update` records the reshape.
  Its `confidence` is unchanged from 1.0 (reshape never touches
  confidence). NOTE: the librarian is an LLM agent and may choose not to
  act on a given run - if `data` is unchanged, re-read the prompt-fed
  batch in the `deep-sleep` / `rem` logs to confirm the row was visited,
  and re-run; a visited-but-left row is a soft fail worth noting, not a
  hard one.
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
 where user_id = '<user>' and id = '<memory-id>';
delete from public.wiki_articles
 where user_id = '<user>' and title = 'Quolffin (axolotl)';
delete from public.threads
 where user_id = '<user>'
   and (title = 'Caring for Quolffin the axolotl' or id = '<new-thread-id>');
-- The reshape changelog row drops with the memory (memory_id cascades);
-- the step-8 reflection memory can be left or deleted by its label.
```

Deleting the test thread also drops its `context_recall_payload` (the
column lives on the row).

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
