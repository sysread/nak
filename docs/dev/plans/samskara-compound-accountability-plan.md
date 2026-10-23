# Samskara Compound Accountability Plan

Status: REVIEWED rev 5 (2026-10-23). Deep-mode lens fan-out plus two
fresh-context consensus rounds (the personal-project cap), then a
rival-interpretation pass against fresh prod data that rewrote the
evidence section and demoted M2. Awaiting the owner's go-ahead to
build M1 and a decision on the verdict archive. Revision log at the
end.
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
does not predict keeps firing forever, because every release path is
written for tier-1. Meanwhile the graduation tier deletes parts faster and
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
  that fires daily never has them; this corpus has not had two
  consecutive quiet days since August. The worst compound sits at
  health 0.598 after 59 judged fires since deploy: 23% held, 73%
  not-borne-out, one contradicted. It fired 39 times in the last 14
  days and has no living parts. Four compounds sat under the 0.85 x
  p0 bar (0.739) on 2026-10-22; three do on the 23rd, with a fourth
  at 0.737 against a bar of 0.736. "Does not predict" is the right
  phrase, not "disproven": across every compound with ten or more
  judged fires there are 260 not-borne-out verdicts and 5
  contradicted, and tier-1 is the same (0.8% contradicted). Health is
  driven entirely by the situation arising and the tendency not
  showing.
- **Graduation deletes the wrong rows, on thin evidence.** The tier
  deleted 29 of 58 distinct parts in 20 days; 7 of 8 established
  compounds have no parts left; 18 of 40 compounds have none. The
  supply of parts is nearly spent. This is not a throughput
  complaint: edge consumption fell from 25-70 a day to about 4 a day
  on 2026-09-14, two and a half weeks before graduation existed, so
  the backlog is a cap problem the tier neither caused nor dented
  (46 slots freed in 20 days). The objection is which rows it picks
  and on what evidence.
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
- **The compound minter never declines.** 0 declines in 41 mints
  ever. Whether that is a problem is NOT established; see the
  caveats below. The tier comparison that motivated M2 in earlier
  revisions does not survive them.

**Every tier-1 figure in this plan is a survivors' figure.** Fires
cascade when a claim is deleted (`schema.sql:8010`), tier-1 turns
over hard (the pool has been at its cap of 150 since mid September
and 47 tier-1 rows minted since 2026-10-02 survive, so at least that
many left in the window and took their verdicts with them), and
tier-2 has never lost a row (collapse at `10319-10320`, every
eviction tier and the dead reaper are tier-1 only; all 41 compounds
ever minted are alive). The bias is visible in the time series:
tier-1 fires per user message read 4.1 in September and 6.3 in
October with usage flat at about 16 messages a day and no mechanism
that raises them. September's history has been thinned by deletions
since. Tier-1's raw since-deploy held rate is 68.4% (626 of 915
genuine verdicts) against tier-2's 62.3% (463 of 743); a modest
assumption about the departed rows (a few hundred verdicts at a 40%
held rate) closes the gap. Rank, thread length, cohort size and
claim age were each tested as confounders and none moves either
tier's number by more than a point; the survivor bias is the one
that cannot be bounded from retained data.

**The engagement gap is parent-wins, not compounds.** Within tier-2,
whose history is complete, engagement ran 38-43% in the weeks before
2026-10-02 and 50-70% after; tier-1's did not move. A compound that
fires alone collects the engagement its children used to split with
it. "Compounds engage far more" (64.1% vs 42.4%) is the deploy
working as designed and is not evidence of breadth.

**Usage is flat.** Messages a day by week since the September wipe:
17.9, 14.6, 15.1, 10.9, 18.9, 15.0, 15.0; 16.7 before the deploy and
16.4 after. The longest run of silent days since August 25 is one.
No count in this plan is a usage artifact.

**Compounds dragging p0 is real and negligible.** The population mean
is 0.866 with tier-2 and 0.871 without; the three under-bar compounds
move it by 0.003 and the bar by 0.0025. It is not a reason for the
reap.

