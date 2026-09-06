# Samskara formation: the six-phase background rotation

## Covers

The samskara formation loop's six phases - assimilate (claim a
substrate stub, extract situation/outcome/valence), pair-relate
(label a relation between the two closest recent substrate rows),
mint-tier1 (crystallize a topical substrate cluster into a
predictive claim), mint-tier2 (compound a co-fire constellation of
tier-1s), dedup (collapse redundant tier-1s by co-firing), and
compound-regen (re-synthesize the per-user summary prose) - plus the
mint toast surface (the mood pill). Health/decay and reaction scoring
are NOT covered here: health has its own use-case
([samskara-decay](./samskara-decay.md)), and reaction scoring moved
out of formation to the next-day evaluation sweep covered there.
([dev: samskara](../../dev/samskara.md))

Where the rotation runs depends on the commit under test: rows
logged before the C3 port exercise the browser Web Worker
(`src/lib/agents/samskara/`, drawer source `samskara-worker`);
rows after it exercise the venice edge function (turn tail +
`nak-samskara-sweep` cron, drawer source `samskara`). The
observable contract - claims, writes, toasts - is the same.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev
  user, Logs drawer open at `Trace+`.
- A corpus with history: >= 8 fired tier-1 samskaras (tier-2
  detection's precondition), >= 10 embedded substrate rows, and an
  existing `samskara_compound_summary` row. The long-lived dev
  corpus qualifies; check with:

  ```sql
  select (select count(*) from samskaras where tier = 1 and fire_count > 0) as fired_t1,
         (select count(*) from samskara_substrate where situation_embedding is not null) as embedded,
         (select count(*) from samskara_compound_summary) as summaries;
  ```

- Browser-worker era only: the worker runs in the open tab under
  the `nak:samskara-worker` Web Lock with a 300s lease TTL. A page
  reload kills the worker WITHOUT releasing the lease - the fresh
  tab polls until the TTL expires, so keep one tab open and avoid
  reloads, or budget ~6 minutes after one. Idle nap is 300s and
  the exploratory phases throttle (pair-relate/mint-tier1 60s,
  mint-tier2 5 min), so a forged work item can legitimately wait
  several minutes for pickup.
- Substrate embedding is the embed backfill's job, not this
  loop's. Locally that means the dev cron shim must be ticking
  `/backfill` (or curl it manually) before a freshly assimilated
  row becomes visible to pair-relate/mint-tier1.

## Steps

1. Forge an assimilate work item by cloning the newest substrate
   row's message anchors (a duplicate stub is fine - the
   assimilator processes it independently):

   ```sql
   insert into samskara_substrate
          (user_id, thread_id, user_message_id, assistant_message_id)
   select user_id, thread_id, user_message_id, assistant_message_id
     from samskara_substrate order by created_at desc limit 1
   returning id;
   ```

2. Watch the drawer for the assimilate chain on that id: claim
   line, agent-returned debug line, saved line. Verify the writes:

   ```sql
   select situation is not null as has_situation, outcome, valence
     from samskara_substrate where id = '<forged-id>';
   ```

   (Doubt variant) To exercise the second-thoughts feed, pick or
   forge a stub whose assistant message carries a doubt verdict -
   easiest is to hand-write one onto the anchor before the claim:

   ```sql
   update messages
      set second_thoughts = '{"v":1,"disposition":"correct",
        "note":"I may have mixed up the two dates.",
        "model":"manual-qa","computed_at":0}'::jsonb
    where id = (select assistant_message_id from samskara_substrate
                where id = '<forged-id>');
   ```

3. Watch one pair-relate probe. Three valid outcomes: `selected
   pair ...` at Info followed by `associated` (with its
   reinforcement count) or `agent declined`, or the trace line
   `no unadjudicated pair for the seeded observation` with no
   Venice call. The probe seeds the longest-unseeded embedded row
   (round-robin via `samskara_pair_probe_candidates`), not the
   newest, and relates its closest still-unadjudicated partner.
   Record which branch ran and both ledgers before/after:

   ```sql
   select (select count(*) from samskara_associations) as accepted,
          (select count(*) from samskara_pair_declines) as declined;
   ```

4. Watch one mint-tier1 probe. Three valid outcomes, record which:
   `minted samskara` (a genuinely new claim - the mood pill toast
   must appear), `dedup-reinforced existing` (near-duplicate of an
   existing samskara - no toast), or `agent declined` / `no
   coherent cluster` (trace).
5. Watch one mint-tier2 probe (fires at most every 5 minutes in
   the browser era). Record the outcome. Direct repro of the
   candidate RPC, bypassing the worker (`SR`/`ANON` from
   `supabase status -o json`; sign in as the dev user for a JWT):

   ```sh
   curl -s "http://127.0.0.1:54321/rest/v1/rpc/samskara_tier2_candidate" \
        -H "apikey: $ANON" -H "Authorization: Bearer $USER_JWT" \
        -H "Content-Type: application/json" -d '{}'
   ```

