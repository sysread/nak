# Samskara soft-deletion

Status: DRAFT rev 1 (2026-10-23). Lands before M1.2 of
[the compound accountability plan](./samskara-compound-accountability-plan.md),
whose tombstone design it replaces. Revision log at the end.

Every `file:line` below was read in this session against
`supabase/schema.sql` (17,484 lines) and the TypeScript tree. A
premise that was not checked is marked unverified.

## SYNOPSIS

Claims (`public.samskaras`) are hard-deleted today, and three child
tables cascade with them: fires, provenance and control verdicts.
Every release path erases the record it was judged on, which is why
no tier comparison in the audits can be trusted. This plan replaces
every delete with a stamp (`deleted_at`, `deleted_reason`), puts a
live-rows view in front of the table, moves every reader that means
"living claims" onto the view, and keeps the base table for the five
deleters and the handful of readers that want history.

## PROBLEM

- **Deleting a claim deletes its evidence.** `samskara_fires`,
  `samskara_provenance` and `samskara_control_verdicts` all reference
  `samskaras(id) on delete cascade` (`schema.sql:8010`, `7969`,
  `8153`). Tier-1 turns over at about two rows a day against a cap of
  150; tier-2 has never lost a row. So every tier-1 figure is a
  survivors' figure, and after the compound reap ships tier-2's will
  be too. The compound plan's PROBLEM section has the numbers.
- **Dead children dangle.** Provenance rows that point at deleted
  parts survive only as ids (`ref_id` has no FK, `7962-7964`), which
  is why the coverage test counts dead ids in its denominator and why
  the UI renders "(removed)" from a null join.
- **Evictions cannot be attributed after the fact.** The evictor
  returns a bare id (`9667-9775`) and nothing records which tier
  picked it; the compound plan infers graduation's 46 slots from
  vanished parts.

## DESIGN

### Columns

On `public.samskaras`, added with `add column if not exists` next to
the existing column additions (see Ordering below):

- `deleted_at timestamptz` - null for a living claim.
- `deleted_reason text` - null for a living claim; otherwise one of
  `evict-untested`, `evict-stale`, `evict-underperformer`,
  `evict-graduated`, `reap-dead`, `reap-probation`, `merge-loser`,
  and, once the compound plan ships, `reap-compound`.
- A named check constraint `samskaras_deleted_consistency_check`
  (`(deleted_at is null) = (deleted_reason is null)`) and a named
  check on the reason values, both added inside guarded `do` blocks
  so re-apply is clean (the file's convention, header of
  `schema.sql`).

No backfill: every row that exists today is alive.

### The view

`public.samskaras_live` = `select <explicit column list> from
public.samskaras where deleted_at is null`, created with
`create or replace view ... with (security_invoker = true)`. The
schema already has one such view (`grocery_products_view`,
`4544-4545`), and the project pins Postgres 17 (`supabase/config.toml:36`;
invoker views need 15).

- **Invoker security, NOT security barrier.** Under invoker security
  the base table's RLS applies to the caller, so the browser client
  sees its own rows and the service role sees everything, same as
  today. A barrier view would stop the planner from pushing the
  deleted-at test into the scan, which is the performance property
  the next section depends on.
- **Explicit column list**, not `select *`, so the view's shape is
  under control. `create or replace view` can only append columns;
  a future column reorder needs `drop view if exists` first, and
  SQL-language functions that name the view do not block the drop
  (they fail at call time until it is recreated). Documented in the
  view's header comment.
- The view is not a publication member (views cannot be) and the
  table is already excluded from realtime (`14226-14244`); nothing
  changes there.

### Performance: the filter runs before the math

The chat-turn matcher (`samskara_fire_top_k`, `8507-8584`) computes a
cosine against every claim's embedding. The requirement is that dead
rows never reach that expression. Three facts make it hold, and the
third is a test:

1. A non-barrier view is inlined, so `deleted_at is null` becomes an
   ordinary scan qual on the base table, evaluated per row before
   the select list and before the order-by expression.
2. The embedding is a 2048-float vector, stored out of line (TOAST),
   and is only fetched when an expression touches it. A row rejected
   by the qual never de-TOASTs its embedding.
