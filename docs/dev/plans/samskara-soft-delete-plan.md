# Samskara soft-deletion

Status: DRAFT rev 3 (2026-10-23), after the deep-mode lens fan-out
(hidden problems, safe-to-modify, archaeology, alternatives) and one
fresh-context consensus round (no blockers). Lands
before M1.2 of
[the compound accountability plan](./samskara-compound-accountability-plan.md),
whose tombstone design it replaces. Revision log at the end.

Every `file:line` below was read against `supabase/schema.sql`
(17,484 lines) and the TypeScript tree in this session. A premise
that was not checked is marked unverified.

## SYNOPSIS

Claims (`public.samskaras`) are hard-deleted today, and three child
tables cascade with them: fires, provenance and control verdicts.
Every release path erases the record it was judged on, which is why
no tier comparison in the audits can be trusted. This plan renames
the table to `samskaras_all`, puts a live-rows view in its place
under the old name `samskaras`, and turns every delete into a stamp
(`deleted_at`, `deleted_reason`). Because the view keeps the old
name, every reader and writer in SQL, in the edge functions and in
the browser is live-only without an edit; only the five deleters,
three deliberate history readers and the table DDL name
`samskaras_all`.

## PROBLEM

- **Deleting a claim deletes its evidence.** `samskara_fires`,
  `samskara_provenance` and `samskara_control_verdicts` all reference
  `samskaras(id) on delete cascade` (`schema.sql:8010`, `7969`,
  `8153`). Tier-1 turns over at about two rows a day against a cap of
  150; tier-2 has never lost a row. So every tier-1 figure is a
  survivors' figure, and after the compound reap ships tier-2's will
  be too. The compound plan's PROBLEM section has the numbers. The
  record never states that history should vanish with the claim: the
  control-verdicts cascade was chosen to "share one lifecycle" with
  fires (`8147-8148`), the merge retargets fires "so cohort history
  is preserved" (`10164-10166`), and the browser fire queries were
  written as if fires outlive their claim
  (`src/lib/supabase/samskara.ts:197-203`, `262-265`). The fires and
  provenance cascades predate the git history available here
  (shallow clone from `dec57e55`); no reason for them is recoverable.
- **Dead children dangle.** Provenance rows that point at deleted
  parts survive only as ids (`ref_id` has no FK by design,
  "debugging beats normalisation", `7962-7964`), which is why the
  coverage test counts dead ids and the UI renders "(removed)" from a
  null join (`10912-10914`).
- **Evictions cannot be attributed after the fact.** The evictor
  returns a bare id (`9661-9662`, `9667-9775`) and nothing records
  which tier picked it; the compound plan infers graduation's 46
  slots from vanished parts.
- **Precedent.** The repo already soft-deletes memories below a search
  floor, "recoverable if the librarian later decides the
  consolidation was wrong" (`2379-2381`, `7194-7196`). The dev doc
  calls the graduation bar "a thin basis for an irreversible delete"
  (`docs/dev/samskara.md:1254-1255`).

## DESIGN

### Rename the table, give the view the old name

The alternative weighed in rev 1 (a view under a new name,
`samskaras_live`, and 24 SQL functions plus 10 app call sites
re-pointed at it) was dropped after review. Its cost was every
reader edited by hand, and its failure mode was a missed reader: the
lens pass found one in the plan's own list (the merge's counter fold
reads the loser from the base table, `10191`), and under that design
a future function that names the table by habit is wrong by default.

Under this design:

- the base table becomes `public.samskaras_all`;
- `public.samskaras` becomes a view: `select * from
  public.samskaras_all where deleted_at is null`, `with
  (security_invoker = true)`;
- nothing that names `samskaras` changes: the 24-odd SQL readers, the
  writers (`samskara_reinforce_existing` `10108`, the fire bookkeeping
  `8664-8672`, the evaluation update `9376-9385`, the embed claim and
  save `9199`, `9225`), the edge mint insert
  (`supabase/functions/venice/agents/samskara.ts:932-945`), the cap
  gate `tier1AtCap` (`1237-1241`), the compound-summary read
  (`1807-1813`), the judge's claim lookup and control sample
  (`samskara_evaluation.ts:501-504`, `364-368`), the intent reads
  (`intent.ts:392-395`, `512-517`), and the browser's two reads and
  two embeds (`src/lib/supabase/samskara.ts:373-377`, `440-447`,
  `204-210`, `250-256`).

