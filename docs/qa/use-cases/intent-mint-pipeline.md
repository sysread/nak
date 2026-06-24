# Intent minting + efficacy evaluation sweep

## Covers

The daily per-user intent pass in the venice edge function
([dev: intents](../../dev/in-progress/intents.md)): the
`intent_mint_claim_next_user` claim (toggle-gated), the efficacy
evaluation that rides at the front of the pass
(`evaluateTargetedIntents` -> `intent_target_samples` +
`intents.efficacy`), the minter agent + `processMintProposals`
portfolio plan (create / retire / dormant / revive), and the
`intent_mint_finish` stamp. Driven daily by the
`nak-intent-mint-sweep` pg_cron job; POSTing the route is the
deterministic stand-in for the 05:37 tick. Drawer source `intent`
([dev: logging](../../dev/logging.md)).

The honest-loop firewall and the opt-in gate are the load-bearing
behaviors this case proves: minting + evaluation run ONLY for
users who turned intents on, and efficacy moves only from
descriptive-layer movement.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev
  user, Logs drawer open at `Trace+`. A Venice key configured in
  `app_config` (the minter calls the model; without a key the
  sweep no-ops at `readVeniceKey`).
- A descriptive layer to mint from: the dev user has at least one
  `samskaras` row or one `bias_summary` row. (Run the samskara or
  bias use-cases first if the corpus is empty.)
- Know the dev user's id: `select user_id from profiles limit 1;`
  (call it `$UID`). `SR` is the service-role key from
  `supabase status -o json`.
- Confirm the cron job is registered:

  ```sql
  select jobname, schedule from cron.job where jobname = 'nak-intent-mint-sweep';
  ```

## Steps

1. **Toggle OFF (the gate).** Ensure intents are off, then POST a
   sweep tick:

   ```sql
   update profiles set settings = settings - 'intentsEnabled' where user_id = '$UID';
   ```

   ```sh
   curl -s -X POST "http://127.0.0.1:54321/functions/v1/venice/intent-mint-sweep" \
        -H "Authorization: Bearer $SR" -H "Content-Type: application/json" -d '{}'
   ```

   Then check nothing was claimed or created:

   ```sql
   select count(*) from intents where user_id = '$UID';
   select * from intent_mint_runs where user_id = '$UID';
   ```

2. **Toggle ON.** Turn intents on (UI: Settings -> AI -> Working
   intentions, or SQL), then POST the sweep again:

   ```sql
   update profiles set settings = jsonb_set(settings, '{intentsEnabled}', 'true') where user_id = '$UID';
   ```

   ```sh
   curl -s -X POST "http://127.0.0.1:54321/functions/v1/venice/intent-mint-sweep" \
        -H "Authorization: Bearer $SR" -H "Content-Type: application/json" -d '{}'
   ```

3. Watch the `[intent]` drawer chain: the minted summary line
   (`minted: +N create, ...`) and any dropped-for-cap notice.
   Inspect the result:

   ```sql
   select id, statement, status, target_kind, target_ref, target_direction, efficacy
     from intents where user_id = '$UID';
   select last_mint_at, mint_claim_holder from intent_mint_runs where user_id = '$UID';
   ```

4. **Efficacy sampling.** If step 3 produced a targeted intent
   (`target_kind` in `bias`/`samskara`), confirm a baseline sample
   landed:

   ```sql
   select intent_id, target_value, control_value, sampled_at
     from intent_target_samples where user_id = '$UID' order by sampled_at desc;
   ```

   To prove the second-sample scoring, backdate the baseline past
   the weekly gate and re-run the sweep:

   ```sql
   update intent_target_samples set sampled_at = now() - interval '8 days'
     where intent_id = '<targeted-intent-id>';
   ```

   Re-POST the sweep (step 2 curl) and re-check `intents.efficacy`
   for that row.

5. **The abandon path.** Re-run the sweep a few times (backdating
   `intent_mint_runs.last_mint_at` past the 20h gate each time to
   re-qualify the user). Watch whether the minter pauses or retires
   intentions over runs as the descriptive layer shifts.

   ```sql
   update intent_mint_runs set last_mint_at = now() - interval '21 hours' where user_id = '$UID';
   ```

## Expected

- (1) Route returns `{"accepted":true}`, but with the toggle OFF
  the claim never selects the user: `intents` stays empty and no
  `intent_mint_runs` row is created. This is the opt-in gate - off
  means minting AND evaluation are inert.
- (2) With the toggle ON the user is claimed; the pass runs under
  waitUntil.
- (3) Zero or more intents created (the minter may decline when the
  descriptive layer is thin - a valid outcome, same as the bias
  agent's signal-free zero case); `intent_mint_runs.last_mint_at`
  stamped and the claim released (`mint_claim_holder` null). Any
  created intent's `statement` reads as a dispositional lean, not a
  command; a `target_kind != 'none'` row carries both `target_ref`
  and `target_direction`.
- (4) A targeted intent gets an `intent_target_samples` baseline row
  (efficacy still null - one sample cannot be scored). After the
  backdate + re-run, a second sample lands AND `intents.efficacy`
  becomes non-null: the movement-vs-control differential scored
  into the posterior. A flat or self-reverting metric reads as a
  soft miss (efficacy at/below the population baseline), never a
  spurious confirm.
- (5) Over repeated runs the active set stays at or below the cap
  (`ACTIVE_INTENT_CAP`); intentions can move to `dormant`/`retired`
  rather than only accumulating.
- **[hosted]** the cron tick fires at 05:37 (check
  `cron.job_run_details` after a deploy).

## Cleanup

```sql
-- Remove test intents + their satellites (cascades handle children).
delete from intents where user_id = '$UID';
delete from intent_mint_runs where user_id = '$UID';
-- Restore the toggle to its pre-test state if it mattered.
update profiles set settings = settings - 'intentsEnabled' where user_id = '$UID';
```

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-24 | — | (this commit) | not run | Authored alongside the feature. The cloud authoring environment has no live Supabase stack, so first execution is pending - the CLI session will run it against `mise run dev-start`. The toggle-gate fix in this same commit (the claim now requires `settings->>'intentsEnabled' = 'true'`) is what step 1 proves. |
