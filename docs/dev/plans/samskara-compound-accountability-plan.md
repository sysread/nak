# Samskara Compound Accountability Plan

Status: REVIEWED rev 4 (2026-10-23). Deep-mode lens fan-out plus two
fresh-context consensus rounds (the personal-project cap). Round 2
reported no blockers and five should-fixes, all folded in here
without a third round. Awaiting the owner's go-ahead to build M1.
Revision log at the end.
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
compounds have lost every part they had. This plan puts a floor under
graduation and gives wrong compounds an exit (M1, build now), then
tightens how compounds form (M2, M3) and records the measurement that
would settle whether retrieval's selection works (M4, design only).

## PROBLEM

Measured on prod, 2026-10-22, twenty days after parent-wins and the
graduation tier landed (PR #554, deployed 2026-10-02 00:13Z):

- **A disproven compound has no exit.** Cap-pressure eviction only
  ever picks tier-1 rows (`supabase/schema.sql:9667-9775`; every tier
  filters `s.tier = 1` at `9673`, `9697`, `9723`, `9757`). The dead
  reaper requires 14 quiet days (`schema.sql:9431`), and a compound
  that fires daily never has them. The worst compound sits at health
  0.597 with 4 held and 31 missed, fired 39 times in the last 14 days,
  and has no living parts. Four compounds sit under the 0.85 x p0 bar
  (0.739); p0 slid from 0.883 to 0.869 over the window. p0 averages
  over every row of every tier (`schema.sql:9270-9278`), so wrong
  compounds that stay alive lower every bar derived from it.
- **Graduation is a sell-off.** The tier deleted 29 of 58 distinct
  parts in 20 days; 7 of 8 established compounds have no parts left;
  18 of 40 compounds have none. It freed 46 mint slots while roughly
  470 association edges arrived and 62 were consumed, and the last
  day shows 24 at-cap skips against 4 evictions. The supply of parts
  is nearly spent.
- **Graduation leaks through siblings.** Of the 30 parts deleted by
  2026-10-23 (29 on the 22nd; one more overnight), 19 were shared by
  two or more compounds, and the predicate deletes a
  part if ANY compound holding it is established
  (`schema.sql:9752-9760`, a plain join). 13 of the 30 had no
  established parent at all and left by other routes (merges,
  eviction tiers 1-3, probation).
- **Merges leave dead references.** When a tier-1 part loses a
  collapse merge, `_samskara_merge_pair` copies the loser's own
  provenance to the winner (`schema.sql:10176-10180`) and deletes the
  loser (`10196-10197`); it never repoints OTHER rows' provenance
  that referenced the loser. The dev doc records this as intended
  ("a compound that earned its confidence does not need its
  scaffolding", `samskara.md`, tier-2 gotcha); M3 revisits it.
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
that fired nowhere in the thread. The measurement that would settle
it (a shadow arm) is scoped in M4 and deferred.

## ROOT CAUSE

Three mechanisms, each with a citation:

1. **Every release path assumes tier-1.** `samskara_evict_for_mint`
   exists to free one tier-1 slot for a pending mint (its header
   comment, `schema.sql:9605-9609`), so its tiers filter `tier = 1`.
   `samskara_reap_dead` has no tier filter but gates on
   `last_fired_at < now() - 14 days` (`schema.sql:9431`), by design:
   "a recurring prediction mid-re-evaluation is never reaped"
   (`9397-9398`). Parent-wins makes a compound fire INSTEAD of its
   parts, so a wrong compound is the one row in the system guaranteed
   to keep firing, and that guard protects exactly the wrong row.
   History note: the record never states why tier-2 was left out of
   eviction; the "a freed slot must fund a tier-1 mint" reasoning
   first appears in the 2026-10-22 audit notes. It is a true
   mechanism, not a recorded decision.
2. **"Established" is mostly prior, and the tally is discounted.**
   The graduation bar is `confirm_count + disconfirm_count >= 3.0`
   (`schema.sql:9759`). Health is `(confirm + k*p0) / (confirm +
   disconfirm + k)` with `k = 5` (`schema.sql:9336`). Every genuine
   test first multiplies both tallies by `d = 0.5^(1/10) = 0.933`
   (`9337-9338`), so n consecutive holds sum to `(1 - d^n)/(1 - d)`:
   three holds are 2.80, four are 3.62, eight are 6.36, eleven are
   7.97, and the ceiling is 1/(1-d) = 14.9 (the SQL comment at
   `9404` says 14.4; it is corrected in M1.3). At a tally of 3.0 the
   prior
   carries 5/8 = 62% of the estimate, and four good days make a
   compound "established" forever, because the delete is permanent.
3. **Coverage is set-overlap over possibly-dead ids.** The candidate
   finder's covered regions are provenance child lists
   (`schema.sql:10627-10634`) and recent declines (`10647-10651`, TTL
   `v_decline_ttl` = 7 days at `10533`). Neither is filtered to living
   rows, and the test is Jaccard (`10706-10719`), which a larger
   candidate group dilutes. Jaccard was a deliberate choice in the
   original tier-2 plan (skip re-minting "as membership drifts by one
   element"); containment was never weighed against it.

## PROPOSED APPROACH

Four milestones. M1 is specified fully and is the one to build now.
M2 and M3 are scoped; M4 is design-only.

### M1 - Floor under graduation, exit for wrong compounds

**M1.0 Preconditions (refactor-first; nothing in the gate covers the
code M1 touches).**

- A vitest for the snapshot mapper (`src/lib/supabase/samskara.ts:520-546`)
  with a stub client whose RPC returns every column, asserting every
  field. Today `tests/samskara-health.test.ts` imports only the
  `src/lib/ui/samskara-health` primitives; a misspelled snake_case key
  in the mapper reads as 0 on the panel and nothing fails. The new
  column lands only after this test exists.
- A pure `tier2GroupKey(ids)` helper in
  `supabase/functions/venice/agents/samskara.ts`, used by the decline
  writer at `1678-1686`, pinned by a Deno test in
  `supabase/functions/tests/samskara.test.ts` (today no test covers
  the writer; `supabase/functions/tests` has no mention of
  `tier2_declines`). The SQL tombstone (M1.2) copies this format:
  ids sorted as text under `collate "C"`, joined with `,`, which is
  what JavaScript's default sort produces for lowercase hex uuids.
- The graduation predicate moves into one shared SQL helper,
  `_samskara_graduation_candidates(p_user_id uuid, p_p0 real)`,
  security invoker, returning `(id uuid, rank int)` - a rank column,
  because a set-returning function's row order does not survive a
  caller's `limit 1`; the evictor takes the minimum rank. Called by
  `samskara_evict_for_mint` with `samskara_population_p0(user)` and
  by `samskara_health_snapshot` with its inlined `auth.uid()`-scoped
  p0 (the pattern at `schema.sql:11089-11100`;
  `samskara_population_p0` is service-role only, `9280`). Grants:
  execute to `authenticated` AND `service_role` (the snapshot runs as
  the signed-in user; the usual revoke-from-authenticated pattern
  would break it). Grant order matters: functions are executable by
  `public` by default, so revoke all from `public` and `anon` first,
  then grant. Add `drop function if exists` ahead of the create.
  Define the helper ABOVE `samskara_health_snapshot` in `schema.sql`:
  the snapshot is a SQL-language function, which Postgres validates at
  creation, so a helper defined after it fails the deploy's schema
  apply and nothing in the gate would catch it. Under invoker security
  the helper sees only rows the caller's RLS allows; the self-select
  policies on `samskaras` (`7936`), `samskara_provenance` (`7980`) and
  `samskara_fires` (`8119`) cover the owner. The predicate is
  hand-copied in two places today
  (`9750-9768` and `11101-11125`); the anchor rule below is a ranked
  pick, which makes drift between copies likelier.

**M1.1 Graduation floor.** The fourth eviction tier keeps its place
(last) and its pending-fire guard, and gains three conditions:

- *All parents must qualify.* A part is eligible only if NO tier-2
  that references it in `samskara_provenance` (kind `'samskara'`)
  fails the established test. Written as "exists at least one parent,
  and not exists a parent that is not established". This closes the
  sibling leak.
- *Established means a discounted tally >= 6.0*, not 3.0. In
  discounted units that is about eight consecutive holds; the prior
  then carries 5/11 = 45% of the estimate. The health >= p0 and
  14-day age gates stay.
- *Each compound keeps an anchor.* A part is not eligible if it is the
  highest-tally living part of any compound that references it (ties
  broken by `created_at asc`, oldest kept). This REVERSES a recorded
  intent: the tier-2 gotcha in `samskara.md` and the graduation
  header (`schema.sql:9744-9746`) both say a compound "does not need
  its scaffolding" and that an all-parts-gone compound was foreseen.
  The anchor exists so that parent-wins still suppresses something,
  the coverage guard still sees a live id, and the part itself keeps
  firing alone; it is not there to seed a replacement compound (see
  the tombstone rule in M1.2). Both texts are rewritten.

Ordering within the tier: least-tally part first, then the highest
tally among the part's parent compounds (a part can have several
parents, so "strongest compound" needs an aggregate), then oldest.

**M1.2 Compound reap.** A new SQL function,
`samskara_reap_compounds(p_bar_ratio real default 0.85, p_min_tally
real default 1.9)` returning the count, `security definer`, with the
same grant block every reaper carries: drop the function if it
exists, revoke all from public, anon and authenticated, and grant
execute to the service role only (as `samskara_reap_dead` does at
`9436-9437`). This
is not optional: a new function is executable by `anon` and
`authenticated` by default, and this one deletes across every user
with caller-supplied thresholds. It is scheduled as its OWN cron job
(`nak-samskara-reap-compounds`, `14 * * * *`, minute 14 is free),
written as the same guarded block the `:13` job uses (`15745-15763`:
skip without pg_cron, unschedule if present, schedule), not appended
to the `:13` statement at `15757-15758`. Reason: that statement is
one transaction, so a raise in the new function would roll back the
fire expiry and both existing reapers every hour; a separate job
fails alone and shows its own failure in `cron.job_run_details`.

Per user: delete tier-2 rows whose health is below p_bar_ratio times
that user's p0 and whose tally (confirm plus disconfirm) is at or
above p_min_tally. No quiet-day clause and no pending-fire guard: this
deliberately reverses the dead reaper's "never reap mid-re-evaluation"
intent for compounds only, for the reason in ROOT CAUSE 1, and
matches what the tier-1 underperformer tier already does (`9719-9728`,
guard dropped on purpose). The tally floor is new in rev 2. With the
prior strength at 5 and p0 at 0.87, the bar health < 0.85 x p0 works
out to m > 0.354 c + 0.882 in tally units (m = miss mass, c = hold
mass), so a single contradiction with no holds (health 0.724) would
reap a compound on its first genuine verdict. The floor is 1.9, in
discounted units: two consecutive contradictions sum to 1 + d = 1.93
and clear it; one contradiction plus four soft misses (1.66) and
eight soft misses (1.59) do not; about eleven soft misses do. The
four under-bar compounds today carry tallies 4.0 / 2.5 / 3.9 / 4.8
and all qualify. Two existing texts state this arithmetic wrong and
are corrected: the dev doc's claim of roughly two full contradictions
worth of misses in `samskara.md` ("Release of never-tested claims"),
and the SQL header at `schema.sql:9646-9649`.

Before deleting, the function writes a *tombstone* into
`samskara_tier2_declines` (`schema.sql:7732-7738`). Victim selection,
tombstone insert and delete run as ONE statement (a victims CTE that
reads the provenance and feeds both the insert and the delete), so a
judge commit between two separate statements cannot leave a tombstone
for a compound that survived, or delete a compound with no tombstone;
provenance cascades with the compound (`7969`), which is the other
reason it must be read in the same statement:

- `group_key` = the compound's child ids from provenance, sorted as
  text `collate "C"`, joined with `,` (the writer's format via
  `tier2GroupKey`); `children` = that array.
- A new column `reason text not null default 'declined'`, added with
  `add column if not exists`, plus a NAMED check constraint
  (`samskara_tier2_declines_reason_check`, values `'declined'` and
  `'reaped'`) added inside a guarded `do` block so re-apply is clean.
- `insert ... on conflict (user_id, group_key) do update set reason =
  'reaped', declined_at = now(), children = excluded.children`, over
  a `select distinct on (user_id, group_key)` (the reaper runs across
  all users) so two reaped compounds with the
  same child set do not touch one row twice in one statement (which
  Postgres rejects).
- A compound with NO provenance rows (possible: `insertMint` keeps the
  row when the provenance upsert fails, `samskara.ts:959-966`) is
  deleted without a tombstone; `children` is `not null` (`7735`) and
  there is nothing to cover.
- The minter's own decline writer (`samskara.ts:1678-1686`) keeps
  sending no `reason`; a later decline on the same key refreshes
  `declined_at` and leaves `reason = 'reaped'` in place (PostgREST
  updates only the columns it is sent). Noted in the writer's comment
  so nobody "fixes" it. Consequence, accepted: a minter decline on a
  reaped key after day 90 re-arms the 90-day one-shared-id block
  instead of a 7-day Jaccard block. The ledger's "writes come
  exclusively from the venice function's service-role client" comment
  (`7741-7742`) becomes false and is rewritten.

Reaped tombstones are NOT permanent. The ledger's recorded principle
is that only verdicts that "can never change" are permanent, and the
TTL is also what clears dead child ids out of the Jaccard denominator
(`schema.sql:7716-7731`). Reaped rows get their own TTL,
`v_reap_ttl = 90 days`, in the candidate finder's decline read
(`10647-10651`: declined within 7 days, OR reaped within 90). Within
that window the finder treats a candidate group as covered when it
shares **one or more ids** with any reaped row, in addition to the
Jaccard test. Jaccard alone does not protect a reaped region: two
living parts plus three new neighbours score 2/7 against a four-child
tombstone and pass, and the co-fire edges already exist, so a sibling
could mint at the very next sweep. Two shared ids is not enough
either, because a reaped compound often has exactly one living part
left (its anchor), so the test is one. The effect on that part: it
fires on its own again, but cannot be compounded for 90 days. The
one-shared-id rule is scoped to reaped rows only; M3 handles existing
compounds.

What the reap does to the rest: fires and control verdicts of the
deleted compound cascade away (FKs at `schema.sql:8010` and
`8149-8160`), the same as any deletion. Living parts, no longer
suppressed, fire on their own again. Dead parts stay dead. Reaping
also stops the p0 slide (p0 is all-tier), which raises every p0-based
bar a little each time; that ratchet is small per reap and is
documented rather than engineered around.

**M1.3 Observability, comments, docs.** Snapshot gains
`compounds_under_bar int` (tier-2 rows under 0.85 x inlined p0 AND at
or above the 1.9 tally floor - it mirrors the reaper exactly, or the
panel shows a count that never drains), mapped and shown beside the
four eviction pools
(`src/components/SamskaraHealthPanel.svelte:288-290`,
`src/lib/supabase/types/samskara.ts:73`, `src/lib/supabase/samskara.ts:535`).
Comments that become false and are rewritten in the same change: the
parent-wins comment that names `samskara_reap_dead` as the compound's
exit (`schema.sql:8558-8561`, and `samskara.md` "Fire ranking formula");
the graduation header (`9735-9749`); the "two full contradictions"
arithmetic in the evictor header (`9646-9649`) and the 14.4 ceiling at
`9404`; the declines table comment (`7716-7731`), the candidate
finder's preamble (about `10475`) and its TTL comments (`10637-10642`);
the snapshot's header comment listing its columns (`10990-11010`);
the "three tiers" panel comment (`SamskaraHealthPanel.svelte:274-282`);
the "deliberate omission" comment in `src/lib/ui/samskara-browse.ts:219-228`
(gains the fourth tier and the compound reap); the types comment at
`types/samskara.ts:67-72` (says 3.0); the audit skill
(`.claude/skills/samskara-audit/SKILL.md:120-140`, which hand-runs the
3.0 predicate and names the no-exit gap). Docs: `samskara.md`
("Release of never-tested claims" gains the floor rules; "Decay" gains
a "Compound reap" paragraph; "Tier-2 detection formula" gains the
90-day and one-shared-id rules; the tier-2 gotcha is rewritten);
`planned-changes.md` records M1 shipped; `docs/user/samskara.md`
names the new panel number; QA: `samskara-cap-eviction.md` step 3b
becomes three sub-cases (below), `samskara-decay.md` gains a reap
step, and `samskara-tier2-mint.md` gets a before/after pass because
the candidate finder's coverage behavior changes.

### M2 - The compound minter declines when it should

`TIER2_MINTER_PROMPT` (`samskara.ts:347-389`) lists three
confirm:false conditions (`367-372`) and then mandates GENERALIZE
(`377-384`); the original tier-2 plan set no upper limit on breadth.
Add a fourth decline condition and a positive requirement: decline
when the generalization names no situation a transcript could visibly
show, and require the "in situations like X" clause to be something a
reader of a conversation could point to. This is the judge's own
pointable-moment test, applied at mint time. Pinned by Deno.

Validation: replay the new prompt over the surviving child lists of
existing compounds (29 of 58 child texts are gone, so the replay is
partial); success is a non-zero decline share, concentrated on
compounds whose held rate trails tier-1. Count declines with
`reason = 'declined'` only; reaped tombstones share the ledger.
Forward: tier-2's soft-miss
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
(`10176-10180`). This reverses the "does not need its scaffolding"
intent for the merge case too, for the same reason as the anchor.

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
  fires at a reduced score, keeps its last-fired date fresh so the
  dead reaper never catches it, and keeps dragging p0. Delete, and
  leave a tombstone. (Conditional parent-wins - suppress only while
  health >= p0 - was weighed and rejected for the same reasons, and
  because 18 of 40 compounds have no parts for it to release.)
- **One reaper per tier.** Folding a tier-2 rule into
  `samskara_reap_dead` makes one function whose behavior switches on
  a column; it also loses the per-run count of reaped compounds,
  which is the number to watch. Separate function, separate cron job.
- **Tombstone = the decline ledger with a `reason` column and a 90-day
  TTL**, not a new table and not permanent. Stores no embedding: a
  reaped compound whose parts are all dead can only re-form after new
  tier-1 claims form from substrate and co-fire ten times, which takes
  weeks and is accepted (see risks).
- **Reap bar 0.85 x p0 with tally >= 1.9.** The bar matches tier-1's
  underperformer tier; the floor stops a single contradiction from
  deleting a compound and admits two.
- **A reaped region is not re-compounded for 90 days, even around
  its anchor.** The anchor exists so the part keeps firing alone and
  parent-wins and coverage keep a live id; it does not exist to seed
  a replacement compound. So the tombstone test is "shares one or
  more ids", which the anchor case needs.
- **Graduation tally 6.0 (discounted units), all parents, one
  anchor.** Chosen over pausing graduation outright: pausing re-pins
  the cap with nothing freeing slots, and the tier-1 evict gate
  (14 days + 10 judged fires) remains the next lever if that happens.
- **Not an eviction tier.** A tier-2 branch in `samskara_evict_for_mint`
  would hand a tier-1 mint a slot it did not free; the cap is counted
  as `tier = 1` in three places (the mint gate `tier1AtCap`, the
  collapse's overflow pass, the snapshot), all verified.
- **p0 stays all-tier.** Changing its definition touches every bar;
  the ratchet is documented instead.
- **M4 deferred** despite the audit's open question. Nothing in M1-M3
  depends on it.

## ACCEPTANCE CRITERIA

M1, verified on prod after deploy and at the next scheduled audit:

- The four compounds under the bar on 2026-10-22 are gone within one
  hour of deploy, each with a `reason = 'reaped'` row in the decline
  ledger (or no row, if it had no provenance); `compounds_under_bar`
  drains to 0 within a few ticks (each reap nudges p0 up, which can
  push one more compound under the bar on the next tick) AND the
  mapper test proves the column is wired.
- No part deleted BY GRADUATION after deploy had a non-established
  parent at deletion time (other release paths - underperformer,
  dead reaper, probation, merge - may still remove a part, including
  an anchor; that is in scope for M3's merge repoint, not M1).
- No compound loses its last living part to graduation.
- `evictable_graduated` on the snapshot equals the hand-run predicate
  (the shared helper makes this a tautology; the check is that the
  snapshot calls it).
- Within 90 days of a reap, no new compound's child list shares any
  id with that reaped row's children.
- The `:13` job and the `:14` job both show `succeeded` in
  `cron.job_run_details` on the first tick after deploy.

M2: Deno pins the new conditions; the replay produces a non-zero
decline share. M3: the containment predicate blocks 2-of-3 and 2-of-4
on fixture pairs and passes 2-of-6; after a forced merge in a rollback
transaction, no compound provenance references the loser.

## VALIDATION

Nothing in the gate exercises SQL. The cloud session has no local
stack, so the local-stack steps below are written for a CLI session
and marked as such; the cloud session runs the prod read-only steps
and the two new unit tests.

Prod, read-only, before merge:

- Dry-run the M1.1 predicate as a count (expect 0 today; no compound
  carries a 6.0 tally yet).
- Dry-run the M1.2 predicate (expect the four compounds under 0.739
  with tally >= 1.9); list their child keys; check whether any two
  share a child set and whether any has empty provenance (decides
  whether the distinct-on and no-provenance paths fire on tick one).
- Confirm no row in `samskara_tier2_declines` exists today (none did
  on 2026-10-22), so the column default needs no backfill.

Local stack, inside `begin ... rollback`, run against the UNCHANGED
functions first for the before/after pair the QA rules require
(`samskara-cap-eviction.md` step 3b becomes these three):

- two compounds sharing a part, only one established: the shared part
  survives;
- a compound with one living part: that part is kept as the anchor
  and the function returns null;
- a compound forged at tally 5.9: nothing qualifies.

And for the reap (`samskara-decay.md`): forge a compound under the
bar with tally >= 1.9; confirm the row, its fires and its provenance
are gone, a `reason = 'reaped'` row with the right key exists, and the
candidate finder skips a group sharing one of its ids.

Unit tests, in the gate: the mapper vitest and the `tier2GroupKey`
Deno test (M1.0).

## ACCEPTED RISKS

- **Reaped regions can re-form after 90 days**, or sooner from parts
  that were never in the reaped compound. The sibling count at the
  next audit is the signal. Storing the compound embedding in the
  tombstone would close the rest and is deferred.
- **Reaping deletes a compound's fire history**, including the
  verdicts behind its low health. Same as every deletion today.
- **A compound deleted mid-turn.** If the reap removes a compound
  between the fire query and the fire record, the record RPC fails on
  the FK and that turn's cohort is lost (`schema.sql:8652`); the
  judge's control insert for that thread fails and only warns. Both
  are pre-existing for any deletion; the reap makes them hit rows that
  were firing. Once per reaped compound at most.
- **The cap may re-pin.** With graduation at 6.0 and all parents
  qualifying, the fourth tier frees far fewer slots. That is a known,
  tolerable state; the next lever is the tier-1 evict gate.
- **The p0 ratchet.** Each reap raises p0 slightly and with it every
  p0-based bar, including tier-1's underperformer tier. Documented,
  not engineered around.

## NOTES

The audit that produced this plan ran about 25 database queries, each
needing an approval. The next audit should read each table once into a
few wide results and compute locally.

## REVISION LOG

- rev 1 (2026-10-23): draft.
- rev 2 (2026-10-23): after the lens fan-out. Evidence bars restated
  in discounted tally units (graduation 8.0 -> 6.0; a tally floor of
  2.0 added to the reap, since one contradiction alone clears the
  bar). Reap moved to its own cron job (a raise in the shared `:13`
  statement would roll back all three existing reapers). Tombstone:
  no-provenance compounds skip it, distinct-on for duplicate keys,
  text sort under collate "C", named check constraint, 90-day TTL
  instead of permanent, and a two-shared-ids coverage test because
  Jaccard does not protect a reaped region. Snapshot p0 inlined. Two
  false premises removed (no writer test and no mapper test existed;
  both are now M1.0 preconditions). Shared predicate helper added.
  Anchor and merge-repoint named as reversals of a recorded intent;
  the tier-1-only "by design" claim corrected to a mechanism. Stale
  comments enumerated. Acceptance criteria scoped to graduation
  deletes. Citations fixed: fires FK is `8010`, underperformer tier
  `9719-9728`.
- rev 3 (2026-10-23): after consensus round 1. Blocker: the reaper
  had no grant block; it now carries the standard revoke/grant and is
  security definer. Floor arithmetic corrected (two contradictions
  sum to 1.93 under the discount, so the floor is 1.9, not 2.0; the
  tally ceiling is 14.9, not 14.4). The anchor-vs-tombstone
  contradiction resolved: a reaped region is covered on one shared
  id, so an anchor cannot seed a re-mint for 90 days. The snapshot
  counter now mirrors the floor. The shared helper returns a rank
  column and has explicit grants; multi-parent ordering defined as
  the parents' maximum tally; provenance read before the cascade.
  Surfaces added: the audit skill, the snapshot header comment, the
  candidate preamble, the tier-2 detection doc section, and a
  before/after pass on the tier-2 QA use-case.
- rev 4 (2026-10-23): after consensus round 2 (no blockers). Victim
  selection, tombstone and delete made one statement; distinct-on
  keyed per user; helper placed above the snapshot (SQL-language
  functions validate at create) with drop-if-exists and revoke before
  grant; RLS policy citations corrected; anchor wording aligned with
  the tombstone decision; decline counts filtered to minter declines
  in M2 and the audit skill; the ledger's writer comment and data
  model entry added to the surfaces; the acceptance criterion reads
  "drains" to allow the p0 ratchet; the 29-vs-30 deleted-parts figures
  dated.