The last audit's "selection works" read is NOT a premise here. The
fired-vs-control comparison (51.1% vs 25.7% engagement) mixes "chosen"
with "shown to the chat model", and the controls are drawn from claims
that fired nowhere in the thread. The measurement that would settle
it (a shadow arm) is scoped in M4 and deferred, and it has the same
precondition as every other tier comparison: verdicts must outlive
the claim they were made about.

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
The evictor names the tier it used: `samskara_evict_for_mint` returns
`(id uuid, tier text)` instead of a bare uuid (drop-and-recreate, since
the return type changes; the one caller at `samskara.ts:1269-1283`
reads `.id` and logs the label). Today an eviction is unattributable
after the fact, which is why the 46 graduation slots in PROBLEM are
inferred from vanished parts rather than counted. Durable attribution
across the weeks between audits needs a table, which is the verdict
archive decision in DECISIONS; the label in the log line is the floor.
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
3.0 predicate and names the no-exit gap; its decline count must
filter `reason = 'declined'` so tombstones do not read as minter
declines). Docs: `samskara.md`
("Release of never-tested claims" gains the floor rules; "Decay" gains
a "Compound reap" paragraph; "Tier-2 detection formula" gains the
90-day and one-shared-id rules; the `samskara_tier2_declines` data
model entry gains the `reason` column and the second writer; the
tier-2 gotcha is rewritten);
`planned-changes.md` records M1 shipped; `docs/user/samskara.md`
names the new panel number; QA: `samskara-cap-eviction.md` step 3b
becomes three sub-cases (below), `samskara-decay.md` gains a reap
step, and `samskara-tier2-mint.md` gets a before/after pass because
the candidate finder's coverage behavior changes.

### M2 - A decline criterion for the compound minter (measure first)

Demoted in rev 5. Earlier revisions motivated this with "compounds
engage more and miss softly more, so the minter overgeneralizes"; the
engagement half is a parent-wins artifact and the soft-miss half (37%
vs 31% of genuine verdicts, about 5 points after standardizing on rank
and age) sits on top of the unmeasured survivor bias. What remains is
a structural observation: `TIER2_MINTER_PROMPT` (`samskara.ts:347-389`)
lists three confirm:false conditions (`367-372`), then mandates
GENERALIZE (`377-384`), and the original tier-2 plan set no upper
limit on breadth, so a decline has never happened and nothing says it
should.

Proposed criterion, if the measurement warrants it: a fourth decline
condition and a positive requirement - decline when the
generalization names no situation a transcript could visibly show,
and require the "in situations like X" clause to be something a
reader of a conversation could point to. This is the judge's own
pointable-moment test, applied at mint time. Pinned by Deno.

Measurement first: replay the candidate prompt over the surviving
child lists of existing compounds (29 of 58 child texts are gone, so
the replay is partial) and compare the declined set against each
compound's own record (health, soft-miss share, time to the reap bar
once M1.2 runs). The criterion ships only if the declines land on the
compounds that went on to miss. Count declines with
`reason = 'declined'` only; reaped tombstones share the ledger.

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

