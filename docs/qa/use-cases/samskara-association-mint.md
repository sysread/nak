# Samskara association-mint: cross-session consolidation from the relation graph

## Covers

The `mint-tier1-assoc` sweep phase
(`mintTier1FromAssociationsProbe`) and its supporting pieces: the
`samskara_association_cluster` hub-selection RPC, the per-edge
`minted_at` consumption stamp (set on mint / dedup-hit / decline,
never on a non-verdict), `'association'` provenance with
`weight` = reinforcement, the mixed-kind provenance grouping in
the Corpus detail view, and the Health panel's
`associations_unconsumed` line. The producer side (pair-relate
writing associations) is covered by
[samskara-formation](./samskara-formation.md); this picks up
where that leaves off - what finally CONSUMES the relation graph.
([dev: samskara](../../dev/samskara.md), plan:
[association-mint](../../dev/plans/samskara-association-mint-plan.md))

Sweep-only by design: the turn tail does not run this phase, so
it is exercised via the `nak-samskara-sweep` cron route (or the
dev shim's tick of it), never a chat turn.

## Preconditions

- Local stack up (`mise run dev-start`), signed in as the dev
  user, Logs drawer open at `Trace+`.
- Schema applied at the commit under test (`mise run sync` or the
  deploy): `samskara_associations.minted_at` exists,
  `relation_embedding` is gone, `samskara_association_cluster`
  and the `associations_unconsumed` health field are present.

  ```sql
  select column_name from information_schema.columns
   where table_name = 'samskara_associations'
     and column_name in ('minted_at', 'relation_embedding');
  -- expect: minted_at present, relation_embedding absent
  ```

- An association hub with unconsumed evidence: one substrate row
  joined by accepted associations to >= 2 distinct partners, all
  `minted_at is null`. The dev corpus may already have this once
  pair-relate has run; otherwise forge it (see Steps 1). Confirm
  the RPC sees a hub:

  ```sql
  select hub_id, count(*) edges, count(distinct partner_id) partners,
         sum(reinforcement) total
    from samskara_association_cluster('<dev-user-uuid>')
   group by hub_id;
  -- expect: one hub, partners >= 2
  ```

## Steps

1. **(If needed) forge a hub.** Pick a real embedded substrate
   row as the hub and 2-3 others as partners, and insert accepted
   associations via the RPC (not a raw insert - exercise the real
   write path), leaving `minted_at` NULL:

   ```sql
   select samskara_associate('<user>', '<hub>', '<partnerA>',
     'both seek the mechanism behind a behaviour', 'pattern');
   select samskara_associate('<user>', '<hub>', '<partnerB>',
     'both push back on reassurance', 'contrast');
   ```

2. **Record the pre-state.** Note the unconsumed edge count and
   the current tier-1 corpus size:

   ```sql
   select count(*) filter (where minted_at is null) as unconsumed,
          count(*) as total
     from samskara_associations where user_id = '<user>';
   select count(*) from samskaras where user_id = '<user>' and tier = 1;
   ```

   Open the Samskara tab, click the **Health** button in the top row:
   note "Substrate / associations" shows `... (<N> awaiting mint)`
   matching `unconsumed`.

3. **Tick the sweep.** Hit the `nak-samskara-sweep` route (dev
   shim tick, or `curl` the local function). Watch the Logs drawer
   for the `mint-tier1-assoc` phase line.

4. **Tick the sweep a second time** after the first completes,
   without adding new associations.

## Expected

- **First tick mints (or dedup-reinforces).** A
  `mint-tier1-assoc: minted samskara` log line (or
  `dedup-reinforced existing`), and either way the fed edges are
  now stamped:

  ```sql
  select count(*) filter (where minted_at is null) as unconsumed
    from samskara_associations where user_id = '<user>';
  -- expect: dropped by the hub's edge count (the fed edges consumed)
  ```

- **Mixed provenance on a fresh mint.** The new samskara carries
  BOTH kinds - member substrate rows at weight 1.0 and the
  consumed edges as `'association'` at weight = reinforcement:

  ```sql
  select kind, count(*), max(weight) from samskara_provenance
   where samskara_id = '<new-id>' group by kind;
  -- expect: a 'substrate' group AND an 'association' group
  ```

  In the Corpus detail for that row, provenance renders as TWO
  headed sections - "Formed from (substrate)" and "Related
  observations" - not one mislabeled list. (Mixed-kind is the
  case the old first-row heading got wrong.)

- **`sample_labels` reached the minter.** The `mint-tier1-assoc`
  trace/info carries the cluster; the minted prediction should
  reflect the relation labels, not just raw situations. (Soft
  check - prompt-dependent.)

- **Second tick quenches.** With the hub's edges now stamped and
  no new associations, `samskara_association_cluster` returns zero
  rows and the phase logs `no hub with unconsumed evidence` and
  spends NO Venice call. Health's "awaiting mint" count holds at
  its drained value.

- **Decline path (optional, forge a deliberately noisy hub):** a
  hub whose partner situations are mutually unrelated draws a
  minter `confirm:false`; the edges are STILL stamped (no mint,
  no loop), and the second tick stays quiet. A transport failure
  mid-tick (kill the Venice key) must leave edges UNstamped.

## Cleanup

- Delete any forged associations and the forged mint:

  ```sql
  delete from samskaras where id = '<new-id>';  -- cascades provenance
  delete from samskara_associations where user_id = '<user>'
    and articulated_relation in ('both seek the mechanism behind a behaviour',
                                 'both push back on reassurance');
  ```

- Retain organically-formed rows. A real mint's provenance points
  at real substrate; deleting it orphans nothing but loses signal.

## Results log

Append-only; one row per execution. Date, environment, commit.

| Date | Env | Commit | Result | Notes |
|------|-----|--------|--------|-------|
| 2026-06-13 | local pg + hosted read-only | 9050da4 (pre-fix) | partial (SQL layer only; no live sweep) | RPC logic + migration QA'd short of an actual Venice-burning sweep (no browser/edge runtime here). Hosted read-only: ran the cluster CTE against the real 112-edge graph - it picked a coherent hub but surfaced a bug: pair-relate writes a new row per re-phrased label (unique key includes the text), so one hub had **28 edges across 2 partners**; the original RPC returned them all, flooding `sample_labels` and skewing hub selection toward the most-relabeled pair. Fixed by collapsing to one representative edge per (hub,partner) before ranking; re-ran the CTE -> the selected hub changed to a genuinely 3-4-partner observation, one label each. Local ephemeral pg (initdb, pg16): applied the real migration ALTERs twice (idempotent - pass 2 all-skips, minted_at present + relation_embedding dropped), created the real `samskara_association_cluster`, and ran behavioral tests on synthetic data: hub-selection beats a dup-pair, partner cap holds at 4 (hub w/ 5 partners), per-partner dedup keeps the highest-reinforcement label and leaks no weaker one, `minted_at` consume re-selects the next hub, 1-partner rows never selected (>=2 gate), all-consumed -> 0 rows (quench). NOT covered: the actual sweep route firing the probe, the minter call, `'association'` provenance landing, the mixed-kind detail UI, the realtime toast - all need a running stack. |
