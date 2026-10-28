# Samskara density admission (the cap replacement)

## Covers

Mint-time entry regulation: the hard-twin dedup followed by the
density check, and the population tripwire demotion
([dev: samskara](../../dev/samskara.md), "Admission: dedup -> density
-> mint"; plan:
[docs/dev/in-progress/samskara-density-admission-plan.md](../../dev/in-progress/samskara-density-admission-plan.md)).
`samskara_density_check` counts a candidate's ESTABLISHED neighbors
(genuine tally > 0 AND activated) at or above DENSITY_FLOOR (0.40,
claim-mean register); at DENSITY_K (3) both mint probes reject the
mint and reinforce the nearest established claim instead. The
population tripwire (300) halts the probes on a pathological
condition. The evidence reaper (`samskara_reap_evidence`) runs the
three eviction passes unconditionally on the :13 reap cron.

## Preconditions

- Local stack up (`mise run dev-start`), schema applied.
- Dev user id: `select id from auth.users where email = 'dev@nak.local';`
- The claim mean must be READY for the density work (>= 8 claims):
  `select claim_count from samskara_centering where user_id = '<dev-uuid>';`
- Forging embeddings: claim vectors read as pgvector text; embed
  forged predictions with the same model the mint path uses
  (`padEmbeddingForStorage` of gte-small, stamped in
  `embedding_model`). For a tight neighborhood, forge the K
  established claims with IDENTICAL prediction embeddings (centered
  cosine 1.0 between them) and the candidate at a small variation of
  the same vector - raw closeness survives centering.
- Two session classes: `samskara_density_check` and
  `samskara_reinforce_existing` are security INVOKER - exercise them
  in the USER's session (set_config('request.jwt.claims', ...) with
  the dev user's sub); `samskara_reap_evidence` is security definer
  (postgres session). Under the postgres role the invoker RPCs read
  an empty corpus (auth.uid() null).
- The mint probes are not directly drivable offline; the density
  RPC + reinforce contract is exercised directly, and the probe
  wiring is pinned by tests/samskara-density-admission.test.ts.

## Steps

1. **Positive rejection.** Forge K=3 established claims sharing one
   prediction embedding (activated, tallies > 0) plus filler claims
   to clear the centering floor. As the user session, run
   `select * from samskara_density_check('<candidate-embedding>', 0.40);`
   -> one row: `neighbor_count >= 3`, `nearest_id` = one of the
   forged cluster, `ready = true`.
2. **Entrenchment mitigation.** Same shape but the K neighbors have
   tally 0 (activated but unproven) -> `neighbor_count = 0` (unproven
   newcomers must not gate a genuinely new claim).
3. **Below-floor survives.** K established neighbors whose centered
   cosine to the candidate sits below 0.40 (forge a distinct topic's
   embedding) -> count 0.
4. **Reinforce target is the nearest ESTABLISHED claim.** With both
   an unproven twin (cosine ~1.0, tally 0) and a slightly-less-close
   established claim in the window, the RPC's `nearest_id` names the
   ESTABLISHED one (the dedup's no-filter 1-NN would name the twin;
   the density rejection must reinforce the proven row).
5. **Probe wiring (admission mix).** Drive a real mint through the
   running stack (send a conversation that forms a cluster) and read
   the Logs drawer: exactly one `admission mix` line per terminal
   outcome (`minted` / `dedup-reinforced` / `density-rejected` /
   `declined`, plus the recency probe's `embed-failed` /
   `insert-failed`); a density rejection logs
   `density-rejected (K established claims in neighborhood)` and NO
   new samskara row appears, while the reinforce target's
   `updated_at` moves (health bump, no tally change - the posterior
   stays verdict-only).
6. **Cold-start skip.** Below 8 claims (truncate samskaras for the
   dev user) the RPC returns `ready = false`, count 0, null nearest
   -> the mint path admits (the SKIP-not-raw contract; raw claim
   cosine never drops below ~0.76, so a raw count would reject
   everything).
7. **Tripwire.** Forge active rows to 300 (`generate_series` with
   activated_at set, zero-vector embeddings fine - the count query
   reads activated_at only). The edge log shows the
   `POPULATION_TRIPWIRE armed; halting mints` warn on the next probe
   tick, and no mint fires. Delete the forged rows.
8. **Evidence reaper: untested-junk.** An activated claim with 10+
   verdicted (all not-engaged) fires, 14+ days old, no pending ->
   `select samskara_reap_evidence();` deletes it.
9. **Evidence reaper: stale.** An activated claim, total tally 1.0,
   last genuine verdict 90+ days old, no pending -> deleted by the
   same call (dormancy would NOT catch it - one held breaks the
   streak).
10. **Evidence reaper: underperformer + guard divergence.** An
    activated claim with health below 0.85 * p0 -> deleted even
    while carrying a PENDING fire (the deliberate divergence from
    the other passes: a demonstrated failure stands regardless of an
    in-flight test).
11. **Cron registration.** `select command from cron.job where
    jobname = 'nak-samskara-reap';` names all five passes in order
    (expire -> dormant -> dead -> untested -> evidence).

## Expected

- (1) rejects with the reinforce target; (2)-(4) admit; (4) proves
  the reinforce target's provenance; (5) the mix lines are one-per-
  outcome and the rejection never inserts; (6) cold start admits;
  (7) the tripwire arms at exactly 300 with the warn log; (8)-(10)
  the evidence reaper collects each shape and spares everything
  else; (11) the cron statement carries the fifth pass.

## Cleanup

Delete the forged threads (fires cascade), forged claims, and
forged association edges. Hosted: wrap ALL mutations in
`begin; ... rollback;` - prod data is sacrosanct; the calibration
queries are read-only.

## Results log

| Date | Environment | Commit | Result | Notes |
| --- | --- | --- | --- | --- |
| 2026-10-28 | local | 5488d179 | pass (steps 1-4, 6, 8-11; 5 and 7 partial) | Live forge harness (scratch/qa_density.mjs, supabase-js + service key, explicit-user overload = the mint path's real call shape). (1) 3 established same-vector claims + near-candidate -> count 3, nearest in cluster, ready. (2) tally 0 on the cluster -> count 0 (entrenchment mitigation). (3) candidate in an empty register -> count 0. (4) an unproven twin at cosine 1.0 does NOT become nearest_id (established-only provenance). (6) cold start: < 8 claims -> ready=false, count 0, null nearest (earlier smoke test). (8) junk (10 judged all-not-engaged, 14+ days) reaped. (9) backfill-established stale claim (tally 1.0, ZERO fires, activated 100 days) reaped - ONLY because of the R1 coalesce fix; this step fails on the pre-fix schema. (10) underperformer (health 0.1) reaped WITH a pending fire (the deliberate guard divergence). Control survived; counts reconcile (16 forged -> reaped 3 -> 13). (11) cron statement carries all five passes. NOT live-verified: (5) the real mint flow (needs the edge runtime + Venice; the admission order is pinned structurally by tests/samskara-density-admission.test.ts), (7) the warn emission at 300 (the count predicate is the same active-row query tripwireArmed runs; the warn line needs the edge runtime). HARNESS NOTES: thread_id and score are NOT NULL on samskara_fires; the below-floor candidate must live in a register with no forged claims (the first draft's "filler" candidate sat inside the 8-claim filler cluster - count 8, honestly dense). |
