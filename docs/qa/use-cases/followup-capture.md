# Follow-up writers: volitional save, reschedule, reflection backfill + close

> Written as the behavioral spec BEFORE the implementation; the
> feature now exists and the names below are the real ones. Not yet
> executed - run it and start the results log.

## Covers

The two writers of the `followups` table and the dedup between
them ([dev: followups](../../dev/followups.md)):

- **Volitional capture** - the chat model saves a follow-up
  mid-turn via the followups combo (op=save) when the user shares a plan
  with a natural "how did it go" horizon. This is the
  model-leaves-itself-a-reminder path.
- **Date extraction** - a plan with a stated date yields
  `relevant_after` just past that date; a plan with no date
  yields null (semantic-only surfacing, no proactive ask).
- **Reschedule** - a plan that moved is a `followups` save with
  the row's id (new `relevant_after`, same row, still open), not a
  close and not a second create.
- **Subconscious capture** - the reflection agent
  ([dev: memory](../../dev/memory.md)) records unresolved plans
  from settled threads, so capture works even when the mid-turn
  save didn't happen.
- **Subconscious close** - reflection is the resolution backstop:
  a settled transcript that resolved a loop the chat model never
  closed (outcome volunteered unprompted) gets closed by
  reflection. Reflection is the ONLY background
  agent with follow-up tools - see the dev note's single-
  background-writer rule.
- **Dedup** - the same plan discussed twice produces ONE open
  row; both writers check whether the question is already open
  OR already answered before creating (the answered check is the
  stale re-creation guard - see the dev note).

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev
  user (`dev@nak.local` / `devpass123`).
- Logs drawer open at Debug, source filter on the tool dispatch
  and `reflection` sources.
- Dev user id for the SQL checks:

  ```sql
  select id from auth.users where email = 'dev@nak.local';
  ```

## Steps

1. In a fresh thread, plan something with a clear date horizon:
   "Help me plan a lasagna for Saturday dinner" and iterate a
   couple of turns until the plan feels settled.
2. Inspect the tool-call panel on the assistant turns and the
   `followups` table:

   ```sql
   select question, context, status, relevant_after,
          source_thread_id
     from public.followups
    where user_id = '<UID>'
    order by created_at desc;
   ```

3. In the SAME thread, restate the plan ("so to recap, lasagna
   on Saturday") and send.
4. Re-run the step-2 query.
5. Move the plan: "Change of plans - we're eating out Saturday,
   I'll make the lasagna Sunday instead." Send, then re-run the
   step-2 query.
6. In a SECOND fresh thread,
   describe a different plan with no date: "I'm thinking about
   asking my manager for a scope change, not sure when." End the
   conversation.
7. Force the reflection pass on that thread (same lever as
   [reflection-drain](./reflection-drain.md): reset
   `threads.last_reflected_msg_id` and trigger a turn tail or
   the hourly sweep route), then re-run the step-2 query.
8. In a THIRD fresh thread, volunteer
   the lasagna outcome unprompted: "By the way, I made the
   lasagna Sunday - the family loved it." Let the thread end.
9. Force the reflection pass on that thread, then re-run the
   step-2 query.

## Expected

- Step 2: exactly one `followups` row for the lasagna plan -
  `status='open'`, `question` a first-person ask ("Ask how the
  lasagna turned out" or similar), `context` mentioning the
  plan, `relevant_after` on or just after Saturday,
  `source_thread_id` = the thread. The followups save call (op=save) is
  visible in the tool-call panel with an activity line.
- Step 4: STILL exactly one open lasagna row - the restate did
  not mint a twin.
- Step 5: still the SAME row (same id), now with `relevant_after`
  on or just after Sunday, still `open` - a visible `followups`
  op=save call carrying the id, no close, no second create.
- Step 7: a new open row for the manager conversation, created
  by reflection (no tool call in the chat transcript; the
  reflection log lines show the create). `relevant_after` is
  NULL - no stated date, so no proactive-ask basis.
- Step 9: the lasagna row is `status='answered'` with a
  `resolution` mentioning the outcome, closed by REFLECTION (no
  `followups` op=close call in any chat transcript; the reflection log
  lines show the close). The manager row is untouched - closing
  is per-loop judgment, not a sweep.
- At no point does a row exist for chit-chat without a pending
  outcome - capture is judgment-gated, not every-plan-mechanical.

## Cleanup

```sql
delete from public.followups where user_id = '<UID>';
```

Optionally delete the two test threads from the drawer.

## Results log

| Date | Env | Commit | Result | Notes |
|---|---|---|---|---|
| 2026-11-03 | local, wt-nak/tool-combos | f0f19a58+ (pre-M6 baseline) | PASS steps 1-5, 8; steps 6/7/9 BLOCKED (reflection day gate - threads created today are unclaimable; backdate via service-role SQL or wait a day) | Baseline before followup_* -> `followups` combo. Tool ledger captured: the dedup shape is followup_list (no args) before every write; create = followup_save without id (question/context/relevant_after); reschedule = with id; close = id + resolution (status -> answered). F1: the save schema's wire-required `question` rejects a pure reschedule ({id, context, relevant_after}) - the combo drop of that required FIXES this (the handler's create-side check owns it). F2: the chat model closes follow-ups itself when the outcome is volunteered (doc says only reflection does - doc needs rewording). F3: model side effects (recipe + record) - cleanup must cover them. F4: relevant_after stores UTC midnight (day boundary is UTC, not the user's tz). |
