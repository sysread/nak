# Samskara evidence backfill (the warmup pool)

## Covers

The quarantine pool and the hourly backfill worker that drains it
([dev: samskara](../../dev/samskara.md), "Evidence backfill: the
warmup pool"; plan:
[docs/dev/in-progress/samskara-backfill-plan.md](../../dev/in-progress/samskara-backfill-plan.md)).
New mints insert QUARANTINED (`activated_at` null): invisible to the
fire RPC, the population cap, collapse, eviction, the compound
summary, and the intent context. The worker
(`samskara_claim_quarantined_samskara` ->
`samskara_backfill_candidates` -> one completion per exchange ->
`samskara_backfill_verdicts` ledger -> `samskara_apply_backfill`)
judges each claim against the historical exchanges that would have
fired it and either activates it (ledger shows >= 1 genuine verdict
when the pool exhausts) or pins it out of the queue (never engaged;
the 45-day probation reaper collects it).

This use case is the LOAD-BEARING guard for the SQL RPCs: the repo has
no SQL test harness, so nothing automated covers the claim/fold/gate
arithmetic. The grandfather marker and the activation gate are
deploy-blocking if wrong.

## Preconditions

- Local stack up (`mise run dev-start`), schema applied
  (`psql -v ON_ERROR_STOP=1 -f supabase/schema.sql`).
- Dev user id: `select id from auth.users where email = 'dev@nak.local';`
- Service-role JWT for sweep routes: `supabase status -o json` ->
  SERVICE_ROLE_KEY (the legacy eyJ... JWT, NOT the sb_secret_ key).
- An eligible history: the user needs >= 2 embedded substrate rounds
  outside the claim's birthplace threads, each with a live user
  message, in threads of >= 2 user messages, older than 48h. Forge
  with the formation use case's seeding scripts, or insert substrate
  rows directly and let the embeddings worker fill query_embedding.

## Steps

1. **Quarantine at mint.** Mint any claim (run the samskara sweep
   route, service-role JWT). Assert the new row:
   `select activated_at, backfill_attempts from samskaras order by
   created_at desc limit 1` -> null / 0.
2. **Fire-path invisibility.** As the user (invoker), run
   `select public.samskara_fire_top_k(<the claim's prediction_embedding>,
   10, '<user>')` - the quarantined claim must NOT appear even when the
   query embedding IS its own prediction embedding.
3. **Grandfather one-shot.** Re-apply the schema
   (`psql -f supabase/schema.sql`) TWICE. After the first apply,
   `select samskara_backfill_grandfathered from app_config` -> true and
   every pre-existing row has `activated_at` set. After the second
   apply (plus a fresh mint between applies), the fresh mint must still
   be null - a plain null-check grandfather would have activated it.
4. **Candidate exclusion.** Forge a claim whose provenance points at
   the two substrate paths: one 'substrate' row and one 'association'
   row (association -> a_id/b_id -> substrate). Run
   `select public.samskara_backfill_candidates('<claim>', 8, '<user>')`:
   exchanges from the birthplace threads must be absent for BOTH paths
   (a one-hop resolution silently misses the association path).
5. **Ledger + fold weights.** Judge the claim's candidates by running
   the sweep route. Assert in `samskara_backfill_verdicts`: one row per
   judged exchange, `verdict` in the four kinds, and
   `backfill_attempts` advanced by the total. Fold arithmetic: the fold
   adds `held * 0.5` to `confirm_count` and discounts the PRE-EXISTING
   tally by d (so on a row with prior evidence the net raise is less
   than 0.5; on a virgin row it is exactly 0.5), a `not-borne-out`
   must raise `disconfirm_count` by 0.125 (same discount caveat), a
   `not-engaged` must raise nothing.
6. **Activation gate, both branches.** (a) Pool exhausted with >= 1
   genuine verdict -> `activated_at` set. (b) Pool exhausted with all
   `not-engaged` -> `activated_at` still null AND `backfill_attempts`
   pinned at 8 (the row left the claim queue; the 45-day reaper
   collects it). The gate must read the LEDGER: forge the (b) case
   with ledger rows present but tallies folded, confirm the pin.
7. **Crash recovery.** Forge the insert-to-fold crash: ledger rows
   exist for every candidate, `backfill_attempts` unchanged, claim TTL
   expired. Re-run the route: no exchange re-judges (ledger exclusion),
   the gate reads the ledger, and a genuinely-engaged claim still
   activates despite the lost fold.
8. **Zero-candidate exception.** A claim for a user whose only rounds
   ARE its birthplace: activate immediately (transition 2), even
   though the embedding poll has drained nothing.
9. **UI states.** Open the Samskara screen: a quarantined claim's
   detail pane reads "warming up - n of 8 exchanges judged" (a
   budget-spent never-engaged row instead reads "warmed up - history
   never engaged this claim"), (the
   warming-up status takes precedence over the probation copy), the
   Health panel shows a "Warming up" count, and the total-samskaras
   figure EXCLUDES quarantined rows (the regen delta must not false-
   alarm on quarantine depth).
10. **[hosted] Readout.** After a week: the M5 agreement gate
   (P(live verdict agrees with backfill verdict) for claims with both)
   and the throughput columns (activation rate, not-engaged share).

## Expected

- (1) null / 0. (2) claim absent from fire results. (3) flag true
  after apply one; fresh mints stay null across applies.
- (4) birthplace threads absent on both provenance paths.
- (5) ledger rows one-per-exchange; weights exactly 0.5 / 0.5 / 0.125;
  not-engaged adds nothing.
- (6a) activated_at set. (6b) null + attempts = 8.
- (7) no duplicate ledger rows; gate outcome correct from ledger state.
- (8) immediate activation. (9) warming-up copy renders; total
  excludes quarantine.

## Cleanup

Local stack: `supabase db reset` restores a clean corpus (or delete
the forged rows - the ledger cascades). Hosted: wrap ALL mutations in
`begin; ... rollback;`.

## Results log

| Date | Environment | Commit | Result | Notes |
| --- | --- | --- | --- | --- |