3. The two indexes on the table (`samskaras_user_tier_idx` on
   `(user_id, tier)` at `7910-7911` and `samskaras_user_health_idx`
   at `7913-7914`) are replaced by partial twins with
   `where deleted_at is null`, so index-driven scans never visit dead
   rows at all. The deleters' own `where deleted_at is null`
   predicate also uses them.

Acceptance: `explain (analyze, buffers)` of the fire query on the
local stack with a few hundred soft-deleted rows forged shows the
filter on the scan node and no row count above the live count
reaching the sort. Marked **unverified** until that run.

Growth: at about two deletions a day the base table gains roughly
700 rows a year. The heap tuple without its TOASTed embedding is
small; the embedding stays (the column became nullable at
`9121-9122`, but nothing nulls it on delete, so a reaped claim's text
and vector remain inspectable).

### Ordering inside schema.sql

The file applies start to finish, and SQL-language functions are
validated when created, so the view must exist, with every column it
lists, before the first SQL-language function that names it. Today:

- the table is created at `7866-7908`;
- its later column additions sit at `9104-9109` (`embedding_model`,
  `embedding_claim_holder`, `embedding_claim_expires`) and
  `9121-9122` (`prediction_embedding drop not null`);
- the first SQL-language reader is `samskara_fire_top_k` at `8507`
  (`language sql` at `8520`, reference at `8539`), which is BEFORE
  those additions.

So the additions at `9104-9109` and `9121-9122` move up to directly
after the `user_id` default at `7957-7958`, the new columns and
constraints follow them, the partial indexes replace the two at
`7910-7914`, and the view is defined after all of that and before the
provenance table at `7968`. `tests/schema-grants.test.ts:90-105`
requires every view above the single grant block; this placement
satisfies it.

### Who names what

The rule, written as a header comment on the table and on the view:
**a function names `public.samskaras` only to write it, to delete
(stamp) it, or because it deliberately wants dead rows; everything
else names `public.samskaras_live`.**

**Deleters (base table; each becomes `update ... set deleted_at =
now(), deleted_reason = '<reason>' where ... and deleted_at is
null`):**

- `samskara_reap_dead` (`9412-9434`, delete at `9426`) -> `reap-dead`.
- `samskara_reap_untested` (`9469-9486`, delete at `9476`) ->
  `reap-probation`.
- `samskara_evict_for_mint` (`9667-9775`, delete at `9773`) -> one of
  the four `evict-*` reasons; the function gains a local that records
  which tier selected the victim, and returns `(id uuid, reason
  text)` instead of a bare uuid (drop-and-recreate; the one caller at
  `supabase/functions/venice/agents/samskara.ts:1269-1283` reads
  `.id` and logs the reason). Its four tier selects (`9675`, `9699`,
  `9725`, `9751`) read the view, and so does the compound join at
  `9754`: a dead compound's provenance now survives, and a base-table
  join there would let a dead compound graduate its parts.
- `_samskara_merge_pair` (`10139-10198`, delete at `10196`) ->
  `merge-loser`. Its comment at `10173-10175` says the loser's
  remaining provenance "cascade-deletes"; it no longer does, and the
  comment is rewritten. The loser's provenance, fires that were not
  retargeted, and control verdicts stay on the dead row.
- The compound plan's `samskara_reap_compounds` -> `reap-compound`.

**Writers (base table, unchanged):** `samskara_record_fires` update at
`8664-8672` (but see below), `samskara_claim_next_prediction_embed`
update at `9199`, `samskara_save_prediction_embedding_if_claimed` at
`9225`, `samskara_apply_evaluation` update at `9376`,
`samskara_reinforce_existing` update at `10108` (gains
`and deleted_at is null`; its existence check at `10101` reads the
view so dedup against a dead row returns false and the claim is
re-minted, which is what `9467-9468` promises), the merge's winner
update at `10185`, and the edge function's mint insert
(`agents/samskara.ts:932-945`). None uses `on conflict` on this
table.

**Readers that move to the view (every reference listed):**

- `samskara_refresh_centering` `8428-8432` (centering mean over live
  claims only).
- `samskara_fire_top_k` `8539`.
- `samskara_record_fires` `8652-8662` insert and `8664-8672` update:
  both filtered through the view. Today the FK rejects a fire for a
  claim deleted mid-turn; after this change the base table would
  accept it, so the function must refuse it itself.
- `samskara_claim_next_prediction_embed` `9190` (no embed calls on
  dead rows).
