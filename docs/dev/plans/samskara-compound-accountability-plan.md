# Samskara Compound Accountability Plan

Status: DRAFT rev 1 (2026-10-23), awaiting fresh-context review.
Source: the 2026-10-22 audit and its 2026-10-23 correction
(`docs/qa/use-cases/samskara-cap-eviction.md`,
`samskara-tier2-mint.md`, `samskara-decay.md`; the "Oct 22" and
"Oct 23" paragraphs in `../planned-changes.md`).

Read [`../samskara.md`](../samskara.md) first: "Fire ranking formula"
(parent-wins), "Health: the verdict posterior" (the evidence tally
and the control arm), "Release of never-tested claims" (the four
eviction tiers), and "Tier-2 detection formula" (the coverage guard).

## SYNOPSIS

Compounds (tier-2 claims) now stand in for their parts at fire time,
but nothing holds a compound to account afterwards. A compound that
is wrong keeps firing forever, because every release path is written
for tier-1. Meanwhile the graduation tier deletes parts faster and
wider than intended: it fires on a thin evidence bar, it reaches
through sibling compounds, and it has no floor, so established
compounds have lost every part they had. This plan gives compounds a
floor under their parts and an exit when they are wrong, then tightens
how new compounds form, in that order.

## PROBLEM

Measured on prod, 2026-10-22, twenty days after parent-wins and the
graduation tier landed (PR #554, deployed 2026-10-02 00:13Z):

- **A disproven compound has no exit.** Cap-pressure eviction only
  ever picks tier-1 rows (`supabase/schema.sql:9667-9775`, every tier
  filters `s.tier = 1`). The dead reaper requires 14 quiet days
  (`schema.sql:9431`), and a compound that fires daily never has
  them. The worst compound sits at health 0.597 with 4 held and 31
  missed, fired 39 times in the last 14 days, and has no living
  parts. Four compounds sit under the 0.85 x p0 bar (0.739); p0 slid
  from 0.883 to 0.869 over the window.
- **Graduation is a sell-off.** The tier deleted 29 of 58 distinct
  parts in 20 days; 7 of 8 established compounds have no parts left;
  18 of 40 compounds have none. It freed 46 mint slots while roughly
  470 association edges arrived and 62 were consumed, and the last
  day shows 24 at-cap skips against 4 evictions. The supply of parts
  is nearly spent.
- **Graduation leaks through siblings.** 19 of the 30 deleted parts
  were shared by two or more compounds, and the predicate deletes a
  part if ANY compound holding it is established
  (`schema.sql:9752-9760`, a plain join). 13 of the 30 had no
  established parent at all and left by other routes (merges,
  eviction tiers 1-3, probation).
- **Merges leave dead references.** When a tier-1 part loses a
  collapse merge, `_samskara_merge_pair` copies the loser's own
  provenance to the winner (`schema.sql:10176-10180`) and deletes the
  loser (`10196-10197`); it never repoints OTHER rows' provenance
  that referenced the loser. A compound's child list then names a
  row that no longer exists.
- **Sibling compounds keep forming.** The coverage guard skips a
  candidate group only at Jaccard >= 0.50 against an existing
  compound's full child list (`schema.sql:10706-10721`, default at
  `10508`). Two shared parts out of a 3-vs-4 or 4-vs-4 pair score
  0.33-0.40 and pass. Since the 0.50 guard landed: 14 new compounds,
  every one under 0.40 against older compounds, yet 8 of 14 share 2+
  parts with another compound. The child lists include dead ids
  (`10627-10634` builds them from provenance with no liveness check),
  which inflates the Jaccard denominator and understates overlap.
- **The compound minter never declines.** 0 declines in 40 mints
  ever. Compounds engage far more often than tier-1 (64.1% vs 42.4%
  of judged fires since deploy) and miss softly more often (37.0% vs
  30.8% of genuine verdicts). Since deploy, tier-2 held 61.2% (n=608)
  against tier-1 67.2% (n=787); without the single worst compound
  the gap is 3 points (64.0%, n=713).

The last audit's "selection works" read is NOT a premise here. The
fired-vs-control comparison (51.1% vs 25.7% engagement) mixes "chosen"
with "shown to the chat model", and the controls are drawn from claims
that fired nowhere in the thread. That measurement's fix (a shadow
arm) is scoped in M4 but deferred.

## ROOT CAUSE

Three mechanisms, each with a citation:

1. **Every release path assumes tier-1.** `samskara_evict_for_mint`
   exists to hand a freed slot to a tier-1 mint, so its tiers filter
   `tier = 1` by design (`schema.sql:9673, 9697, 9723, 9757`).
   `samskara_reap_dead` has no tier filter but gates on
   `last_fired_at < now() - 14 days` (`schema.sql:9431`); parent-wins
   makes a compound fire INSTEAD of its parts, so a wrong compound is
   the one row in the system guaranteed to keep firing.
