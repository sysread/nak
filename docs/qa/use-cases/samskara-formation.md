# Samskara formation: the seven-phase background rotation

## Covers

The samskara formation loop's seven phases - assimilate (claim a
substrate stub, extract situation/outcome/valence), pair-relate
(label a relation between the two closest recent substrate rows),
mint-tier1 (crystallize a topical substrate cluster into a
predictive claim), mint-tier2 (compound a co-fire constellation of
tier-1s), reaction-classify (resolve a fired cohort against the
user's next message), dedup (collapse redundant tier-1s by
co-firing), and compound-regen (re-synthesize the per-user summary
prose) - plus the mint toast surface (the mood pill). Decay is NOT
covered here; it has its own use-case
([samskara-decay](./samskara-decay.md)). Chat-side firing and the
priming block are exercised only as far as reaction-classify needs
them. ([dev: samskara](../../dev/samskara.md))

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

3. Watch one pair-relate probe (`pair-relate: selected pair ...`
   at Info, then either `associated` or `agent declined`). Record
   which branch ran and the association count before/after:

   ```sql
   select count(*) from samskara_associations;
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

6. Reaction-classify, live: send a chat message in an existing
   thread (the cohort fires at turn start - the per-turn cohort
   panel under the user message shows it), wait ~90 seconds (the
   1-minute resolution floor plus slack), then send a follow-up
   message reacting to the reply. Watch for
   `reaction-classify: applied` and verify the cohort resolved:

   ```sql
   select was_confirmed, count(*) from samskara_fires
    where cohort_id = '<cohort-id>' group by 1;
   ```

7. Watch one dedup pass: `dedup: nothing to collapse` (trace) or
   `dedup: collapsed samskaras` (debug). Both are valid; record
   the count.
8. Force a compound regen and watch the chain
   (`compound-regen: synthesizing ...` then `saved summary`):

   ```sql
   update samskara_compound_summary
      set last_regen_at = now() - interval '7 hours';
   ```

   ```sql
   select samskara_count_at_regen, last_regen_at,
          length(summary) from samskara_compound_summary;
   ```

## Expected

- (1-2) The forged stub is claimed within one active rotation
  (worst case ~5 min idle nap + 60s throttle), `situation` /
  `outcome` / `valence` all land, and the save happens under the
  claim guard (a second worker's save would be rejected).
- (3) Pair-relate selects the closest embedded pair and either
  writes an association row (count increments) or logs the
  agent's `orthogonal` decline. A decline is valid for one probe,
  but a corpus-wide association count of zero after many probes
  is a finding to record, not normal background noise.
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
- (6) The fired cohort's rows get `was_confirmed` set (true /
  false per the classifier's verdict) within a rotation or two of
  the follow-up message, while the fire is 1-10 minutes old.
- (7) Dedup returns a collapse count >= 0; zero is the steady
  state on a healthy corpus.
- (8) The summary regenerates: `last_regen_at` bumps to now,
  `samskara_count_at_regen` matches the current corpus count,
  and the prose changes only if the corpus did.
- **[hosted]** post-port only: the `nak-samskara-sweep` cron tick
  fires at :23 (check `cron.job_run_details` after a deploy).

## Cleanup

Delete the forged substrate stub if it was not minted from
(`delete from samskara_substrate where id = '<forged-id>'`);
leave it if a mint's provenance points at it. The regenerated
compound summary and any reaction classifications are real
feature output and stay.

## Results log

| Date | Env | Commit | Result | Notes |
| ---- | --- | ------ | ------ | ----- |
| 2026-06-11 | local | 87105f2 | pass (8/8; 5 = expected FAIL) | browser-worker baseline. Assimilate: forged stub b155acfa claimed and saved in ~1.2s (retained per cleanup rule - a mint's provenance points at it). Pair-relate: wrote the corpus's FIRST association rows (0 -> 2); the weeks-at-zero count is explained - the probe has no memory of declined pairs, so a static corpus re-selects the same closest pair every 60s and the agent declines it every time (one wasted Venice call/min); fresh substrate immediately produced accepted pairs. Also: re-accepting an existing pair bumps last_reinforced_at but `reinforcement` stays 1 (the upsert overwrites it with the literal 1). Mint-tier1: minted 9490bd4e (3 provenance rows) plus 4 dedup-reinforces; mood pill rendered post-mint but was already visible at pageload, so causality unproven. Mint-tier2: the documented every-cycle 21000 failure, direct RPC repro identical; tier-2 corpus still 0. Reaction-classify: cohort fd0458ea applied ~2 min after fire; 2/4 rows confirmed, 2 left NULL - initially flagged as a classifier gap, but NULL-with-backdated-fired_at is exactly how samskara_apply_reaction marks NEUTRAL verdicts (there is no neutral boolean state; the backdate ages them out of the unresolved window), so this is the designed shape. Dedup: 0 collapses, steady state. Compound-regen: forced via 7h backdate; count_at_regen 12 -> 14, prose updated |
