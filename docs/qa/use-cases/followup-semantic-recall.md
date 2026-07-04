# Follow-up semantic surfacing: the recipe hallucination killed

> **Planning draft with a runnable baseline.** The follow-ups
> feature is not built, but **steps 1-3 run against CURRENT code**
> and reproduce the cross-conversation outcome hallucination the
> feature exists to fix - execute them BEFORE the implementation
> lands and log the run; that baseline is the regression evidence
> the post-change run is compared against (see
> [dev: followups (in progress)](../../dev/in-progress/followups.md)
> and the QA ordering rules in `CLAUDE.md`). Steps 4+ are the
> post-feature spec.

## Covers

The semantic surfacing axis and the close-on-answer lifecycle:

- **The bug (baseline)** - recall surfaces "user planned recipe
  X" without unresolved status, and the model asserts the recipe
  was made ([dev: context-recall](../../dev/context-recall.md)).
- **The fourth gather arm** - an open follow-up matching the
  derived query rides `gatherContextIndex` alongside memories,
  and the smoothing pass frames it as unresolved: never assert
  the outcome, ask when natural.
- **Pre-date framing** - a semantically matched loop whose
  `relevant_after` is still in the future reads as "planned,
  hasn't happened yet", not as a prompt to ask how it went.
- **Close on answer** - when the user reports the outcome
  (asked or unprompted), the model closes the loop with a
  `resolution` and the durable outcome lands in `memories`; the
  loop stops surfacing as open afterward.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev
  user (`dev@nak.local` / `devpass123`).
- Context recall enabled (Settings toggle on; it is the default).
- Logs drawer open at Debug, source filter `context-recall`.
- For the baseline arm: no special state - a fresh account or
  any account without prior lasagna history is cleanest.
- For the post-feature arm (steps 4+): one open follow-up seeded
  and embedded. Seed via a step-1-style planning conversation
  (preferred - exercises capture) or directly:

  ```sql
  insert into public.followups
    (user_id, question, context, status, relevant_after)
  values
    ('<UID>', 'Ask how the lasagna turned out',
     'Planned a ricotta lasagna for Saturday dinner',
     'open', now() - interval '1 day');
  -- then wait for (or trigger) the embeddings backfill so the
  -- row is semantically searchable; confirm:
  select embedding is not null from public.followups
   where user_id = '<UID>';
  ```

## Steps

1. **Baseline arm (current code - run before the feature
   lands).** In a fresh thread, plan a lasagna recipe for "this Saturday"
   over a few turns. Let the thread settle long enough for the
   summary/reflection machinery to see it (or force reflection as
   in [reflection-drain](./reflection-drain.md)) so the plan
   exists in the persistent layers.
2. Open a NEW thread and ask a detail question that presumes
   nothing about the outcome: "About that lasagna recipe - could
   I substitute ricotta with cottage cheese?"
3. Read the reply and the Recall modal's injected note. Record
   verbatim any claim about whether the lasagna was MADE.
4. **Post-feature arm.** With the precondition follow-up seeded
   and embedded, repeat step 2 in a new thread.
5. Open the Recall modal for that turn; inspect the injected
   note and the cached payload:

   ```sql
   select context_recall_payload->>'note'
     from public.threads where id = '<THREAD_ID>';
   ```

6. Answer the model's ask (or volunteer): "I made it Saturday -
   came out too salty." Send.
7. Check the row and the memory store:

   ```sql
   select status, resolution from public.followups
    where user_id = '<UID>';
   select label, data from public.memories
    where user_id = '<UID>'
    order by created_at desc limit 3;
   ```

   If no outcome memory exists yet (the volitional write is
   optional judgment, not a close requirement), force the
   reflection pass on the answering thread (the
   [reflection-drain](./reflection-drain.md) lever) and re-run
   the memory query - reflection is the guaranteed path.
8. Open one more fresh thread and ask another lasagna question.

## Expected

- Step 3 (baseline, current code): the failure reproduces - the
  reply or the injected note treats the recipe as made, or
  hedges toward it, without the user ever saying so. If current
  code already never asserts the outcome, log that: the feature's
  headline claim needs re-examining.
- Step 4-5: the injected note mentions the plan AND its
  unresolved status; the reply answers the substitution question
  WITHOUT asserting the lasagna was made, and either asks how it
  went or acknowledges it hasn't been confirmed. The gather log
  line shows a nonzero follow-ups hit count.
- Step 6-7: the follow-up row is `status='answered'` with a
  `resolution` mentioning the outcome ("made it; too salty"),
  via a visible `followup_close` call. An outcome memory exists
  - immediately if the model wrote one volitionally, otherwise
  after the forced reflection pass. No duplicate outcome
  memories after reflection runs (the search-before-create +
  librarian-consolidation discipline holds).
- Step 8: the injected note no longer raises the question as
  open - the recalled story is the outcome memory ("made it, too
  salty"), not "outcome unknown".

## Cleanup

```sql
delete from public.followups where user_id = '<UID>';
delete from public.memories
 where user_id = '<UID>' and data ilike '%lasagna%';
```

Optionally delete the test threads.

## Results log

| Date | Env | Commit | Result | Notes |
|---|---|---|---|---|
| - | - | - | - | Baseline arm (steps 1-3) runnable now; run before implementation. |