A view with one base table, no aggregates and a plain `where` is
automatically updatable in Postgres: `insert`, `update`, `update ...
from`, `delete` and `returning` pass through to the base table, and
a row whose update makes it fail the view's predicate simply leaves
the view (no `with check option`). So the writers above keep working,
and they become live-only: an update through the view cannot touch a
stamped row (the row is re-checked against the view's predicate when
the update takes its lock), which closes the read-then-write race
the lens pass found in `samskara_apply_evaluation` and the embedding
save. Three statements use `update ... from` through the view and
one uses `select ... for update skip locked`: the embed claim at
`9199` (a `language sql` function, so it fails at apply time rather
than call time if the form is refused), the evaluation update at
`9376`, and the merge's fold at `10185-10191`. All are standard for
an automatically updatable view and **unverified** here until the
local-stack run; the fallback is to name `samskaras_all` with an
explicit `and deleted_at is null` in whichever statement is refused.

Invoker security keeps RLS parity: the base table's policies apply
to the caller, so the browser sees its own rows and the service role
sees everything. The schema already has one such view
(`grocery_products_view`, `4521-4545`) and pins Postgres 17
(`supabase/config.toml:36`; invoker views need 15). The grant block
at the end of the file (`17475-17477`) covers views, so no separate
grant is needed; the house pattern's own `grant select` on the
grocery view (`4566`) is not copied because that view is read-only
and this one takes writes.

### Columns and constraints

On `public.samskaras_all`, added with `add column if not exists`
(the `tests/schema-dml-columns.test.ts` scanner reads columns from
`alter table` too):

- `deleted_at timestamptz` - null for a living claim.
- `deleted_reason text` - null for a living claim; otherwise one of
  `evict-untested`, `evict-stale`, `evict-underperformer`,
  `evict-graduated`, `reap-dead`, `reap-probation`, `merge-loser`,
  and, once the compound plan ships, `reap-compound`. The values are
  NOT a check constraint: a named check inside an if-not-exists block
  cannot be extended on re-apply without drop-then-add, and the
  writers are internal code. The list lives in the column comment
  and the dev doc.
- One named check, `samskaras_all_deleted_consistency_check`,
  `(deleted_at is null) = (deleted_reason is null)`, added inside a
  guarded `do` block.

No backfill: every row that exists today is alive.

### Order of statements in schema.sql

The file applies start to finish in one transaction
(`scripts/lib/supabase.mjs:140` sends it as one query;
`scripts/dev-local.mjs:210` uses `psql -f`, which is not atomic and
only matters locally). SQL-language functions are validated when
created, and `samskara_fire_top_k` (`8507`, `language sql` at `8520`,
reference at `8539`) comes BEFORE the table's later column additions
at `9104-9109` and `9121-9122`. A view also blocks `alter column ...
type` on any column it uses. So the table's DDL is gathered and the
view is dropped before it and created after it:

1. A guarded rename: if `pg_class` has `public.samskaras` with
   `relkind = 'r'`, `alter table public.samskaras rename to
   samskaras_all`. On a fresh database this is a no-op and the next
   statement creates the table. A rename keeps the table's constraint
   names (`samskaras_pkey`, `samskaras_tier_check`,
   `samskaras_user_id_fkey`), and a fresh create would invent
   `samskaras_all_*` names, so the two databases would differ.
2. `create table if not exists public.samskaras_all (...)` - the
   existing definition at `7866-7908`, renamed, with its three
   constraints named explicitly (`constraint samskaras_pkey primary
   key`, `constraint samskaras_tier_check check (...)`, `constraint
   samskaras_user_id_fkey references ...`) so a fresh database matches
   prod name for name.