**Precondition, shared with every tier comparison: verdicts outlive
the claim.** Today a deletion erases the fire rows and control
verdicts behind it (`schema.sql:8010`, `8153`), so any held-rate
comparison across tiers, or before and after a change, is a
survivors' comparison. The smallest fix is a verdict archive:
a `before delete` trigger on `samskaras` copies that row's judged
fires (samskara id, tier, thread, fired_at, score, verdict) into an
append-only table that nothing else reads. It is a schema-only
change with one writer and no reader in the app, and it is the
difference between M1's effects being measurable and not. Whether it
rides with M1 is an open decision (see DECISIONS); it is listed here
because M4 cannot be built without it.

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
- **OPEN: whether the verdict archive (M4's precondition) rides with
  M1.** For: M1.2 deletes the four compounds with the richest miss
  records in the corpus, and after that tier-2 carries the same
  survivor bias as tier-1, so the before/after comparison in
  PREDICTED EFFECTS can only be made from numbers written down in
  this plan. Against: it widens M1 by a table and a trigger. The
  owner decides; the baseline numbers below are recorded either way.

## ACCEPTANCE CRITERIA

M1, verified on prod after deploy and at the next scheduled audit:

- The compounds under the bar at deploy (three on 2026-10-23, with a
  fourth at 0.737 against a 0.736 bar) are gone within two ticks of
  the `:14` job, each with a `reason = 'reaped'` row in the decline
  ledger (or no row, if it had no provenance); `compounds_under_bar`
  drains to 0 (each reap nudges p0 up, which is what pulls the fourth
  under on the second tick) AND the mapper test proves the column is
  wired.
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

## PREDICTED EFFECTS

What each milestone should do to the running system, how to tell, and
what else may move. Measure cohorts by mint date, not population
means: every deletion rewrites the population's history, so a mean
that improves after a change may only be showing which rows the change
removed.

### Baseline, prod, 2026-10-02 00:13Z to 2026-10-23

Written down here because M1.2 deletes the rows behind several of
these numbers and they cannot be recomputed afterwards.

| Measure | Tier-1 | Tier-2 |
|---|---|---|
| judged fires | 2159 | 1160 |
| genuine verdicts (held + contradicted + not-borne-out) | 915 | 743 |
| held, share of genuine | 626 (68.4%) | 463 (62.3%) |
| not-borne-out, share of genuine | 282 (30.8%) | 275 (37.0%) |
| contradicted | 7 | 5 |
| engaged, share of judged | 42.4% | 64.1% |
| held at claim age 7-21 days | 71.6% | 59.2% |
| held at claim age 21-45 days | 69.0% | 66.1% |

Population: 150 tier-1 (at cap, 0 under the bar); 41 tier-2, all
ever minted, 3 under the bar (0.598, 0.691, 0.703) and one at 0.737
against 0.736; 4 compounds with tally 6.0 or more, none with a
living part; p0 0.8662. Rates: 16.4 user messages a day; about 110
tier-1 and 55 tier-2 fires a day; 47 surviving tier-1 mints in 21
days (2.2 a day); 46 slots freed by graduation in 20 days; about 4
association edges consumed a day; 14 compounds minted since deploy
(0.67 a day), 8 of them sharing two or more parts with an older one;
0 compounds minted since deploy under the bar at 21 days of age.

### M1.1 Graduation floor

Predicted: graduation evictions stop at deploy and stay at zero for
two to four weeks. Every compound that clears 6.0 today has no parts
left, and the compounds with living parts were minted 2026-10-11 or
later; at one to two genuine verdicts a day and a 60% held rate, a
discounted tally of 6.0 is ten to twenty firing days away. When
graduation resumes it is rarer, it never takes a compound's last
part, and every part it takes has only established parents. Tier-1
mint supply falls: 46 of the slots freed in the last 20 days were
graduation's, so surviving tier-1 mints a day drop from about 2.2
toward about 1 and the at-cap skip count rises.

Measure: tier-1 mints a day (rows by created_at); at-cap skips from
the function log; the evictor's new tier label; `evictable_graduated`
on the snapshot (reads 0 at deploy); at the next audit, the parent
set of every part that left, checked against the established test at
its deletion time.

Side effects to watch:

- The cap re-pins and the tier-1 pool ages. Watch the age
  distribution of tier-1 and the untested-tier count; if slots stop
  opening, the next lever is the tier-1 evict gate (14 days plus 10
  judged fires), not a looser graduation.
- Anchors go quiet. Each compound's anchor is suppressed by
  parent-wins whenever its compound makes the top-k, so it gathers no
  verdicts and its last-fired date ages; at 90 days the stale tier is
  entitled to it. Watch anchors' last-fired dates; an anchor
  released by the stale tier is a slower version of the problem M1.1
  closes.
- Multi-parent parts go last. A part shared by several compounds
  waits for all of them, which is the intent; it also means the
  parts most worth keeping are the ones graduation keeps longest.

### M1.2 Compound reap

Predicted: three compounds reaped on the first `:14` tick after
deploy and the fourth on the second (its 0.737 sits one p0 nudge
above the bar), taking the compound count from 41 to 37. Over the
following month two to four more follow - the ones already trending
there read 0.754 (76% soft misses), 0.799 (82%), 0.812, 0.815 and
0.841 - and after that roughly one reap every week or two as new
compounds mature. The compound count stops rising monotonically. The
four reaped compounds fire ten to twelve times a day between them;
those top-k slots go to other claims, and the two living parts among
them (one each in two compounds) fire on their own again. Tier-2's
share of daily fires falls from about a third toward a quarter.

Measure: the `:14` job's return count; `compounds_under_bar` on the
panel (3 or 4 for one hour, then 0); `reason = 'reaped'` rows in the
decline ledger with the right child keys; tier-2 count and tier-2
fires a day over the following weeks; the held rate of compounds
minted AFTER deploy at 21 and 45 days of age, against the baseline
59.2% and 66.1%.

Side effects to watch:

- The measured tier-2 health improves without any compound changing.
  Removing the four worst records lifts the tier-2 mean from 0.847
  to about 0.86 and the retained held rate from 62.3% to about 65%.
  That is deletion, not improvement; it is the reason the baseline
  table above exists and the reason the verdict archive is an open
  decision.
- The p0 ratchet. Each reap raises p0 by about a thousandth and the
  tier-1 underperformer bar with it. No tier-1 row is under the bar
  today; watch the first `:13` after a reap for a tier-1 eviction
  that would not have happened the hour before.
- A compound deleted between the fire query and the fire record. Look
  for the record RPC's foreign-key error in the logs around `:14` and
  for threads active at that minute with a missing cohort. Also
  confirm a thread whose cached priming payload still names the
  reaped id recovers on its next turn rather than failing on every
  turn until the cache refreshes; the plan's mid-turn risk assumes
  once per compound, which depends on that.
- The tombstone blocks little for part-less compounds (their child
  ids are dead and cannot co-fire) and blocks the one living part of
  the others from compounding for 90 days. Watch the new-compound
  rate against the 0.67-a-day baseline.
- Control verdicts of a reaped compound vanish with it, which moves
  the fired-versus-control denominator in the audit's selection
  query.

### M1.3 Observability

Predicted: no behavior change. The panel shows the under-bar count;
the evictor's log line carries a tier label so the next audit can say
which tier freed each slot instead of inferring it from vanished
parts.

Measure: the mapper test; the panel reading 3 or 4 then 0; a tier
label on every eviction log line.

Side effects: one more subquery in the snapshot RPC (negligible); a
fifth number in the panel's Evictable row (check it fits at phone
width); the evictor's return type changes, so the deploy must apply
the schema before the function or the caller reads an object as a
string for the minutes in between (it logs a garbled id and the mint
still proceeds; harmless, but it will look like a bug in the logs).