2. **"Established" is mostly prior.** The graduation bar is
   `confirm_count + disconfirm_count >= 3.0` (`schema.sql:9759`).
   Health is `(confirm + k*p0) / (confirm + disconfirm + k)` with
   `k = 5` (`schema.sql:9336`, formula in `samskara.md` "Health").
   At a tally of 3.0 the prior carries 5/8 = 62% of the estimate. A
   soft miss adds only 0.25 (`schema.sql:9354`), so 3.0 can be three
   holds, which puts health at 0.92 - above p0 and "established"
   after three good days. The delete is irreversible.
3. **Coverage is set-overlap over possibly-dead ids.** The candidate
   finder's covered regions are provenance child lists
   (`schema.sql:10627-10634`) and recent declines (`10647-10651`, TTL
   `v_decline_ttl` = 7 days at `10533`). Neither is filtered to living
   rows, and the test is Jaccard (`10706-10719`), which a larger
   candidate group dilutes.

## PROPOSED APPROACH

Four milestones. M1 is specified fully and is the one to build now; it
stops ongoing damage. M2 and M3 are scoped; M4 is design-only.

### M1 - Floor under graduation, exit for wrong compounds

**M1.1 Graduation floor** (`schema.sql:9735-9768`, mirrored at
`11100-11125`). The fourth eviction tier keeps its place (last) and
its pending-fire guard, and gains three conditions:

- *All parents must qualify.* A part is eligible only if NO tier-2
  that references it in `samskara_provenance` (kind `'samskara'`)
  fails the established test. Written as "exists at least one parent,
  and not exists a parent that is not established". This closes the
  sibling leak.
- *Established means evidence >= 8.0*, not 3.0. At 8.0 the prior
  carries 5/13 = 38% of the estimate; in tally units that is eight
  holds, or six holds and eight soft misses, with health still at or
  above p0. The 14-day age gate stays.
- *Each compound keeps an anchor.* A part is not eligible if it is the
  highest-evidenced living part of any compound that references it
  (ties broken by `created_at asc`, oldest kept). The anchor keeps a
  live id in the compound's child list, which is what the coverage
  guard and parent-wins both key on.

Ordering within the tier is unchanged: least-evidenced part first,
then strongest compound, then oldest. The snapshot column
`evictable_graduated` (`schema.sql:11027`, predicate at `11100-11125`)
mirrors all three conditions. The comment at `schema.sql:9741-9743`
and the dev-doc sentence that says 3.0 "outweighs" the prior are
rewritten (the dev doc was already corrected on 2026-10-23; the SQL
comment was not).

**M1.2 Compound reap.** A new SQL function,
`samskara_reap_compounds(p_bar_ratio real default 0.85)`, added to the
`:13` reaper cron statement after `samskara_reap_dead`
(`schema.sql:15757-15758`). Per user: delete tier-2 rows with
`health < p_bar_ratio * samskara_population_p0(user_id)`. No quiet-day
clause and no evidence floor. Why no floor: with `k = 5` and
`p0 = 0.87`, a row with zero holds needs net miss mass above 0.88
(four soft misses, or one contradiction) to fall under 0.85 x p0; a
row with holds needs roughly two misses per hold. Being under the bar
already proves a record. This is the same bar the tier-1
underperformer tier uses (`schema.sql:9724`).

Before deleting, the function writes a *tombstone* into
`samskara_tier2_declines` (`schema.sql:7732-7738`): `group_key` = the
compound's sorted child ids joined with `,` (the format the minter's
decline writer uses, `supabase/functions/venice/agents/samskara.ts:1678-1686`),
`children` = those ids, plus a new column `reason text not null
default 'declined' check (reason in ('declined', 'reaped'))`. The
candidate finder's decline read (`schema.sql:10647-10651`) changes to
"declined within the TTL, OR reaped at any age", so a reaped region is
never re-offered while any of its parts are alive. Upsert on the
existing primary key `(user_id, group_key)`; a reaped row wins over an
older declined row for the same key.

What the reap does to the rest: fires and control verdicts of the
deleted compound cascade away (FKs at `schema.sql:7782` and
`8149-8160`), the same as any deletion. Living parts, no longer
suppressed, fire on their own again. Dead parts stay dead.

**M1.3 Observability and docs.** Snapshot gains
`compounds_under_bar int` (tier-2 rows under 0.85 x p0), shown on the
health panel beside the four eviction pools
(`src/components/SamskaraHealthPanel.svelte:290`,
`src/lib/supabase/types/samskara.ts:73`, `src/lib/supabase/samskara.ts:535`).
`samskara.md` gains the floor rules in "Release of never-tested
claims" and a "Compound reap" paragraph under "Decay";
`planned-changes.md` records M1 as shipped; the QA use-cases gain a
reap step (`samskara-decay.md`) and the floor conditions in step 3b
(`samskara-cap-eviction.md`); `docs/user/samskara.md` names the new
panel number. Vitest: `tests/samskara-health.test.ts` covers the
snapshot mapping (verify at build time; add the field).

### M2 - The compound minter declines when it should

`TIER2_MINTER_PROMPT` (`samskara.ts:347-389`) lists three
confirm:false conditions (`367-372`) and then mandates GENERALIZE
(`377-384`). Add a fourth condition and a positive requirement: decline
when the generalization names no situation a transcript could visibly
show, and require the "in situations like X" clause to be something a
reader of a conversation could point to. This is the judge's own
pointable-moment test, applied at mint time. Pinned by Deno.