- `samskara_population_p0` `9277`.
- `samskara_apply_evaluation` `9373` (`computed` CTE; evidence is not
  folded into dead rows).
- `samskara_reap_dead` `9424` (the distinct-users loop).
- `samskara_should_regen_compound` `9890-9892`.
- `samskara_nearest_by_prediction` `10055`.
- `samskara_collapse_by_cofiring`: pair joins `10315-10316`, the
  "still exists" checks at `10340-10341` and `10387-10388` (a
  soft-deleted loser would otherwise pass and be merged twice,
  double-folding its counters), the tier-1 count against
  `p_target_count` at `10352-10354`, and `10364-10365`.
- `samskara_tier2_candidate`: `10546` (`v_active`), `10606-10607`
  (edge joins), `10630` (the join that builds existing compounds'
  child sets; a dead compound must stop covering its region, which
  cascade used to do for free), `10743`.
- `samskara_search_by_prediction` `10801`.
- `samskara_cluster_corpus` `10855`, `10866`, `10892` (all three or
  the slider disagrees with itself).
- `samskara_provenance_detail` `10935`: the left join to the child
  reads the view so a dead child still renders as "(removed)"
  (`10912-10914`). A richer "removed: reason" display is a later UI
  change, not this plan.
- `samskara_health_snapshot` `11016-11167`: every population count
  (`11041`, `11043`, `11045`, `11047`, `11049`, `11054`, `11062`,
  `11073`, `11086`, `11105`, `11108`) and both inlined p0 copies
  (`11093-11100`, `11118-11125`). `orphan_fires` (`11154-11158`)
  tests the base table and would read 0 forever; it is redefined as
  "fires whose claim is deleted" (base minus view) and its comment
  says so.
- `intent_mint_claim_next_user` `16334`.
- The one-time reconcile block at `9843-9858` loops distinct users
  from the base table and calls p0; it moves to the view. The other
  two repair blocks (`9146-9174`, `9814-9832`) touch dead rows
  harmlessly and stay.

**Readers that stay on the base table on purpose (each gets a
comment saying why):**

- `samskara_cluster_thread_fires` `8765`, `8793`: the thread
  diagnostics modal lists every fire in a thread; a dead claim keeps
  its embedding and clusters normally instead of falling into the
  orphan-singleton path at `8777-8785`.
- `samskara_rates` `11203`: mint throughput counts claims later
  deleted.
- The judge's id-keyed claim lookup (below).

**Functions that never touch the table** and need nothing:
`samskara_verdict_counts`, `samskara_expire_unjudgeable_fires`,
`samskara_sweep_users`, `samskara_associate`,
`samskara_association_cluster`.

### Child tables keep their rows: what changes meaning

- **Fires of a claim deleted after it fired are now judged.** The
  judge looks the fired claims up by id (`agents/samskara_evaluation.ts:501-504`);
  that lookup reads the base table so the prediction text is found,
  the verdict is written to the fire row (`:628`), and
  `samskara_apply_evaluation` skips the dead row through its
  `computed` CTE. History is complete, nothing dead is reinforced,
  and `fires_awaiting_judgment` does not inflate. Cost: a claim
  deleted in the day between firing and judgment (about 1-2% of
  fires at two deletions a day) adds one entry to a judge batch.
- **The control sample stays live** (`:364-368` reads the view): a
  control must be fire-eligible.
- **Collapse and tier-2 detection** join fires to the view, so dead
  claims' fires drop out of pair enumeration (`10297-10316`,
  `10593-10607`). The tier-2 lift denominator `v_cohorts`
  (`10556-10558`) counts cohorts, not claims, and keeps cohorts in
  which only dead claims fired; that counts turns, which is the
  intended denominator, and shifts lift values slightly downward on
  the day of deploy. Accepted and recorded in PREDICTED EFFECTS.
- **Eviction and probation guards** that look for pending fires of an
  already-chosen claim (`9481`, `9682-9714`, `9762`; snapshot
  `11059-11084`, `11115`) are keyed on live ids and need nothing.