### M1 readout gate - M2 and M3 wait for this

M1 is judged at three points. Each readout reuses the two wide
queries from NOTES (the daily series and the union of cuts), so it
costs two approvals, and each is logged in the QA results tables.
Nothing in M2 or M3 starts before the 21-day readout is written down,
because M2's measurement is defined against M1's cohorts and M3
changes which compounds exist.

**Hour one (deploy + 1 to 2 hours).** Pass when: the `:13` and `:14`
jobs both read `succeeded`; three compounds are gone after tick one
and the fourth after tick two, each with a `reason = 'reaped'`
tombstone whose key matches its provenance; `compounds_under_bar`
reads 0; `evictable_graduated` reads 0; no fire-record foreign-key
error in the function log in the minutes around `:14`. Fail on any
of these and the reap job is disabled (`cron.unschedule`) while it is
diagnosed; the floor can stay.

**Day seven.** Pass when: zero graduation evictions in the week (the
tier label on every eviction log line is how this is counted); no
compound lost its last living part; tier-1 mints a day are at or
above 1; compound count is at or below 37 and every reap since
deploy had tally >= 1.9; no thread shows repeated cohort loss at
`:14`. Expected but not a failure: at-cap skips up, new-compound
rate down from 0.67 a day.

**Day twenty-one (the readout that gates M2).** Pass when: every
graduation eviction since deploy, if any, took a part whose parents
were all established at the time; compounds minted after deploy hold
at or above the baseline 59.2% at age 7-21 days, measured on that
cohort only (if the archive shipped, measured on all of them; if not,
on survivors, and said so); the reap rate has settled to about one a
week or less; tier-1 mints a day did not fall under 1 for the whole
window. The tier-2 population held rate is recorded but is NOT a
pass criterion, for the survivor reason above. The same readout
produces M2's input: the health, soft-miss share and age-at-reap of
every compound minted since deploy, which is what the replay is
compared against.

The scheduled audit is re-armed to the day-21 date when M1 ships, and
its prompt names this gate.

### M2 Decline criterion (if the measurement warrants it)

Predicted: compounds minted a week fall from about 4.7 toward
perhaps 2 to 3, and the ones minted reach the reap bar less often.
The replay over existing compounds declines a non-zero share, and the
declined ones are the ones with the worst records.

Measure: declines a week with `reason = 'declined'`; compounds minted
a week; the share of each month's new compounds under the bar by day
30 (baseline: 0 of 14 by day 21 for the post-deploy cohort; 4 of 27
by roughly day 30 to 40 for the pre-deploy cohort); the replay's
decline set against each compound's own health and soft-miss share.

Side effects to watch:

- Declines are re-offered after 7 days, so a high decline share spends
  a minter call per declined group per week. Watch the mint-tier2
  call count.
- The candidate finder advances past declined groups to weaker ones.
  Watch the lift and co-fire weight of what does get minted.
- A criterion that is too strict stalls tier-2 minting outright. Two
  weeks with no compound minted is the alarm.

### M3 Containment over living parts; merge repoint

