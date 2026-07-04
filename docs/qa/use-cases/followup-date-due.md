# Follow-up date-due surfacing: the off-topic ask, cooldown, expiry

> Written as the behavioral spec BEFORE the implementation; the
> feature now exists. The shipped constants live in
> `supabase/functions/_shared/followups.ts`: due cap 2, cooldown
> 20h, ask budget 3 surfacings, expiry 30 days past
> `relevant_after`. Not yet executed - run it and start the
> results log.

## Covers

The date axis and the anti-nag containment
([dev: followups](../../dev/followups.md)):

- **Due pull** - a loop whose `relevant_after` has passed is
  gathered deterministically at the next priming boundary
  (`cold` trigger at thread open being the main one), regardless
  of semantic match with the conversation topic
  ([dev: context-recall](../../dev/context-recall.md)).
- **Dispositional ask** - the injected framing is "you've been
  meaning to ask, raise it when natural", never a turn command;
  the model may skip a bad moment and the loop stays open.
- **Surfacing ledger** - the gather stamps `last_surfaced_at`
  and increments `surface_count` on the rows it pulls.
- **Cooldown** - a due loop surfaced recently is skipped by the
  next due pull, so consecutive threads in one day don't repeat
  the ask. Semantic matches are NOT cooldown-gated.
- **Expiry** - a loop unanswered after N surfacings or T days
  past `relevant_after` flips to `expired` and never surfaces
  again.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev
  user (`dev@nak.local` / `devpass123`), context recall enabled.
- Logs drawer open at Debug, source filter `context-recall`.
- One due follow-up seeded (embedding not required for the due
  pull, but seed it early so the backfill lands anyway):

  ```sql
  insert into public.followups
    (user_id, question, context, status, relevant_after)
  values
    ('<UID>', 'Ask how the big Thursday meeting went',
     'User had a high-stakes meeting with their VP on Thursday',
     'open', now() - interval '2 days');
  ```

## Steps

1. Open a fresh thread on an UNRELATED topic: "Help me plan a
   weekend hiking trip." Send the first message.
2. Read the reply and the Recall modal's injected note; check
   the ledger:

   ```sql
   select surface_count, last_surfaced_at, status
     from public.followups where user_id = '<UID>';
   ```

3. Do NOT answer the meeting question - continue about hiking
   for a turn, then open ANOTHER fresh thread on a third topic
   and send a message.
4. Re-run the step-2 query and read the second thread's injected
   note.
5. Back in either thread, answer the ask: "Oh right - the
   meeting went really well, they approved the budget."
6. Re-run the step-2 query; confirm a `followup_close` tool call
   and a new outcome memory (as in
   [followup-semantic-recall](./followup-semantic-recall.md)).
7. Expiry, forged via SQL (deterministic, like
   [samskara-decay](./samskara-decay.md)): seed a second due
   loop, then push it past the thresholds -

   ```sql
   update public.followups
      set surface_count = 3,
          last_surfaced_at = now() - interval '2 days',
          relevant_after = now() - interval '40 days'
    where user_id = '<UID>' and status = 'open';
   ```

   Open a fresh thread and send a message.
8. Re-run the step-2 query and read the injected note.

## Expected

- Step 2: the injected note carries the meeting question framed
  as a pending ask; the reply engages the hiking request and
  raises the meeting naturally (opener aside or a beat later) -
  it does NOT derail the thread or demand an answer. Ledger:
  `surface_count = 1`, `last_surfaced_at` fresh, still `open`.
- Step 4: the second thread's note does NOT repeat the meeting
  ask (cooldown holds); `surface_count` still 1. The loop is
  still `open`.
- Step 6: `status='answered'`, `resolution` mentions the budget
  approval; outcome memory written.
- Step 8: the forged loop is excluded from the note and reads
  `status='expired'` (lazy flip by the gather, or excluded with
  the flip landing per the shipped mechanics - either way it
  never surfaces again). No expired or answered loop ever
  re-appears in a later note.

## Cleanup

```sql
delete from public.followups where user_id = '<UID>';
delete from public.memories
 where user_id = '<UID>' and data ilike '%meeting%';
```

Optionally delete the test threads.

## Results log

| Date | Env | Commit | Result | Notes |
|---|---|---|---|---|
| - | - | - | - | Feature not yet built; no runs. |