3. `drop view if exists public.samskaras` - so the DDL below can
   alter column types if a future change needs to (the int-to-real
   block at `7923-7931` is the precedent).
4. Everything that is DDL on the table today, renamed to
   `samskaras_all`: the indexes (see below), the int-to-real guard at
   `7923-7931` (its `information_schema` lookup names the table), RLS
   enable and policies at `7933-7949` (the delete policy is dropped,
   see below), the `user_id` default at `7957-7958`, the column
   additions moved up from `9104-9109` and the `drop not null` from
   `9121-9122`, and the new columns and check.
5. `create view public.samskaras with (security_invoker = true) as
   select * from public.samskaras_all where deleted_at is null`,
   with the header comment that states the naming rule. `select *`
   is right here, not an explicit list: Postgres freezes the column
   set at creation, and the file recreates the view on every apply
   after all the table DDL, so the view can never lag the table.
6. The provenance table at `7968` and everything after, unchanged
   except for name fixes listed under "Everything that names the
   table".

`tests/schema-grants.test.ts:90-105` requires every `create view`
above the single grant block; satisfied.

**Rollback is not "re-apply the old file".** The old file's `create
table if not exists public.samskaras` skips silently because the
name exists as a view, and its `create index if not exists
samskaras_user_tier_idx on public.samskaras` then errors because
that index name was dropped; the transaction rolls back and prod
stays on the new schema, with the deploy stuck. The reverse is a
short manual block, recorded in the dev doc: `drop view
public.samskaras; alter table public.samskaras_all rename to
samskaras;` and recreate the two old indexes. Stamped rows stay
stamped and invisible to nothing after that, so the reverse is only
for a broken apply, not a change of mind.

**Lock.** The rename takes an exclusive lock on the table at about
line 7866 and holds it until the whole one-transaction apply commits.
The current file already does that (`enable row level security`,
`alter column set default`), so this is not new; it is why a failed
apply blocks claim writes for the run's duration and nothing more.

The realtime guard at `14237-14244` (drop the table from the
publication if present) names `samskaras`; it is renamed to
`samskaras_all`. Publication membership follows a rename by
identity, so prod stays out of the publication either way.

### Indexes

`samskaras_user_tier_idx (user_id, tier)` at `7910-7911` and
`samskaras_user_health_idx` at `7913-7914` are replaced by partial
twins `where deleted_at is null` under NEW names
(`samskaras_all_live_user_tier_idx`, `samskaras_all_live_user_health_idx`)
preceded by `drop index if exists` on the old two. Same names would
be a silent no-op on prod (`create index if not exists` skips an
existing name and the old full index would survive). The base-table
readers that remain (below) look up by primary key or filter on
`created_at`, so they lose nothing.

### Performance: the filter runs before the math

The chat-turn matcher computes a cosine against every claim's
embedding (`samskara_fire_top_k`). The requirement is that dead rows
never reach that expression. A view that is not a security barrier
is inlined, so `deleted_at is null` becomes an ordinary scan qual on
`samskaras_all`, evaluated per row before the select list and the
order-by. The embedding is a 2048-float vector stored out of line and
is only fetched when an expression touches it, so a row the qual
rejects never de-TOASTs it. The partial indexes let index-driven
scans skip dead rows entirely. (A barrier view would still apply its
own predicate at the scan; what it blocks is pushing the OUTER
query's non-leakproof conditions down. Nothing here is a security
boundary, so no barrier.) No vector index exists or can: pgvector
caps HNSW at 2000 dimensions and the repo rule is "sequential scan is
plenty" (`1664-1668`, `7768-7774`).

Acceptance: `explain (analyze, buffers)` of the fire query on the
local stack with a few hundred stamped rows forged shows the filter
on the scan node and no more rows than the live count reaching the
sort. Marked **unverified** until that run.

Growth: about two stamped rows a day, roughly 700 a year, embeddings
included. Dead rows keep their embedding (the column is nullable,
`9121-9122`, but nothing nulls it) so a reaped claim stays
inspectable.

### Everything that names the table

The rule, stated in the header comment on `samskaras_all` and on the
view, and in `docs/dev/samskara.md`: **`samskaras` is the view and
is what you want. Name `samskaras_all` only to stamp a row, in DDL,
or because you deliberately want dead rows, and say why in a
comment.**

**Deleters (four today, a fifth when the compound plan ships; each
`update public.samskaras_all set deleted_at = now(), deleted_reason =
'<reason>' where ... and deleted_at is null`):**

- `samskara_reap_dead` (`9412-9434`, delete at `9426`) ->
  `reap-dead`. Its distinct-users loop at `9424` stays on `samskaras`
  (the view) and is therefore live-only with no edit.
- `samskara_reap_untested` (`9469-9486`, delete at `9476`) ->
  `reap-probation`.
- `samskara_evict_for_mint` (`9667-9775`, delete at `9773`) -> one
  of the four `evict-*` reasons; the function gains a local that
  records which tier selected the victim. **Its return type stays
  `uuid`**: the caller's gate is `if (evictErr || !evicted)`
  (`agents/samskara.ts:1268-1276`), and a set-returning or composite
  return would hand back `[]` or `{id: null}`, both truthy, so "no
  victim" would read as "evicted" and the probe would mint past the
  cap. The reason is on the row now, which is all attribution
  needs. The stamp uses `returning id`; if a reaper stamped the
  chosen victim first, zero rows return and the function returns
  null rather than reporting a victim it did not take. The four
  tier selects and the compound join at `9754` name `samskaras` and
  need no edit (a dead compound stops graduating its parts on its
  own).
- `_samskara_merge_pair` (`10139-10198`, delete at `10196`) ->
  `merge-loser`. It gains an early return when the loser or the
  winner is not in `samskaras` (the view), so the helper itself is a
  no-op on a stamped row even if two sweeps race past the caller's
  checks at `10340-10341` and `10387-10388`. The counter fold at
  `10191` (`from public.samskaras l`) is then live-only on its own.
  The comment at `10173-10175` ("loser's remaining provenance
  cascade-deletes") becomes false and is rewritten: the loser keeps
  its own provenance copy and its control verdicts. Note what the
  merge still destroys: it hard-deletes the loser's fires in cohorts
  the winner shares (`10153-10164`, to avoid self-co-firing under
  the unique constraint) and retargets the rest (`10169-10171`), so
  no fire stays on the dead loser and the colliding fires' verdicts
  are lost. That is the one evidence loss this plan leaves in place;
  the winner's own verdict in the same cohort survives.
- The compound plan's `samskara_reap_compounds` -> `reap-compound`.

**Deliberate base-table readers (each gets a comment saying why):**

- `samskara_cluster_thread_fires` `8765`, `8793`: the thread
  diagnostics modal lists every fire in a thread; a dead claim keeps
  its embedding and clusters normally instead of falling into the
  orphan-singleton path at `8777-8785`.
- `samskara_rates` `11203`: mint throughput counts claims later
  deleted.
- `samskara_health_snapshot` `orphan_fires` (`11154-11158`): a true
  orphan check, "fires whose claim row does not exist", a "merge or
  delete bug smell" (`10990-10991`) with panel bars at 1 and 5
  (`src/lib/ui/samskara-health.ts:39`). It names `samskaras_all` so
  it keeps meaning what the panel thinks it means and reads 0.
  (Rev 1 redefined it as "fires of dead claims"; that would have put
  the panel in alarm within days.)

**DDL and guards that name the table by necessity:** the rename
block, the create table, the three child-table FKs
(`references public.samskaras_all(id)` at `7969`, `8010`, `8153`),
the int-to-real guard, the policies, the index statements and the
realtime guard. The three one-time repair blocks at `9146-9174`,
`9814-9832`, `9843-9858` keep naming `samskaras` and so write through
the view to live rows only, which is what they should do: the
reconcile block (`9850-9853`) would otherwise rewrite every dead
row's health-at-death on every deploy.

**Functions that never touch the table:** `samskara_verdict_counts`,
`samskara_expire_unjudgeable_fires`, `samskara_sweep_users`,
`samskara_associate`, `samskara_association_cluster`.

### Child tables keep their rows: what changes meaning

- **Fires of a claim stamped after it fired are not judged.** The
  judge looks fired claims up through `samskaras`
  (`samskara_evaluation.ts:501-504`), so a dead claim's fires drop
  out of the batch, as they do today. Rev 1 wanted them judged for
  completeness; the lens pass showed the judge re-rules every claim
  that ever fired in a thread on every settle (`465-468`), so dead
  entries would ride along forever and grow long threads' batches
  without bound. The pending fires of a dead claim are stamped by
  clause (2) of the expiry function (`9589-9590`) as today. What is
  lost: verdicts for the one or two fires a day that were pending
  when their claim died. Accepted.
- **The control sample stays live** (`364-368`, through the view).
- **Collapse and tier-2 detection** join fires to `samskaras` and so
  exclude dead claims' fires from pair enumeration (`10315-10316`,
  `10606-10607`); the existence checks at `10340-10341` and
  `10387-10388` and the tier-2 coverage join at `10630` are live-only
  the same way, so a dead compound stops covering its region, which
  cascade used to do for free. The collapse's self-join on
  `samskara_fires` (`10297-10303`) runs before that filter and now
  carries dead claims' fires in its input; at two deletions a day
  that is a slow growth on the table whose autovacuum is already
  tuned (`8021-8035`). Recorded in PREDICTED EFFECTS.
- The tier-2 lift denominator `v_cohorts` (`10556-10558`) counts
  cohorts and keeps cohorts in which only dead claims fired; that
  counts turns, which is the intended denominator, and shifts lift
  slightly downward on deploy day.
- **Eviction and probation guards** keyed on an already-chosen live
  id (`9481`, `9682-9714`, `9762`; snapshot `11059-11084`, `11115`)
  need nothing.
- **The browser's two embeds through the fires table** (`204-210`,
  `250-256`) now embed the view. PostgREST infers a view's
  relationships from its base table's foreign keys, so
  `samskaras!inner(...)` keeps working and drops dead claims (mood
  pill), and the plain embed returns null for a dead claim, which
  `CohortPanel.svelte:221-222` already renders as "samskara deleted
  since fire". That branch has been unreachable under cascade; it
  becomes live. No browser code changes. The comment at
  `types/samskara.ts:156-157` is corrected. A "deleted: reason"
  display is a later nicety, not this plan. PostgREST embedding
  through a view is **unverified** here; the mood-pill filter on an
  embedded column (`.not('samskaras.valence', 'is', null)`, `207`)
  shows embed filtering works, and the local-stack run covers the
  view case.
- **A fire landing on a dead claim.** `samskara_record_fires` inserts
  the cohort in one statement from `jsonb_array_elements(p_fires)`
  alone, with no join to the claims table (`8652-8662`); today the
  FK rejects the whole cohort if any claim was deleted mid-turn.
  After the change the FK (on `samskaras_all`) would accept it. So
  this function IS edited: the insert joins `samskaras` on id and
  `user_id = p_user_id` (the function runs as service role, which the
  view hides nothing from, so the user filter must be explicit), and
  a stamped id is dropped while the rest of the cohort records. The
  bookkeeping update at `8664-8672` goes through the view and needs
  nothing. A stamp that commits after the statement's snapshot can
  still land one fire on a dead claim; the judge ignores it and the
  expiry stamps it. Accepted.
- **Two readers disagree about a dead claim, cosmetically.** The
  thread diagnostics modal reads the base table and clusters a dead
  claim normally, while the cohort list embeds the view and labels
  the same claim "deleted since fire" with no text. Both are
  diagnostics; stated here so nobody files it as a bug.
- **History is complete except through two paths**: the merge's
  colliding-fire delete above, and thread deletion, which cascades
  fires and control verdicts by `thread_id` (`8011`, `8152`;
  `src/lib/supabase/threads.ts:760-779`). Both are stated in the dev
  doc.

### The RLS delete policy

`"samskaras self-deletable"` at `7947-7949` lets a signed-in client
hard-delete its own claims. No UI or facade path uses it
(`SamskaraBrowseList.svelte:9` says read-only by design;
`src/lib/supabase.ts:1648-1751` exposes no delete; the dev doc records
the stance, `samskara.md:2169-2171`). It is dropped. The update policy
stays, so a client could in principle write `deleted_at` back to
null; there is no client path and the invariant is "no client path",
not "impossible".

### No accessor module

Rev 1 proposed a data module per runtime to centralize the ten app
call sites. Under the rename those sites are correct as written and
the name `samskaras` is safe by default, so a module would be a
refactor with no behavior to carry. Instead: the header comment on
the view and on `samskaras_all` state the rule; `docs/dev/samskara.md`
gets a "Soft deletion" section written to be found by grep; and
`src/lib/supabase/samskara.ts`, which already is the browser's data
module for this feature, gets a module-level note. The one place an
edge function should name `samskaras_all` is none today.

### The one guard: a schema test

`tests/schema-live-view.test.ts`, modelled on
`tests/ordering-guardrail.test.ts` (walks sources, matches, reports
`file:line`, pins known counts so the scan cannot go blind). It
splits `schema.sql` into statements and dollar-quoted bodies
(`$$`, `$q$`, `$job$`, `$fn$`, `$repair$`, `$reconcile$` and the
rest) and asserts:

- with comments and string literals stripped, every identifier in a
  table position (after `from`, `join`, `update`, `into`, `table`,
  `on`, `references`) that starts with `samskaras` is exactly
  `samskaras` or `samskaras_all` (a typo like `samskara_live` would
  otherwise pass silently and fail only at call time in plpgsql).
  Index names, constraint names, policy names and the realtime topic
  literal `'samskaras:'` are not in table position and are not
  checked;
- every body or statement naming `samskaras_all` in table position
  is in the allowlist (the rename block, the create table, the index
  and policy and guard statements, the child-table FKs, the four
  deleters, the three history readers);
- the view is created after the last `alter table
  public.samskaras_all` and before the first `language sql` function
  that names `samskaras`;
- the counts of each class are pinned (deleters: 4 until the
  compound plan lands).

`tests/schema-dml-columns.test.ts:225-236` fails on DML whose target
is not a `create table` name; writes through the view are exactly
that. The test learns that a view defined as `select * from X`
resolves to X's columns. One trap: the rename statement `alter table
public.samskaras rename ...` matches the scanner's `alter table`
regex and registers `samskaras` as a known table with no columns, so
the view mapping must overwrite that entry rather than merge into
it, or every update through the view fails the test.

### Deploy

The deploy applies the schema (`.github/workflows/deploy.yml:59`)
before it deploys the edge functions (`:79`), and the browser build
after that. Because the view keeps the name, old edge code and old
cached PWA clients are live-only from the moment the schema commits;
there is no window in which the cap over-counts or the corpus browse
lists dead rows. The remaining gap is PostgREST's schema cache: it
reloads on DDL, and until it does, requests that embed through
`samskaras` may use the cached table relationship. PostgREST builds
its SQL by name, so those requests should still resolve against the
view; **unverified**. The two embeds that could notice both swallow
errors into "no mood pill" and "no fire list" for that request.

If the edge deploy step fails after the schema step succeeds, old edge
code keeps running against the new schema; under this design that is
correct behavior, not a degraded one.

### Attribution, for the compound plan

`deleted_reason` is the eviction attribution the compound plan's M1.3
wanted from a log line, and a compound row with `deleted_reason =
'reap-compound'` plus its surviving provenance IS the tombstone its
M1.2 built out of the decline ledger. After this plan lands, M1.2
drops the `reason` column on `samskara_tier2_declines`, the group-key
format, the distinct-on and the no-provenance path; the candidate
finder's 90-day one-shared-id test reads `samskaras_all` for dead
compounds with that reason; and M1.3's evictor return-type change is
withdrawn. The verdict archive is superseded. The compound plan is
revised after this one converges.

## DECISIONS

- **Stamp, do not move.** No archive table, no trigger. The row
  stays, with its embedding; readers choose the view or the table.
- **The view takes the old name.** Every reader and writer is
  live-only by default, now and for every future function. The cost
  is about twenty DDL lines renamed, one schema test taught about
  views, and a name that means "view" in bodies and "nothing" in DDL,
  which the header comments carry.
- **Invoker security, no barrier, `select *`, drop-then-create each
  apply**, with the drop placed before the table DDL so column type
  changes stay possible.
- **Evictor keeps returning `uuid`.** The caller's null gate depends
  on it; the reason lives on the row.
- **Fires of dead claims are not judged.** Re-judging whole threads
  would carry dead entries forever.
- **Cohort history shows a dead claim as deleted; mood pill stays
  live.** Both fall out of embedding the view; no UI change.
- **Drop the client delete policy.** No caller; the merge and the
  reapers stamp through updates the update policy already covers.
- **Partial indexes under new names**, old ones dropped by name.
- **No reason check constraint.** Internal writers; a list in a
  comment; extensible without a drop-then-add dance.
- **No accessor module.** Nothing to carry under the rename.
- **One schema-side test, no app-side test**, per the owner.
- **Keep the three FKs on cascade.** A hard delete should still take
  its children, so leftover QA cleanup SQL and a future admin delete
  behave as today; the point of the plan is that production code no
  longer hard-deletes.

## ACCEPTANCE CRITERIA

- Gate green: the new schema test, the two existing schema tests
  (grants; DML columns with the view mapping), the Deno suite (the
  fake client in `supabase/functions/tests/samskara.test.ts:250-268`
  keys on `'samskaras'`, which is still what `insertMint` names).
- Local stack, in a rollback transaction, against the CHANGED
  functions: each deleter leaves the row in `samskaras_all` with a
  stamp and the right reason; its fires, provenance and control
  verdicts are still present; `samskaras` does not return it; the
  fire query, the dedup nearest-neighbor, the collapse pair
  enumeration, the tier-2 coverage set and the graduation tier all
  ignore it; the cap count equals the live count; `insert ...
  returning id` and `update ... from` through the view work (or the
  fallback named above is applied); `_samskara_merge_pair` on a
  stamped loser returns without touching fires, provenance or the
  winner's counters; the evictor returns null when its chosen victim
  was stamped first.
- The EXPLAIN check in the performance section.
- A fresh local database built from the changed file has the same
  schema as prod after the deploy (`pg_dump --schema-only` diff,
  ignoring ownership). This is the test that the rename-or-create
  ordering is right for both the existing database and a fresh one.
- Prod, after deploy: `select count(*) from samskaras` equals the
  pre-deploy table count; the health panel's numbers are unchanged
  on the first read; within a day, stamped rows appear with reasons
  spread across the eviction tiers and the reapers; no fire-record
  errors in the function log; the cohort panel shows "deleted since
  fire" for a claim that fired and was later stamped.

## PREDICTED EFFECTS

No behavior change is intended. What does move:

- Tier-2 lift values dip slightly on deploy day as cohorts of
  dead-only fires stay in the denominator; no compound should cross
  the band because of it; check the candidate finder's output that
  week.
- `samskara_rates` counts fires, resolutions and the verdict mix from
  `samskara_fires` (`11195-11215`); these now include fires of claims
  deleted inside the window, where before they vanished with the
  claim. `fires_total` on the snapshot (`11145-11146`) climbs where
  it used to drop. The mint count includes later-deleted claims.
- The collapse's fires self-join input grows by dead claims' fires,
  about two claims' worth a day.
- `samskaras_all` grows about two rows a day. `samskaras` (the view)
  holds steady at the cap.
- On a future embedding-model rotation the repair block nulls
  bad-shape vectors through the view, so dead rows keep vectors of
  the old shape; `samskara_cluster_thread_fires` then treats them as
  orphan singletons (`8777-8785`). Cosmetic, in a diagnostic.

Measure at day seven: the `deleted_reason` histogram (the first time
evictions are attributable), the live count against the cap, and an
EXPLAIN of the fire query on prod (read-only) to confirm the partial
index is used.

## VALIDATION

Before the change, run and log (QA rules: baseline first):
`samskara-cap-eviction.md` (its queries at `:53` and `:62` go through
`samskaras` and keep meaning "live"), `samskara-decay.md` (`:75-104`
likewise; its step at `:106` expects a reaped row to be absent from
`samskaras`, which stays true, and gains a second check that the
row is present in `samskaras_all` with a stamp),
`samskara-tier2-mint.md`, and the cohort-panel steps of the use-case
that covers the diagnostics modal. After the change, re-run and log.
QA count queries that name `samskaras`
(`samskara-association-mint.md:74`, `samskara-tier2-mint.md:76`,
`samskara-formation.md:35`, `intent-mint-pipeline.md:40`) still mean
"live" through the view and need no edit. QA cleanup steps that
hard-delete (`samskara-association-mint.md:138`,
`samskara-tier2-mint.md:217`) still work through the cascade and
gain a note that they bypass the stamp.

A new `docs/qa/use-cases/samskara-soft-delete.md` covers: stamp
through each deleter, the view, the history that survives, the
cohort label, the schema-dump diff, and the EXPLAIN.

Docs in the same change: `docs/dev/samskara.md` (data model gains
the rename, the two columns and the view; "Decay" says every release
path stamps; a "Soft deletion" section with the naming rule and the
two remaining evidence-loss paths; the control-verdict "same
lifecycle" sentence at `544-545` and the schema comment at
`8147-8148` rewritten); the audit skill's queries say which name they
count; `docs/dev/planned-changes.md`; `docs/user/samskara.md` only if
the cohort label is considered new (it is existing copy that becomes
reachable; one sentence).

## ACCEPTED RISKS

- **A future function names `samskaras_all` by habit.** The schema
  test's allowlist catches it in the gate; the header comments say
  why.
- **`update ... from` and `insert ... returning` through the view**
  are standard for automatically updatable views but unverified
  here; the fallback is to name `samskaras_all` with an explicit
  predicate in the two places that use them.
- **PostgREST embedding through the view and its schema-cache
  reload** are unverified here; the two embeds that depend on them
  swallow errors for the affected request.
- **A client can un-stamp** through the update policy. No client
  path exists.
- **The merge still deletes colliding fires**, and thread deletion
  still cascades fires and control verdicts. Stated in the dev doc.
- **One or two fires a day lose their verdict** when their claim is
  stamped before the judge runs.
- **`samskaras_all` is reachable through the Data API** for a signed-
  in user, owner-scoped by the same RLS, dead rows included. No
  client names it; a later diagnostics surface may want to.
- **The judge's id list grows** on long threads, because fired ids
  now include dead claims; bounded by the distinct claims that ever
  fired in the thread.

## REVISION LOG

- rev 1 (2026-10-23): draft from two read-only inventories (SQL:
  131 code references in `schema.sql`, every function classified;
  app: ten direct reads, two embeds, no UI delete path).
- rev 2 (2026-10-23): after the lens fan-out. Design changed from a
  new-name view with 34 edited call sites to the view taking the old
  name over a renamed table; accessor modules withdrawn; evictor
  return type kept as `uuid` (a set or composite return would read
  "no victim" as truthy and mint past the cap); `orphan_fires` kept
  as a true-orphan check against the base table (the redefinition
  would have held the panel in alarm); merge helper gains its own
  liveness guard (its fold read the loser from the base table, a
  site rev 1 missed); fires of dead claims no longer judged (the
  judge re-rules whole threads on every settle); partial indexes
  under new names; no reason check constraint; view dropped before
  the table DDL and created after it, `select *`; DML-columns test
  taught about views; schema-dump diff added as acceptance; rates
  and fires_total meaning changes, the collapse join growth, the
  thread-deletion cascade and the merge's colliding-fire delete
  recorded; QA docs that count the table enumerated; rev 1's wrong
  sentence about fires staying on a merged loser removed.
