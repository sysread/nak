# Intent employment: the settled-thread judge

## Covers

The employment sweep ([dev: intents](../../dev/in-progress/intents.md)):
the per-thread claim (`intent_employment_claim_next_thread`,
toggle-gated + day-gated + `intent_active_at_turn`-non-empty), the
judge over the transcript (`runIntentEmploymentSweepTick`), and the
save under the message-count guard (`intent_employment_save`) into
`intent_employments`. Driven hourly by the
`nak-intent-employment-sweep` cron; POSTing the route is the
deterministic stand-in. Drawer source `intent-employment`.

Proves the minter's pruning telemetry fills correctly and that it
is gated to opted-in users + settled threads. `intent_employments`
is process telemetry, NEVER an efficacy input - that firewall is a
schema/code property, not something this case can break, but the
case confirms employment writes do not touch `intents.efficacy`.

## Preconditions

- Local stack up (`mise run dev-start`), Venice key in `app_config`,
  Logs drawer at `Trace+`. `$UID` = the corpus-owning profile (same
  caveat as the other intent cases - pick it explicitly, not a bare
  `limit 1`). `SR` = the legacy-JWT service-role key from
  `supabase status -o json`.
- Intents enabled for `$UID`
  (`update profiles set settings = jsonb_set(settings, '{intentsEnabled}', 'true') where user_id = '$UID';`).
- At least one active intent, and a settled thread that snapshotted
  it. Forge both: insert an intent, then a thread owned by `$UID`
  with >= 2 user messages, backdated to a prior day, with the intent
  id in its snapshot:

  ```sql
  insert into intents (user_id, statement, status, target_kind)
    values ('$UID', 'help them name a contrary view before committing', 'active', 'none')
    returning id;  -- call it $IID

  -- a settled thread the snapshot points at (>= 2 user messages,
  -- updated yesterday, not yet employment-processed):
  update threads
     set intent_active_at_turn = array['$IID'],
         updated_at = now() - interval '1 day',
         intent_employment_processed_at = null
   where id = '<thread-with-2plus-user-messages-owned-by-$UID>';
  ```

## Steps

1. **Gate: toggle off.** Turn intents off, POST a sweep tick, confirm
   nothing was claimed or written:

   ```sql
   update profiles set settings = settings - 'intentsEnabled' where user_id = '$UID';
   ```

   ```sh
   curl -s -X POST "http://127.0.0.1:54321/functions/v1/venice/intent-employment-sweep" \
        -H "Authorization: Bearer $SR" -H "Content-Type: application/json" -d '{}'
   ```

   ```sql
   select count(*) from intent_employments where user_id = '$UID';
   select intent_employment_processed_at from threads where id = '<thread-id>';
   ```

2. **Run: toggle on.** Re-enable intents, POST again, watch the
   `[intent-employment]` drawer chain.
3. Inspect the writes:

   ```sql
   select intent_id, opening, acted, user_reaction, reasoning
     from intent_employments where thread_id = '<thread-id>';
   select intent_employment_processed_at, intent_employment_processed_msg_count
     from threads where id = '<thread-id>';
   ```

4. **Firewall check.** Confirm efficacy is untouched by employment:

   ```sql
   select efficacy, confirm_count, disconfirm_count from intents where id = '$IID';
   ```

5. **Minter consumption.** Backdate the mint run and POST the
   mint-sweep; confirm the minter now sees the openings/acted in its
   gather (the `[intent]` log reflects pruning informed by employment,
   vs. the prior all-zero state).

## Expected

- (1) Toggle off: `intent_employments` stays empty and
  `intent_employment_processed_at` stays null - the claim's
  `intentsEnabled` join excludes the user, so the thread is never
  picked up. (Route still returns `{"accepted":true}`.)
- (2) Toggle on: the claim selects the settled, snapshot-bearing
  thread; the judge runs under waitUntil.
- (3) One `intent_employments` row per active intention the judge
  could assess: `opening` true/false; `acted` only true when
  `opening` is true; `user_reaction` one of receptive/neutral/
  resistant only when `acted`, else null; a non-empty `reasoning`.
  `intent_employment_processed_at` stamped, `processed_msg_count`
  matches the thread's user-message count, claim released. A new
  user message landing mid-judge makes the save reject (count guard)
  and the thread re-eligible.
- (4) `intents.efficacy` / `confirm_count` / `disconfirm_count` are
  UNCHANGED by the employment sweep - employment never writes them.
  Only the efficacy evaluation (in the mint pass) moves efficacy.
- (5) The minter's gather reflects the new employment rows
  (openings > 0 for the judged intent), so its pruning is informed
  rather than treating every intent as "quiet".
- **[hosted]** the cron tick fires hourly at :33 (check
  `cron.job_run_details` after a deploy).

## Cleanup

```sql
delete from intent_employments where user_id = '$UID';
delete from intents where user_id = '$UID';
update threads
   set intent_active_at_turn = '{}', intent_employment_processed_at = null,
       intent_employment_processed_msg_count = null
 where id = '<thread-id>';
update profiles set settings = settings - 'intentsEnabled' where user_id = '$UID';
```

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-25 | — | (this commit) | not run | Authored with the employment sweep. The cloud authoring env has no live stack; first execution (the claim gate, the judge writes, the firewall check) is pending `mise run dev-start` or the CLI's pass. The prompt + parser are unit-covered in `tests/intent_employment.test.ts`; this case proves the claim/save/gate seams units cannot reach. |
