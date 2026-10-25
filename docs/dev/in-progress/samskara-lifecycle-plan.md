# Samskara lifecycle: the tether (plan)

Status: DRAFT rev 5, 2026-10-25. Revised by owner decision: the
summary layer (tier-2 compounds) is RETIRED, not rescued - see
DECISIONS 5. Milestone M3 is now the retirement, with a full
artifact sweep. History: drafted 2026-10-23 by the second-session
reviewer from the vetting of the 2026-10-22/23 samskara brief,
refined through a seven-lens deep-mode fan-out and three
fresh-context consensus rounds (round 3: no blockers, both
introspection audits PASS; four mechanical should-fixes folded
after the final round - the last revision is unaudited by
disclosure). Prod-census provenance lives in
scratch/vet-samskara-2026-10-23/ (queries q1-q26, findings.md, the
tier-2 final snapshot).

## SYNOPSIS

Retire the summary layer completely - code, data, prompts, docs,
use cases, skill references - leaving a single-tier claim system.
Around it, land what the system has never had: one written,
testable statement of a claim's life (M0), an executable test
harness for it (M1), and death as a recorded event (M2). Then
simplify behind the green harness (M4), measure (M5), and bring
the 150-cap question to the owner once everything is working.

## PURPOSE

Unchanged from rev 1-4 (see git history for the full text): the
system's lifecycle contract is implicit, untested, and scattered,
so every audit rebuilds its assumptions - a book written one
paragraph at a time by authors who can only see the previous
paragraph. What changed on 2026-10-25 is the verdict on the
summary layer itself. The owner, shown the honest ledger:

- Nearly all rule growth since September traces to the summary
  layer (coverage guard, decline ledger, graduation, parent-wins,
  sibling minting, the compound-reap proposal).
- It holds a quarter of all evidence at lower precision than the
  specifics (81.7% vs 88.9% confirm share; held 62.3 vs 68.4 with
  measurement caveats).
- Its writer has never refused a single group in 41+ attempts.
- Retirement is smaller than rescue, reversible (nothing need be
  destroyed but the layer itself), and measurable with the same
  foundation milestones.

...chose retirement, in the owner's words: "Let's kill the
summary layer, leaving behind no artifacts." The rescue (old M3:
compound reap door, graduation floor, decline criterion, coverage
guard fix, merge repoint) is withdrawn; the w_soft-vs-reap-door
decision (old open decision 1) dissolves. The cap question
follows once the retirement is landed and working.

## THE LIFECYCLE CONTRACT (single-tier, post-M3)

Graduates into docs/dev/samskara.md as the canonical chapter (M0).
Bracketed markers flag behavior that does not exist yet.

BIRTH

- Two mint probes (recency cluster, association cluster), each
  gated by cap-or-evict headroom; a near-duplicate (centered
  cosine >= 0.5) reinforces the existing claim instead of minting
  [void after M4: the bump].
