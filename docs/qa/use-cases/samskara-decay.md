# Samskara health (relevance-gated decay)

## Covers

The self-calibrating health model that replaced wall-clock decay
([dev: samskara](../../dev/samskara.md), "Health: the verdict
posterior" / "Decay: relevance-gated forgetting"). Health is a derived
empirical-Bayes posterior, not an accumulator:

- `samskara_apply_evaluation(user, held[], contradicted[], not_borne_out[], not_engaged[])`
  - the verdict-apply the next-day evaluation sweep calls: discount
  prior evidence by `d = 0.5^(1/L)`, fold in the verdict (held ->
  confirm, contradicted -> disconfirm, not-borne-out -> disconfirm
  `+= w_soft` (0.25, the soft miss), not-engaged -> neither), then
  recompute `health = confidence = (confirm + k*p0)/(confirm +
  disconfirm + k)` (k = 5).
- `samskara_population_p0(user)` - the prior: the user's aggregate
  hit rate, weak `0.66` fallback under 20 evidence.
- The one-shot health reconcile (runs on every schema apply) - the
  free repair: zero-evidence rows evaluate to `p0`.
- `samskara_reap_dead(floor, quiet_days)` - deletes repeatedly-
  contradicted, long-quiet rows; the `nak-samskara-reap` pure-SQL cron
  (`13 * * * *`).

The live LLM judge (the sweep reading a settled conversation and
producing the verdicts) is the **[hosted]** tail below.

## Preconditions

- Local stack up (`mise run dev-start`), schema applied
  (`psql -v ON_ERROR_STOP=1 -f supabase/schema.sql`).
- Dev user id and the current prior:

  ```sql
  select id from auth.users where email = 'dev@nak.local';
  select public.samskara_population_p0('<user>');  -- expect ~0.66 on a sparse local corpus
  ```

- Pick two existing rows to forge. Run the mutating steps inside a
  transaction you `rollback` so real local corpus rows survive.

## Steps

1. Reaper cron registered (the schema apply registers it whenever the
   local image has pg_cron):

   ```sql
   select jobname, schedule, command from cron.job where jobname = 'nak-samskara-reap';
   ```

2. Verdict-apply and the posterior. Forge a zero-evidence row, then
   apply each verdict and read the result:

   ```sql
   begin;
   update samskaras set confirm_count = 0, disconfirm_count = 0,
          health = 0.1, confidence = 0.1 where id = '<row-A>';
   -- arg order: (user, held[], contradicted[], not_borne_out[], not_engaged[])
   -- held -> a hit
   select public.samskara_apply_evaluation('<user>', array['<row-A>']::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[]);
   select confirm_count, disconfirm_count, round(health::numeric,4) h, round(confidence::numeric,4) c
     from samskaras where id = '<row-A>';
   -- contradicted -> a full miss (discounts the prior confirm, folds in a disconfirm)
   select public.samskara_apply_evaluation('<user>', '{}'::uuid[], array['<row-A>']::uuid[], '{}'::uuid[], '{}'::uuid[]);
   select confirm_count, disconfirm_count, round(health::numeric,4) h, round(confidence::numeric,4) c
     from samskaras where id = '<row-A>';
   -- not-borne-out -> a SOFT miss (folds in w_soft = 0.25 disconfirm)
   select public.samskara_apply_evaluation('<user>', '{}'::uuid[], '{}'::uuid[], array['<row-A>']::uuid[], '{}'::uuid[]);
   select confirm_count, disconfirm_count, round(health::numeric,4) h, round(confidence::numeric,4) c
     from samskaras where id = '<row-A>';
   -- not-engaged -> discount only (no hit, no miss)
   select public.samskara_apply_evaluation('<user>', '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], array['<row-A>']::uuid[]);
   select confirm_count, disconfirm_count, round(health::numeric,4) h, round(confidence::numeric,4) c
     from samskaras where id = '<row-A>';
   rollback;
   ```

3. Reaper. Forge a below-floor, long-quiet row and confirm it is
   reaped while a recently-fired one is not:

   ```sql
   begin;
   update samskaras set health = 0.05, last_fired_at = now() - interval '15 days' where id = '<row-A>';
   update samskaras set health = 0.05, last_fired_at = now() where id = '<row-B>';
   select public.samskara_reap_dead();           -- default floor 0.15, quiet 14d
   select id from samskaras where id in ('<row-A>', '<row-B>');
   rollback;
   ```

## Expected

- (1) one row: schedule `13 * * * *`, command
  `select public.samskara_reap_dead();`.
- (2) `health` and `confidence` are EQUAL at every step (the merge).
  After `held`: `confirm_count = 1`, `health = (1 + 5*p0)/(1 + 5)`
  (e.g. `0.7167` at `p0 = 0.66`). After `contradicted`: confirm
  discounts to `1*d` and a full disconfirm folds in, so health drops
  below the held value. After `not-borne-out`: a `0.25` disconfirm folds
  in on top of the discounted priors, so health drops but by less than a
  full contradiction would (the soft miss is quarter-weight). After
  `not-engaged`: both counts just discount by `d` and health regresses
  slightly toward `p0`. (`apply_evaluation` returns the count of rows
  touched: `1` each call.)
- (3) `<row-A>` (below floor AND quiet 15d) is deleted; `<row-B>`
  (below floor but fired today) survives - the reaper spares anything
  fired within `quiet_days`.
- **[hosted]** the live judge. Against a settled conversation (newest
  message on a prior calendar day, `>= 2` user rounds) that fired
  samskaras, the `nak-samskara-evaluation-sweep` tick claims it, judges
  the fired predictions in batches of 20 (one Venice completion per
  batch), and applies the verdicts. Watch the in-app Logs drawer
  (source `samskara-eval`) for `judged thread <id>: N/M
  predictions; held=.. contradicted=.. not-borne-out=.. not-engaged=..`,
  then verify the
  `samskara_fires.verdict` writes and the moved `health`. On a thread
  with > 20 distinct fired samskaras, N should approach M rather than
  collapsing to 0 (the pre-batching truncation symptom). A run where
  every batch fails logs `... judge batch(es) failed ... cursor not
  advanced` and leaves `threads.last_evaluated_msg_id` unchanged, so
  the thread retries next tick instead of being marked judged. This is
  the Venice path; run it against the hosted project post-deploy.

## Cleanup

All mutating steps run inside `begin; ... rollback;`, so no corpus row
is changed or deleted. If you ran any step outside a transaction,
restore the forged row's `health`/`confirm_count`/`disconfirm_count`,
or just let the next evaluation re-derive them.

## Results log

> The rows dated 2026-06-11 tested the now-retired wall-clock
> `samskara_decay_sweep` (three fixed health nudges on a 30-minute
> cron). That mechanism was replaced on 2026-06-15 by the
> relevance-gated posterior the steps above now exercise; new
> executions append below the divider.

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-11 | local | 5981c58 | pass | (retired decay) pre-lift baseline against the per-user `samskara_decay()` invoker: returned 6, per-row health 0.48 / 0.40 / 0.47, updated_at bumped. |
| 2026-06-11 | local | b56436b | pass | (retired decay) post-lift: cron row `13,43 * * * *` -> `samskara_decay_sweep()`; manual sweep returned 6, byte-identical per-row health; ACL postgres + service_role only. |
| --- | --- | --- | --- | relevance-gated model (this rewrite) below |
| 2026-07-03 | hosted | a1c3424 | fail | [hosted] judge tail, post backlog-reset: batched judge returned zero verdicts on long-transcript threads (finish_reason=length at 2048 max_completion_tokens - reasoning burn scales w/ transcript, not verdict-map size); threads correctly retried then parked at the 3-attempt gate, cursor never falsely advanced. |
| 2026-07-03 | hosted | 09a25f3 | pass | [hosted] judge tail, post budget fix (8192 + reasoning_effort low): first tick judged a long thread, ~479 fires verdicted in one pass, reset backlog draining ~1 thread/10min. not-borne-out still 0 at observation time - verdict-mix watch continues. |