Validation: replay the new prompt over the surviving child lists of
existing compounds (29 of 58 child texts are gone, so the replay is
partial); success is a non-zero decline share, concentrated on
compounds whose held rate trails tier-1. Forward: tier-2's soft-miss
share of genuine verdicts drops toward tier-1's over three weeks under
the same judge model.

### M3 - Coverage by containment over living parts; merges repoint

Replace the Jaccard test (`schema.sql:10706-10719`) with containment:
covered when `|group ∩ covered_live| / |group| >= 0.5`, where
`covered_live` is the compound's child list filtered to rows that
still exist (`10627-10634` gains a join on `samskaras`). Two of three
and two of four are blocked; two of six pass. `_samskara_merge_pair`
gains one statement: repoint `samskara_provenance` rows of kind
`'samskara'` whose `ref_id` is the loser to the winner (insert with
`on conflict do nothing`, then delete the loser-referencing rows), so
compound child lists follow a merged part instead of dangling
(`10176-10180`).

### M4 - Shadow control arm (design only, separate plan)

The clean selection test withholds a top-k claim from the chat model
at random and still has the judge rule on it. That needs a `shadow`
flag on `samskara_fires`, and every reader of that table (co-fire
collapse, tier-2 detection, concentration, evidence application,
cohort panel) has to exclude shadow rows. The blast radius is wide
enough that it is its own plan; it is recorded here so the control arm
that exists is not mistaken for it.

## DECISIONS

- **Reap deletes; it does not demote.** A zeroed-health row still
  fires at a reduced score and pollutes every health readout. Delete,
  and leave a tombstone.
- **Tombstone = the decline ledger, not a new table.** The ledger
  already feeds the coverage test; a `reason` column and a TTL
  exemption are the whole change. The tombstone stores no embedding:
  a reaped compound whose parts are all dead can only re-form after
  new tier-1 claims form from substrate and co-fire ten times, which
  takes weeks and is accepted (see risks).
- **Reap bar 0.85 x p0 with no evidence floor**, matching tier-1's
  underperformer tier. A floor in tally units is misleading because a
  soft miss weighs 0.25; the bar itself already requires a record.
- **Graduation evidence 8.0, all parents, one anchor.** Chosen over
  pausing graduation outright: pausing re-pins the cap with nothing
  freeing slots, and the tier-1 evict gate (14 days + 10 judged fires)
  remains the next lever if that happens.
- **Not an eviction tier.** A tier-2 branch in `samskara_evict_for_mint`
  would hand a tier-1 mint a slot it did not free, pushing tier-1 to
  151 and into the collapse's overflow pass.
- **M4 deferred** despite the audit's open question. Nothing in M1-M3
  depends on it.

## ACCEPTANCE CRITERIA

M1, verified on prod after deploy and at the next scheduled audit:

- The four compounds under the bar on 2026-10-22 are gone within one
  hour of deploy, each with a `reason = 'reaped'` row in the decline
  ledger; `compounds_under_bar` reads 0 on the panel.
- No part of a non-established compound is deleted by graduation
  (verify: every part deleted after deploy had only established
  parents at deletion time, from the snapshot predicate run as the
  user).
- Every compound retains at least one living part, or had none at
  deploy.
- `evictable_graduated` on the snapshot equals the hand-run predicate.
- No compound re-forms over a reaped group while any part of that
  group is alive (zero new compounds whose child list is covered by a
  `reaped` ledger row).

M2: Deno pins the new conditions; the replay produces a non-zero
decline share. M3: the containment predicate blocks 2-of-3 and 2-of-4
on the fixture pairs and passes 2-of-6; after a forced merge in a
rollback transaction, no compound provenance references the loser.

## VALIDATION

Before merge, read-only against prod: run the M1.1 predicate as a
count (expect a small number, likely 0 today - no compound carries 8.0
evidence yet), the M1.2 predicate (expect the 4 compounds under
0.739), and the tombstone key format against an existing decline row
(there are none today; format pinned by the writer's test). After
deploy: the reap cron's next `:13` tick, the ledger rows, the panel.
The 2026-10-22 rows are the baseline the next audit compares against.

## ACCEPTED RISKS

- **The 18 childless compounds can re-form over time** once reaped.
  Re-formation needs new tier-1 claims to mint and co-fire ten times
  with lift, so the loop is weeks long; the sibling count at the next
  audit is the signal. Storing the compound embedding in the tombstone
  would close it and is deferred.
- **Reaping deletes a compound's fire history**, including the
  verdicts behind its low health. Same as every deletion today.
- **The cap may re-pin.** With graduation at 8.0 evidence and all
  parents qualifying, the fourth tier frees far fewer slots. That is a
  known, tolerable state; the next lever is the tier-1 evict gate.

## NOTES

The audit that produced this plan ran about 25 database queries, each
needing an approval. The next audit should read each table once into a
few wide results and compute locally.