- At birth a row carries: prediction, embedding (model-stamped),
  valence, optional inner_voice, and the minter's confidence bet.
  Health at insert is the column default 1.0; the next deploy's
  reconcile pass (or the row's first genuine verdict) snaps it
  to the posterior - p0 at zero evidence. [after M4: one
  posterior column; the bet survives only as a transient
  mint-event field.]

EVIDENCE

- A claim fires when its embedding ranks in a turn's top-k
  (k = max(1, ceil(K_BASE x log10(N + 10))), K_BASE = 5, n = 100
  stand-in at the call site - k = 11 today; score = ramped
  centered cosine x sqrt(health x confidence) x evidence-size
  bonus).
- The next-day judge rules each fire: held / contradicted /
  not-borne-out (genuine) or not-engaged (no test). Genuine
  verdicts move the tallies: both first multiplied by
  d = 0.5^(1/10), then +1.0 confirm (held), +1.0 miss
  (contradicted), +0.25 miss (not-borne-out). Health is
  recomputed as the posterior (c + k*p0) / (c + m + k), k = 5,
  p0 = the pooled tally share sum(c)/sum(c+m) (0.66 fallback
  under 20 evidence), written to health AND confidence.
  Not-engaged touches nothing.
- Fires that no verdict can ever reach expire to not-engaged.
- A live control arm: per judged thread, three random unfired
  claims are blind-judged; ledger only.

EVENTS THAT BEFALL A LIVING CLAIM

- Reinforce: a mint-time near-duplicate bumps the existing claim
  (transient - void after M4).
- Merge: two claims that reliably co-fire fold; the loser's fires
  retarget to the winner, its provenance copies, its tallies
  fold, the loser row dies. [after M3: no compound provenance
  exists to repoint - the kind='samskara' provenance rows die
  with the compounds.]

DEATH (four doors, all hard-delete)

1. reap_dead: health < 0.5 * p0 AND no fire for 14 days.
   Unreachable for soft-miss-only claimants (the floor
   arithmetic; pinned by the harness).
2. reap_untested: zero evidence tallies, 45+ days old, no
   pending fire.
3. Cap-pressure eviction, in order: untested (14+ days, 10+
   judged fires, zero genuine), stale (90 days without a
   genuine-verdict fire, tally <= 1.0), underperformer
   (health < 0.85 * p0). One slot per pending mint. The three
   tiers are one caller; each tags its own reason [after M2].
4. Merge loser.
Plus account deletion (cascades everything; no nak code runs).
Every death cascades the claim's fires, provenance, and control
rows. [After M2: every death writes exactly one certificate row.]

THE ALWAYS-ON PARAGRAPH

- The "current best model of who this user is" prose block
  (samskara_compound_summary + its regen) is NOT part of the
  summary layer and stays. It has always been fed by the top
  claims of both kinds; post-retirement it is fed by the single
  tier. Its "compound" naming is historical - one comment says
  so; no rename (a rename is churn, not simplification).

### The profiles (personas the tests simulate)

Seeded on a standing population first - a lone profile distorts
p0, which pools over the whole corpus.

| Profile | Shape | Expected behavior (the assertions) |
| --- | --- | --- |
| Newborn | minted, never fired | health = 1.0 at insert; p0 after a reconcile pass; fireable |
| Workhorse | fires often, holds | tallies grow toward the 14.93 ceiling; health pins high; no release path touches it |
| Soft-misser | engages, tendency never shows | health converges to ~0.5 and NEVER breaches reap_dead's floor (immortality - the pinned current defect); evictable at cap pressure via the underperformer door |
| Contradicted | hard misses | health CAN breach 0.5*p0; with 14 quiet days reap_dead takes it |
| Ghost | fires topically, never engages | all not-engaged, tallies zero; reap_untested takes it at 45 days once unjudgeable-expiry clears its pending fires |
| Merge loser / winner | co-firing pair folds | fires retarget, no duplicate (cohort, claim) rows, loser's certificate reason = merged [after M2] |
| Reinforce target | a mint-time near-duplicate arrives | today: health bumps +0.02 and the next evidence/deploy recomputes it away (pinned); [after M4] no bump |
| Population invariants | - | the pool never exceeds the cap through the mint gate; [after M2] every death writes exactly one certificate with the door's reason; health is always the posterior of (tallies, p0) as maintained by apply/reconcile [after M4.3]; p0 pools the corpus |

## DECISIONS

1. Soft-deletion: dropped (2026-10-23). The measurement need is
   served at the delete boundary (M2).
2. Death certificate: accepted with reservations (2026-10-23);
   the reservations became the plan's spine (M0 + M1).
3. Guardrail rule (owner): when a design needs guardrails to
   protect the system from the design, the design is in the wrong
   place. The lifecycle tests are the contract, not guardrails.
4. Fixes land in existing machinery; the accepted schema
   additions are the certificate table, its trigger, and the
   declines reason column - the latter is now MOOT (the declines
   ledger is retired with the layer).
5. **RETIRE THE SUMMARY LAYER (owner, 2026-10-25, superseding
   the rescue).** Full removal, no artifacts: code, prompts, data,
   docs, use cases, skill references. The always-on paragraph
   stays (fed by the single tier). Reversible in principle: a
   future session could rebuild a two-tier system on measured
   need, but nothing is preserved for it beyond git history and
   the final snapshot (tier2-final-snapshot.json in this
   directory - every compound, its tallies, its verdict counts,
   its part list, taken 2026-10-25 before any deletion; the
   intended audit trail).
6. The 150-cap question is explicitly PARKED until the
   retirement is landed and everything is working (owner, same
   message). M5's readout is the input to that conversation.

Open (blocks the milestone named):

- M4.1's mood-pill axis: recommendation is the transient
  event-field bet (nothing stored). The reopen-seed axis is
  lost - named behavior change.
- M4.3's reinforce path: observability-only.

## INTENT AND OVERRIDES

The archaeology findings stand (see git history for the full
map; commit citations verified): the soft-miss floor was a
deliberate gentle-launch property; graduation's ANY-parent join
was a silence; the stripped-bare outcome was an anticipated,
watched tradeoff; the bump/decay functions cited in the column
comment never existed. The retirement decision now supersedes
the intent question for everything compound-side: the watched
"slow loop" ends by removing the loop. What remains
intent-relevant post-retirement: the w_soft gentle launch
(unchanged by this plan - reap_dead's floor arithmetic stays as
is, pinned by the harness), and the confidence mirror
(documented-as-temporary since 5840d74d - M4.1 retires it).

## MILESTONES

Order is load-bearing: M0/M1/M2 (tether, harness, certificate)
and M3 (retirement) can proceed in that order; M4 lands behind
the green harness; M5 measures. Until the harness joins the CI
gate (an M5 decision point), every SQL-touching PR's definition
of done includes a manual `mise run lifecycle-test` run.

### M0 - the tether, prose form

Rewrite the front of docs/dev/samskara.md around the single-tier
contract above. With M3 landing in the same arc, the tier-2
sections of the dev doc are REMOVED (not marked legacy) - the
canonical chapter describes the system as it is. Repairs: the
samskaras column comment citing never-existing functions, the
14.4 ceiling (14.93), the mint-to-reconcile health window.
A door-to-reason map rides with the contract. The
samskara-audit skill's ground rule 1 already points sessions at
the dev doc; the chapter becomes what they read first.

### M1 - the lifecycle test harness (SQL island)

As refined through round 3 (see git history for the full
spec): scripts/lifecycle-test.mjs on the dev-local.mjs precedent
(scripts/lib/shell.mjs + ui.mjs; loopback-guarded supabase
status discovery; explicit DATABASE_URL env override for a future
CI service container); port the stub and proofs from
scratch/vet-samskara-2026-10-23/ to tests/lifecycle/ (scratch is
gitignored - the port is the commit); standing population seed;
one file per profile row; ASSERT-in-do-block convention;
pin-current-first (defects included); the docs/dev/testing.md
section for the new SQL island. The compound/part/
coverage-guard/decline-ledger profile rows are dropped from the
spec (retired); the soft-misser immortality pin stays (it applies
to the single tier's reap_dead door).

### M2 - the death certificate

As refined through round 3 (see git history): the table
(append-only, no FKs, CHECK-constrained reason enum - now
reaped-compound is REMOVED from the enum; the doors are reap-dead
/ reap-untested / evict-untested / evict-stale /
evict-underperformer / merged / account / unknown), the
SECURITY DEFINER BEFORE DELETE trigger with transaction-local
set_config tags and account detection via auth.users absence,
the authenticated-role delete profile, the merge zero-verdict
note, the certificate-write failure coupling named and accepted.
Sequencing note: the retirement (M3) deletes 47 prod compounds;
the pre-deletion snapshot (decision 5) is this event's audit
trail; the certificate covers every death after it lands.

### M3 - retire the summary layer (owner decision 2026-10-25)

Full artifact removal. The inventory, by surface:

SCHEMA (supabase/schema.sql):

1. Data cleanup, self-retiring and FIRST in apply order:
   `do $$ begin if exists (select 1 from information_schema
   .columns where table_name = 'samskaras' and column_name =
   'tier') then delete from samskaras where tier = 2; end if;
   end $$;` - then the column can drop. Fires, provenance
   (kind='samskara' child links cascade with the compound rows),
   and control verdicts of compounds cascade with them.
2. Drop `alter table samskaras drop column if exists tier` and
   the `tier in (1, 2)` check; drop `samskaras_user_tier_idx`.
3. Drop table `samskara_tier2_declines` (`drop table if
   exists`, with its policies).
4. Drop function `samskara_tier2_candidate` (carries the
   coverage guard, the *tier2** temp tables, the probe budget,
   and the decline-TTL logic - all of it).
5. Remove the graduation branch from `samskara_evict_for_mint`
   (the fourth tier-select and its join to kind='samskara'
   provenance); the remaining three tiers stand.
6. Remove parent-wins from `samskara_fire_top_k`
   (leading_compounds / covered_children CTEs and the tier
   reference in scored).
7. Remove 'samskara' from the provenance kind check.
8. Remove the p_tier param and tier columns from the
   observability and mint RPCs: `samskara_search_by_prediction`
   AND `samskara_cluster_corpus` (the debug page's tier filter)
   AND `samskara_nearest_by_prediction` (the mint dedup guard -
   its tier-1 call sites pass no p_tier, so the strip is
   behavior-neutral for the surviving path; the p_tier: 2 call
   dies with mintTier2Probe).
9. Strip tier from the remaining tier-aware SQL:
   - `samskara_health_snapshot` (the debug page's Health
     snapshot RPC: tier1/tier2/evictable_graduated return
     columns, s.tier filters, the graduation mirror's
     kind='samskara' provenance join) - consumers: the src
     slice's tier2 row map and SamskaraHealthPanel.
   - `samskara_provenance_detail` (KEEP list - strip the
     ref_tier output column and the kind='samskara' case).
   - `samskara_collapse_by_cofiring` (tier = 1 filters in both
     passes - plpgsql, so an unedited body ships green and
     kills the sweep's dedup phase at first runtime call).
   - the three surviving eviction branches in
     `samskara_evict_for_mint` each carry `and s.tier = 1` -
     strip the predicates (same runtime-death class).
10. KEEPS: `samskara_compound_summary` + its three regen RPCs
   (the always-on paragraph; verified tier-blind: no tier filter,
   column, or payload ref in the regen probe or the RPCs),
   `samskara_reinforce_existing`, the centering family,
   `samskara_verdict_counts`.
11. The evictor's caller-side comments referencing graduation.
12. tests/schema-grants.test.ts pins `tables.length >= 53` and
   the retirement removes one table - lower the floor to 52 in
   the same PR (verify the dml-columns floors survive the
   removal rather than assuming).

AGENT (supabase/functions/venice/agents/samskara.ts):

- Remove TIER2_MINTER_PROMPT, mintTier2Probe, the sweep's
  mint-tier2 phase, and the decline-ledger upsert.
- Remove `tier` from insertMint (param, payload, types) and from
  publishSamskaraMint (_shared/samskara-mint.ts payload + the
  Deno mint-test pin).
- KEEP COMPOUND_SUMMARY_PROMPT and the compound-regen sweep
  phase (the always-on paragraph); add the one-line historical-
  name comment.
- tier1AtCap / TIER1_POPULATION_CAP: the cap logic stays for
  the single tier; rename TIER1_POPULATION_CAP ->
  SAMSKARA_POPULATION_CAP and sweep the "tier-1" vocabulary from
  comments as they are touched (the tier concept is gone).
- samskara_evaluation.ts: sweep tier vocabulary from comments;
  no behavior change (it is already tier-blind).
- priming/samskara.ts + samskara-format.ts: getCompoundSummary
  stays; sweep the single tier word in the formatter (the
  FiredSamskara display shape) as found.

SRC (browser):

- src/lib/supabase/types/samskara.ts + src/lib/supabase/
  samskara.ts: remove tier from row types, selects, row maps,
  and samskaraGetLatestFireMood; remove the tier param from the
  observability RPC calls; remove the samskaraTier2CandidateSize
  wrapper (calls the dropped candidate RPC) and the
  tier2CandidateLabel in src/lib/ui/samskara-health.ts.
- src/lib/samskara/events.ts + mood.svelte.ts: the MintEvent
  tier field and the mood pill's tier axis (check
  SamskaraMoodSync, SamskaraMoodLegend, SamskaraMood - the pill
  keeps valence and confidence axes; the tier axis goes).
- The mood-pill tier axis ALSO feeds the shared diagnostics
  column (DiagnosticPills.svelte class:tier-2 halo, the pill
  title in src/lib/ui/diagnostic-pills.ts, and
  tests/diagnostic-pills.test.ts fixtures) - the registry-driven
  pill surface, per docs/dev/diagnostic-pills.md.
- src/lib/supabase/realtime.ts: the toast payload tier.
- Debug page (src/screens/Samskaras.svelte + SamskaraBrowseList,
  CohortPanel, SamskaraHealthPanel + their ui/ modules): remove
  tier badges, tier filters, tier rows; the panels stay.
- Stragglers the gate will catch, named for completeness: the
  src/lib/supabase.ts facade (onMint type, mood return, tier
  params), src/lib/ui/samskara-toasts.ts source tier fields,
  src/lib/samskara-browse-store.svelte.ts tier state.
- src/lib/chat/*: the compound-summary paragraph wiring STAYS.

TESTS:

- supabase/functions/tests/samskara.test.ts: remove the
  TIER2_MINTER_PROMPT pins; fix the insertMint payload pin
  (no tier).
- samskara-mint.test.ts: the publish payload pin (no tier).
- priming-samskara-format.test.ts + priming-orchestration/
  payloads: compound-summary block tests STAY; tier refs swept
  (the formatter carries two tier-2 words in comments, not one).
- vitest: samskara-browse(-store), samskara-events, samskara-
  health, samskara-toasts, AND tests/diagnostic-pills.test.ts
  (tier fixtures) - tier fixtures and assertions swept.

DOCS AND USE CASES (the sweep the owner called out):

- docs/dev/samskara.md: tier-2 sections removed (with M0); the
  README entry updated.
- docs/dev/architecture.md, chat.md, components.md,
  prompt-augmentation.md, planned-changes.md (the graduation
  watch item gets a one-line resolution: retired),
  second-thoughts.md, logging.md, in-progress/intents.md:
  compound references swept.
- docs/user/samskara.md + README.md + background.md: compound
  mentions and the tier display updated (user-visible change:
  same-PR per repo rule).
- docs/qa/use-cases/samskara-tier2-mint.md: retired - final
  results entry (the retirement IS the outcome), then removed
  from the index (the file records history in the log; delete or
  keep per the QA README's retirement convention).
- samskara-formation.md and samskara-cap-eviction.md: the
  tier-2 legs and the graduation tier documented there are
  updated to current behavior.
- .claude/skills/samskara-audit/SKILL.md: stage 6 (tier-2
  aggregation) removed; the tier-2 checks in stages 4-6 swept.
- docs/dev/plans/ tier-2-named plans get a one-line "retired
  2026-10-25" status banner, enumerated (not name-matched):
  samskara-tier-2-plan.md, samskara-tier2-detection-quality-
  plan.md, samskara-association-mint-plan.md (tier-2 refs),
  samskara-observability-section-plan.md (tier-2 + compound
  refs). Not deleted - the plans dir is the archive; the dev
  doc is the living reference.

PROD SEQUENCING (with the owner, at deploy time):

- The snapshot is taken (2026-10-25, decision 5).
- The deploy applies the cleanup block -> 47 compounds and
  their cascades vanish in one statement; the column drops.
- The compound-summary cache row survives (the paragraph regens
  from the single tier on its staleness cycle).
- Verify after deploy: pool count unchanged for the living tier
  (150 at the last reading, +the 28 living parts unaffected),
  zero tier-2 rows, the debug page renders, a chat turn fires
  claims, the paragraph regenerates.

- Predictions: the diff is large but almost pure removal; the
  gate's schema scanners (dml-columns, grants) must stay green;
  svelte-check catches the UI sweep; the Deno suite pins the
  changed prompts (COMPOUND_SUMMARY_PROMPT stays, TIER2 pins
  removed).
- Measurements (readout gates): hour one - zero tier-2 rows,
  fires per message roughly doubles for the former parts (the
  28 living parts resume firing unsuppressed), the paragraph
  regenerates, and EVERY sweep phase runs green for the first
  24 hours (the dedup phase and cap-pressure eviction are the
  runtime-only breakage class this review caught by grep - the
  sync going green proves nothing about them). Days 1-7 - the
  p0 discontinuity: deleting 47 compounds (a lower-confirm-share
  slice of the evidence pool) RAISES pooled p0 for every
  survivor, and both death bars are p0-relative - watch the
  certificate's death counts and reasons histogram for the
  predicted one-time eviction/reap uptick spreading across the
  14-day/90-day quiet windows. Day 7 - cohort diversity: watch
  for the pre-2026-10-01 shape (one idea family taking 3-4 of
  the 11 slots; the audit skill's concentration metric is the
  instrument). Day 21 - the input to the cap conversation:
  backlog slope, at-cap skip rate, eviction pool composition.
- Side effects: named above; the paragraph is unchanged in
  mechanism.

### M4 - the simplification sweep (behind the green harness)

Items 1-4 stand as refined through round 3 (confidence column
drop with the complete writer/reader inventory including the
create-table-definition edits and the index recreation;
was_confirmed drop from samskara_fires with the writer-first
inventory; the void reinforce retirement; the retired-blocks
prune). Item 5 (chapter follows the code) now includes the
post-retirement contract un-marking. The compound-dependent
sub-items (declines reason column, compound-reap RPC) are MOOT.

### M5 - formation throughput readout (measure, do not build)

Stands: backlog level and slope, mint/evict/skip rates, cap
excursions, certificate reasons histogram, plus the retirement
readouts above. This readout is the input to the 150-cap
conversation (decision 6).

## WHAT THIS PLAN REPLACES

- The 2026-10-22/23 brief (scratch/vet-samskara-2026-10-23/
  findings.md): its compound-accountability design, tombstone,
  and soft-deletion options - superseded.
- docs/dev/plans/samskara-soft-delete-plan.md and
  samskara-compound-accountability-plan.md (authoring branch):
  superseded by decisions 1 and 5.
- The summary layer itself (M3): retired per decision 5.

## PREMISE LEDGER

Carried from rev 4 (git history holds the full verified ledger:
eviction tiers, reap floors, cascades, the judge's write surface,
the evictor truthiness gate, the confidence/was_confirmed
consumer inventories, the intent citations). New premises
verified 2026-10-25 for the retirement:

- Zero intents target compounds (q26.sql: intents_on_compounds
  = 0 of 12 samskara-targeting intents) - no cross-feature
  coupling.
- 47 tier-2 rows live at the time of the decision (was 41 at the
  10-23 reading; minting continued); their fires and control
  verdicts cascade.
- The final snapshot is taken: scratch/vet-samskara-2026-10-23/
  tier2-final-snapshot.json (every compound: prediction, health,
  tallies, verdict counts, part list with liveness).
- The tier-2 artifact inventory above was grepped file-by-file
  (frontier-model false positives excluded; the samskara
  surface is the list above; e2e has no samskara specs; the
  bias system's tier vocabulary is its own, untouched), then
  reviewed by a fresh-context removal reviewer whose four
  inventory blockers (samskara_health_snapshot, the
  provenance_detail strip, samskara_nearest_by_prediction,
  samskara_collapse_by_cofiring) and the surviving-branch
  s.tier strips are folded in. The apply is not guaranteed
  atomic (the sync POSTs the whole file as one query; mid-file
  failure leaves a partial state) - the mitigation is
  completeness of the same-file strip (no later statement
  references the dropped column) plus the file's idempotence:
  a retry re-applies cleanly from the top.

## REVIEWER INSTRUCTIONS (for the refinement round on this revision)

The owner decision is out of scope (it is made). Review the
REMOVAL: walk the inventory against the repo and name any
consumer of tier-2 machinery the inventory misses (the
pre-mortem question: who knows about this state that the
retirement does not?), any ordering hazard in the schema apply
(cleanup block vs column drop vs the grants scanner), any test
or doc artifact left stale, and whether the retirement's
readout gates answer "did this work". The KEEP list (the
always-on paragraph, its table, its RPCs, the regen phase) is
the highest-risk area: verify nothing in it silently depends on
tier-2 rows or the tier column. file:line everything.