- **The browser's two embeds through the fires table**
  (`src/lib/supabase/samskara.ts:204-210` mood pill, `250-256` cohort
  fires list) go through the FK and would return dead claims. The
  mood pill adds a filter on the embedded claim's `deleted_at`
  (PostgREST supports filtering an `!inner` embed's columns). The
  cohort list WANTS dead claims: it is history, and
  `CohortPanel.svelte:222` already renders "samskara deleted since
  fire" when the embed is null. The embed gains `deleted_at` and
  `deleted_reason`, the row type (`types/samskara.ts:158-165`) gains
  them, and the label condition moves from "embed is null" to
  "deleted_at is set" through a primitive in `src/lib/ui/` (the
  component stays glue). This is a user-visible change and
  `docs/user/samskara.md` names it.

### The RLS delete policy

`"samskaras self-deletable"` at `7947-7949` lets a signed-in client
hard-delete its own claims. No UI or facade path uses it
(`SamskaraBrowseList.svelte:9` says read-only; `src/lib/supabase.ts:1648-1751`
exposes no delete). It is dropped (`drop policy if exists`) so the
only way a claim leaves is a stamp. Insert, update and select
policies stay (`7935-7945`).

### Accessor modules

Two runtimes, two modules; the `$shared` alias
(`vite.config.ts:51-59`) is restricted to code without a Supabase
client, so only the two name constants could be shared and that is
not worth an import.

- **Browser:** `src/lib/supabase/samskara.ts` already is the data
  module for this feature (every browser read of the table lives in
  it, `373-377`, `440-447`, plus the two embeds). It gets the
  module-level doc comment and its two direct reads move to the view.
  No new file.
- **Edge:** a new `supabase/functions/venice/agents/_samskara_data.ts`
  (underscore prefix is the local convention for shared helpers,
  e.g. `_curation_helpers.ts`, `_accumulator.ts`) with the doc
  comment and one function per call-site shape, named by intent:
  the mint insert (`samskara.ts:932-945`), the live tier-1 count
  (`1237-1241`, the cap gate - it MUST count the view or the cap
  never frees), the top live claims for the compound summary
  (`1807-1813`), the live control pool (`samskara_evaluation.ts:364-368`),
  the id-keyed lookup INCLUDING deleted rows for the judge
  (`501-504`, named so the inclusion is visible at the call site),
  the live valence map (`intent.ts:392-395`) and the top live claims
  for the intent minter (`512-517`). The Deno fake client in
  `supabase/functions/tests/samskara.test.ts:250-268` checks
  `table === 'samskaras'` and is updated per shape.

The doc comment on each module says, in a form grep finds: this is
the data module that wraps access to the samskara tables; reads of
living claims go through `samskaras_live`; the base table is named
only to insert, and in one place to read deleted rows for the judge.

Per the owner's call, there is no guardrail test on the app side.

### The one guard: a schema test

`tests/schema-live-view.test.ts`, modelled on
`tests/ordering-guardrail.test.ts` (walks sources, matches a pattern,
reports `file:line`, and pins known counts so the scan cannot go
blind): split `schema.sql` into function bodies, and assert that a
body naming `public.samskaras` (not `_live`) belongs to an allowlist
(the five deleters, the writers, the three deliberate base readers,
the view definition and the repair blocks). It also asserts the view
is defined above the first `language sql` function that names it.
A missed reader on the SQL side is silent and breaks the cap count;
this is the one place the plan keeps a test over a comment.

### Deploy ordering

The deploy applies the schema (`.github/workflows/deploy.yml:59`)
before it deploys the edge functions (`:79`). In the minutes between,
the old edge code still reads the base table; if the `:13` reapers
stamp a row in that window, the old mint gate over-counts by that
row for a few minutes. The SQL side switches atomically. Accepted.

### Attribution, for the compound plan

`deleted_reason` is the eviction attribution the compound plan's
M1.3 wanted from a log line, and `deleted_at` on a compound with
`reason = 'reap-compound'` plus its surviving provenance IS the
tombstone its M1.2 built out of the decline ledger. After this plan
lands, M1.2 drops the `reason` column on `samskara_tier2_declines`,
the group-key format, the distinct-on and the no-provenance path, and
the candidate finder's 90-day one-shared-id test reads dead compounds
with that reason from the base table. The verdict archive is
superseded. The compound plan is revised after this one converges.

## DECISIONS

- **Stamp, do not move.** No archive table, no trigger. The row
  stays, with its embedding; readers choose live or all.
- **A view, not a where-clause in 24 places.** Swapping a name is
  mechanical; inserting a predicate into 24 different CTE shapes is
  where a miss hides. The view also gives a future function a name
  that is safe by default.
- **Invoker security, no barrier.** For RLS parity and for predicate
  pushdown.
- **Explicit view columns.** Shape under control; the cost is one
  line per future column.
- **Judge fires of dead claims.** History wins; the evidence
  application already skips dead rows, so nothing is reinforced.
- **Cohort history shows dead claims as deleted, with the reason.**
  Mood pill stays live-only.
- **Drop the client delete policy.** No caller; keeps the invariant.
- **Replace the two indexes with partial twins** rather than adding
  two more; every hot path filters live, and the two base-table
  readers that do not are a thread-keyed diagnostic and a windowed
  count.
- **Deleted rows keep their embedding.** 700 rows a year, out of
  line; inspectable later; nothing to null.
- **No app-side guardrail test**, per the owner. One schema-side
  test, because that miss is silent.

## ACCEPTANCE CRITERIA

- Gate green: the schema test, the Deno accessor tests, the existing
  schema-grants and schema-dml-columns tests.
- Local stack, in a rollback transaction, against the CHANGED
  functions: every deleter leaves the row with a stamp and the right
  reason; fires, provenance and control verdicts of the stamped row
  are still present; `samskaras_live` does not return it; the fire
  query, the nearest-by-prediction dedup, the collapse pair
  enumeration, the tier-2 coverage set and the graduation tier all
  ignore it; the cap count equals the live count; a merge of an
  already-stamped loser is a no-op.
- The EXPLAIN check in the performance section.
- Prod, after deploy: `select count(*) from samskaras_live` equals
  the pre-deploy table count; the health panel's numbers are
  unchanged on the first read; within a day, stamped rows appear
  with reasons spread across the eviction tiers and the reapers; no
  fire-record FK errors; the cohort panel shows "deleted since fire"
  with a reason for a claim that fired and was later stamped.

## PREDICTED EFFECTS

No behavior change is intended. What does move:

- The judge sees one or two extra entries a day (fires of claims
  deleted since). Verdicts on fires of dead claims appear in
  `samskara_fires` for the first time.
- Tier-2 lift values dip slightly on deploy day as cohorts of
  dead-only fires stay in the denominator; no compound should cross
  the band because of it, check the candidate finder's output that
  week.
- `orphan_fires` on the panel changes meaning and starts counting
  up at the deletion rate.
- `samskara_rates` mint counts include later-deleted claims; the
  number will read a little higher than before for the same window.
- Base table grows about two rows a day.

Measure at day seven: the deleted-reason histogram (this is the first
time evictions are attributable), the live count against the cap,
the judge's batch sizes, and an EXPLAIN of the fire query on prod
(read-only) to confirm the partial index is used.

## VALIDATION

Before the change, run and log (QA rules: baseline first):
`samskara-cap-eviction.md`, `samskara-decay.md`,
`samskara-tier2-mint.md`, and the cohort-panel steps of whichever
use-case covers it. After the change, re-run and log. A new
`docs/qa/use-cases/samskara-soft-delete.md` covers: stamp through
each deleter, the live view, the history that survives, the cohort
label, and the EXPLAIN.

Docs in the same change: `docs/dev/samskara.md` (data model gains
the two columns and the view; "Decay" says every release path stamps;
the "who names what" rule); the audit skill's queries count the view
or filter `deleted_at`; `docs/user/samskara.md` (cohort label);
`docs/dev/planned-changes.md`.

## ACCEPTED RISKS

- **A future function reads the base table by habit.** The schema
  test catches it in the gate; the header comments say why.
- **PostgREST filtering on an embedded column** for the mood pill is
  standard but unverified here; if it does not work the pill reads
  the view through a second query. Marked unverified.
- **The old-edge-code window on deploy** over-counts the cap by at
  most the rows stamped in those minutes.
- **Explicit view columns drift from the table.** A new base column
  that a reader needs must be added to the view in the same change;
  the schema test does not catch a missing column, the function's
  own failure at apply time does (SQL-language functions) or at call
  time (plpgsql).

## REVISION LOG

- rev 1 (2026-10-23): draft from two read-only inventories (SQL:
  133 references in `schema.sql`, every function classified; app:
  ten direct reads, two embeds, no UI delete path, two-runtime
  accessor).