Predicted: the sibling share among new compounds falls from 8 of 14
toward 1 or 2 of 14. Part-less compounds cover nothing under the new
rule (their live set is empty), so regions they covered become
mintable and a small burst of new compounds near old regions follows
deploy. After the repoint, no new provenance row dangles from a
merge.

Measure: siblings sharing two or more parts, by mint month; count of
compound provenance rows whose child no longer exists, split by
whether the child left by merge (should stop growing) or by eviction
(unchanged by M3); new compounds a week in the fortnight after
deploy.

Side effects to watch:

- Hub parts that co-fire with everything make containment stricter
  than Jaccard for compounds with three or four living parts; a
  group that shares two hubs with any of them is blocked. Watch for
  tier-2 minting stalling, the same alarm as M2.
- A repointed child list can shrink (the winner was already a child),
  so the live `group_key` no longer matches a decline written against
  the old list; harmless at a 7-day TTL, but it means a declined
  group can be re-offered early once.
- Winners of merges inherit parents and become harder to graduate
  under the all-parents rule, which is the intent, but it is one more
  way the cap re-pins.

### M4 Shadow arm precondition (verdict archive)

Predicted: no behavior change. Every comparison above becomes
reproducible after deletions, and the shadow arm becomes buildable.

Measure: archive rows appear for every deletion path (evictor, both
reapers, merges, the compound reap); row counts match the deleted
rows' judged-fire counts.

Side effects: table growth of a few dozen rows per deletion at the
current 165 fires a day, which is nothing; a trigger on a hot table,
which fires only on delete.

## VALIDATION

Nothing in the gate exercises SQL. The cloud session has no local
stack, so the local-stack steps below are written for a CLI session
and marked as such; the cloud session runs the prod read-only steps
and the two new unit tests.

Prod, read-only, before merge:

- Dry-run the M1.1 predicate as a count (expect 0 today: four
  compounds carry a tally of 6.0 or more, and none of them has a
  living part).
- Dry-run the M1.2 predicate (expect three compounds under the bar
  with tally >= 1.9, and one more once p0 moves); list their child
  keys; check whether any two share a child set and whether any has
  empty provenance (decides whether the distinct-on and no-provenance
  paths fire on tick one).
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
  verdicts behind its low health. Same as every deletion today, and
  the reason the verdict archive is an open decision rather than a
  later nicety: once M1.2 runs, the tier-2 record is a survivors'
  record too.
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
few wide results and compute locally. The rev 5 rival-interpretation
pass needed two: one daily series (messages, substrate, edges, mints,
fires and verdicts by tier) and one union of cuts over judged fires
(rank in cohort, thread length, claim age, prediction length, cohort
size, per-compound verdicts, population by tier). Reuse that shape.

Rival interpretations tested in rev 5 and their status: usage change
(rejected: flat); rank position, thread length, cohort size, claim
age, prediction length as drivers of the tier gaps (rejected: direct
standardization moves nothing by more than a point); period effects
from the 2026-09-07 prompt change or the 2026-10-02 control arm
(rejected for tier-1 held rate: 76.8 / 63.7 / 71.9 / 70.1 / 72.9 /
62.5 / 72.4 by week, no step); parent-wins as the source of the
engagement gap (accepted); survivor bias in every tier-1 figure
(accepted, unbounded); soft misses read as "untestable" rather than
"failed" (partly accepted: the words changed, the conclusion did not,
because a 59-fire sample at 23% held is a failure to predict whatever
the verdict label).

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
- rev 5 (2026-10-23): rival interpretations tested against prod
  (usage, survivor bias, parent-wins, rank, thread length, age,
  period effects, soft-vs-hard misses, p0 drag). PROBLEM rewritten:
  survivor-bias caveat on every tier-1 figure, engagement gap
  attributed to parent-wins, usage shown flat, p0 drag downgraded,
  "disproven" replaced by "does not predict", the sell-off reframed
  from throughput to row choice. M2 demoted to measure-first. Verdict
  archive added as M4's precondition and as an open decision for M1.
  PREDICTED EFFECTS section added with baselines, per-milestone
  predictions, measurements and side effects; the evictor gains a
  tier label in M1.3 so evictions can be attributed. Validation
  dry-run expectation corrected (four compounds do carry 6.0; none
  has a living part).
- rev 5a (2026-10-23): M1 readout gate added (hour one, day seven,
  day twenty-one) with pass criteria; M2 and M3 wait for the day-21
  readout, which also produces M2's input.