6. Watch one dedup pass: `dedup: nothing to collapse` (trace) or
   `dedup: collapsed samskaras` (debug). Both are valid; record
   the count.
7. Force a compound regen and watch the chain
   (`compound-regen: synthesizing ...` then `saved summary`):

   ```sql
   update samskara_compound_summary
      set last_regen_at = now() - interval '7 hours';
   ```

   ```sql
   select samskara_count_at_regen, last_regen_at,
          length(summary) from samskara_compound_summary;
   ```

8. Mint toast relay, deterministically: with the app open on a
   thread, publish a `samskara-mint` Broadcast event on the user's
   private topic - the same event `insertMint` sends on a real mint.
   The toast rides Broadcast, not a postgres_changes echo on
   `samskaras` (the table is intentionally out of the realtime
   publication), so no row insert is involved:

   ```sql
   select realtime.send(
     jsonb_build_object('tier', 1, 'valence', 0.8, 'confidence', 0.9),
     'samskara-mint',
     'samskaras:' || (select id::text from auth.users
                       where email = 'dev@nak.local'),
     true
   );
   ```

   Watch the mood pill. Nothing to clean up - a Broadcast event is
   ephemeral and persists no row.

## Expected

- (1-2) The forged stub is claimed within one active rotation
  (worst case ~5 min idle nap + 60s throttle), `situation` /
  `outcome` / `valence` all land, and the save happens under the
  claim guard (a second worker's save would be rejected).
- (2, doubt variant) The drawer's `samskara` source logs
  `assimilate: doubt verdict attached` (debug, with disposition +
  acted) before the agent call, the saved `outcome` names the
  misgiving (the assimilator receives the doubt as
  `assistant_second_thoughts`), and `valence` reads lower than an
  equivalent clean round would. A `conviction` verdict on the
  anchor changes nothing - no breadcrumb, no payload field; only
  hedge/reframe/correct are forwarded.
- (3) Pair-relate seeds the longest-unseeded embedded row,
  selects that seed's closest pair the relator has not already
  ruled on, and persists the verdict either way: an association
  row (accepted count increments) or a `samskara_pair_declines`
  row (declined count increments). Because the seed round-robins,
  successive probes on an unchanged corpus advance through
  different seeds and keep finding unadjudicated pairs until
  EVERY seed's neighbourhood is exhausted; only then does the
  quench trace branch (`no unadjudicated pair for the seeded
  observation`) run every tick. Re-selecting a pair that already
  sits in either ledger is a regression (the RPC excludes them).
  Flat counts on a fully-adjudicated corpus are the designed
  silence, not a stall.
- (4) Exactly one of mint / dedup-reinforce / decline. On a true
  mint: a `samskaras` row with `tier = 1`, provenance rows
  pointing at the cluster's substrate ids, and the mood pill
  toast renders in-session.
- (5) The candidate RPC returns a group or an empty set without
  error. **Known baseline failure:** on the pre-C3 schema it
  errors on EVERY call locally with SQLSTATE 21000 (`DELETE
  requires a WHERE clause`) - pg-safeupdate on the local
  PostgREST connections rejects the function's unqualified
  temp-table `delete`, so mint-tier2 has never run locally.
- (6) Dedup returns a collapse count >= 0; zero is the steady
  state on a healthy corpus.
- (7) The summary regenerates: `last_regen_at` bumps to now,
  `samskara_count_at_regen` matches the current corpus count,
  and the prose changes only if the corpus did.
- (8) The mood pill updates within a few seconds of the broadcast
  (valence 0.8 / confidence 0.9 maps to the warm + confident cell).
  Mood state is sticky by design, so the pill holds after the toast.
- **[hosted]** post-port only: the `nak-samskara-sweep` cron tick
  fires at :23 (check `cron.job_run_details` after a deploy).

## Cleanup

Delete the forged substrate stub if it was not minted from
(`delete from samskara_substrate where id = '<forged-id>'`);
leave it if a mint's provenance points at it. The regenerated
compound summary is real feature output and stays.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-11 | local | 87105f2 | pass (8/8; 5 = expected FAIL) | browser-worker baseline. Assimilate: forged stub b155acfa claimed and saved in ~1.2s (retained per cleanup rule - a mint's provenance points at it). Pair-relate: wrote the corpus's FIRST association rows (0 -> 2); the weeks-at-zero count is explained - the probe has no memory of declined pairs, so a static corpus re-selects the same closest pair every 60s and the agent declines it every time (one wasted Venice call/min); fresh substrate immediately produced accepted pairs. Also: re-accepting an existing pair bumps last_reinforced_at but `reinforcement` stays 1 (the upsert overwrites it with the literal 1). Mint-tier1: minted 9490bd4e (3 provenance rows) plus 4 dedup-reinforces; mood pill rendered post-mint but was already visible at pageload, so causality unproven. Mint-tier2: the documented every-cycle 21000 failure, direct RPC repro identical; tier-2 corpus still 0. Reaction-classify: cohort fd0458ea applied ~2 min after fire; 2/4 rows confirmed, 2 left NULL - initially flagged as a classifier gap, but NULL-with-backdated-fired_at is exactly how samskara_apply_reaction marks NEUTRAL verdicts (there is no neutral boolean state; the backdate ages them out of the unresolved window), so this is the designed shape. Dedup: 0 collapses, steady state. Compound-regen: forced via 7h backdate; count_at_regen 12 -> 14, prose updated |
| 2026-06-11 | local | a5eb802 | FAIL (1-2, 6; rest pass) | post-port run. Blocking regression: both messages-table reads filtered on a nonexistent `messages.user_id` column (ownership routes through threads.user_id) - every assimilate and reaction-classify threw `column messages.user_id does not exist`; the substrate queue only grew, the sweep drain aborted at assimilated=0, and cohorts could not resolve (cohort 4c275558 left 5 rows NULL with un-backdated fired_at - genuine failure, not the neutral shape). Claim/scheduling machinery and runPhase isolation worked (a failing phase never took down the rotation). PASSING: pair-relate (associations 6 -> 7; reinforcement-stuck-at-1 quirk persists), mint-tier1 (3x dedup-reinforce), mint-tier2 POST-FIX CONFIRMED (direct RPC returns a result set, no 21000; the corpus minted its first-ever local tier-2), dedup (first nonzero collapse, tier-1 14 -> 13), compound-regen (7h backdate -> fresh 1175-char summary, count 14), step 9 toast relay (pill content -> cheerful within ~5s of the SQL insert), drawer relay under the `samskara` source tag, tail phase ordering as designed |
| 2026-06-11 | local | c618678 | pass (1-2, 6 re-run; rest pass per prior row) | fix verification: the messages reads scope by thread_id. Assimilate: a sweep tick drained all three stuck stubs claim -> agent -> save (`assimilated=3`, pending queue 0) after their stale failed-attempt claims were released manually. Reaction-classify, live two-turn run: cohort 202a1cc5 (5 fires) resolved by the second turn's tail ~30s after the reply - 2 rows confirmed true (fired_at intact), 3 NEUTRAL (was_confirmed NULL, fired_at backdated ~13 min - the designed shape); zero `failed` / `message read failed` lines across the window. The feedback loop is closed end to end on the ported pipeline |
| 2026-06-12 | local | a040984 | pass (1-3 re-run; partial scope) | pair-relate adjudication change only (declines ledger + adjudicated-skip + samskara_associate RPC). Baseline for the old behavior is the 87105f2 row (static corpus re-selected the same pair every probe, reinforcement stuck at 1). Post-change: forged stub 275636cb assimilated + embedded, then three sweep ticks on a static corpus selected three DISTINCT pairs (tick 3 kept the same seed but skipped its adjudicated top candidate 38e3cdc7 and related next-closest 9eb79527) - the amnesia loop is gone. Associations 11 -> 14. Direct re-call of samskara_associate on an existing pair+label returned reinforcement 2 with last_reinforced_at bumped - the conflict clause increments. Declined branch not organically reachable this run (the relator accepted every probe; clone-derived pairs are genuinely related) - the decline write shares the upsert shape and the adjudicated-read union with the proven accept side; rankPairCandidates floor/ordering pinned by the Deno suite. Decline-branch live confirmation rides the next orthogonal verdict in normal operation |
| 2026-07-05 | - | claude/samskara-second-thoughts-lnuuge | not executed | step 2 gained the doubt variant (second-thoughts doubt verdicts now ride the assimilator payload as assistant_second_thoughts and colour outcome/valence); cloud session has no browser or local stack - needs a manual run for the doubt-variant baseline |
| 2026-09-06 | local (SQL + Deno only) | samskara-mint-model-stamp WIP | partial (unit-level; no live mint) | Write-path stamp check: `insertMint` now writes `embedding_model` from the `EMBEDDING_MODEL` constant, pinned by a new Deno test (fake admin client records the insert row; asserts the stamp). Prod state at time of fix: all 22 post-reset rows already carried `embedding_model = 'gte-small'` with zero nulls - stamped by the deploy-time repair block (schema.sql), which masks the write-path gap between deploys. The un-stamped window between deploys is what this fix closes; no prod backfill needed. NOT covered: a live mint against the local stack (needs a sweep tick + Venice call) - the stamp assertion runs at the unit seam. |
