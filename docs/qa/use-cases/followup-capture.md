# Follow-up capture: volitional save, reflection backfill, dedup

> **Planning draft.** The follow-ups feature is not built; this
> case is part of its behavioral spec (see
> [dev: followups (in progress)](../../dev/in-progress/followups.md)).
> Tool names, table name, and SQL are the proposed design and may
> shift at implementation. Execute and start the results log once
> the feature lands.

## Covers

The two writers of the `followups` table and the dedup between
them ([dev: followups](../../dev/in-progress/followups.md)):

- **Volitional capture** - the chat model saves a follow-up
  mid-turn via `followup_create` when the user shares a plan
  with a natural "how did it go" horizon. This is the
  model-leaves-itself-a-reminder path.
- **Date extraction** - a plan with a stated date yields
  `relevant_after` just past that date; a plan with no date
  yields null (semantic-only surfacing, no proactive ask).
- **Reschedule** - a plan that moved is a `followup_update`
  (new `relevant_after`, same row, still open), not a close and
  not a second create.
- **Subconscious capture** - the reflection agent
  ([dev: memory](../../dev/memory.md)) records unresolved plans
  from settled threads, so capture works even when the mid-turn
  save didn't happen.
- **Dedup** - the same plan discussed twice produces ONE open
  row; both writers check whether the question is already open
  OR already answered before creating (the answered check is the
  stale re-creation guard - see the dev note).

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev
  user (`dev@nak.local` / `devpass123`).
- The follow-ups write toolbox enabled on the test thread (via
  the composer toolbox popover; exact box name per
  implementation).
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
6. In a SECOND fresh thread (follow-ups toolbox left OFF),
   describe a different plan with no date: "I'm thinking about
   asking my manager for a scope change, not sure when." End the
   conversation.
7. Force the reflection pass on that thread (same lever as
   [reflection-drain](./reflection-drain.md): reset
   `threads.last_reflected_msg_id` and trigger a turn tail or
   the hourly sweep route), then re-run the step-2 query.

## Expected

- Step 2: exactly one `followups` row for the lasagna plan -
  `status='open'`, `question` a first-person ask ("Ask how the
  lasagna turned out" or similar), `context` mentioning the
  plan, `relevant_after` on or just after Saturday,
  `source_thread_id` = the thread. The `followup_create` call is
  visible in the tool-call panel with an activity line.
- Step 4: STILL exactly one open lasagna row - the restate did
  not mint a twin.
- Step 5: still the SAME row (same id), now with `relevant_after`
  on or just after Sunday, still `open` - a visible
  `followup_update` call, no close, no second create.
- Step 7: a new open row for the manager conversation, created
  by reflection (no tool call in the chat transcript; the
  reflection log lines show the create). `relevant_after` is
  NULL - no stated date, so no proactive-ask basis.
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
| - | - | - | - | Feature not yet built; no runs. |
