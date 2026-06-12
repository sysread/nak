# Samskara Association-Mint Implementation Plan

Status: LANDED. The consumer side of the associative layer -
minting tier-1 samskaras from the association graph pair-relate
writes - is implemented (`mintTier1FromAssociationsProbe` +
`samskara_association_cluster`). The living reference is
`docs/dev/samskara.md` (associations table, the Mint-tier1-assoc
phase, the provenance and gotchas sections); the walkthrough is
`docs/qa/use-cases/samskara-association-mint.md`. This doc is kept
as the design rationale of record. One plan item shipped as
written with a deliberate divergence worth noting: the consumption
stamp is set on a successful INSERT (id returned), not
unconditionally after the mint decision, so a failed insert leaves
the edges unconsumed to retry - see the agent code + gotchas.

## SYNOPSIS

Pair-relate adjudicates substrate pairs and writes
`samskara_associations` rows - now with working reinforcement
increments and a declined-pair ledger - but **nothing downstream
reads them**. Mint-tier1 still clusters by recency + cosine alone;
`'association'` provenance is never written; the minter's
`sample_labels` input has been an empty array since v1. This plan
adds an association-seeded mint probe to the hourly sweep, a
consumption ledger so the probe self-quenches, `'association'`
provenance on the mints it produces, and drops the never-populated
`relation_embedding` column.

## PURPOSE

The associative layer is currently a fully-built producer with no
consumer. Every accepted pair burns a relator LLM call to produce a
typed, labeled, reinforcement-weighted edge between two substrate
rows - and the only live reader is a `count(*)` in the Health
snapshot. Three concrete losses:

- **Cross-session patterns never mint.** `buildTopicalCluster` sees
  only the `MINT_WINDOW` (8) most-recent substrate rows, so it can
  only mint "what just happened." A tendency that recurs across
  weeks - one observation per session, never two in the same
  window - is exactly what associations capture (pair-relate's
  window is 40 rows and its edges are permanent), and exactly what
  the recency cluster structurally cannot see.
- **Relator work is discarded.** An accepted edge is a semantic
  judgment ("these two observations exhibit the same tendency:
  <label>") that is strictly stronger evidence than raw cosine. The
  minter never sees it; it re-derives relational insight from raw
  situations or fails to.
- **The audit trail has a hole.** The provenance system supports
  `kind='association'` end-to-end (check constraint, detail-RPC
  join, UI heading) and no code has ever written one.

## Why association-mint is NOT redundant with recency-mint

Same shape of argument as the tier-2 plan's "why tier-2 is not
dedup": the two cluster sources answer different questions.

- **Recency cluster** (turn-tail + sweep, unchanged): "did the last
  few rounds cohere into a topic?" Fast, zero graph dependency,
  catches within-session bursts while they are hot.
- **Association cluster** (sweep only, new): "has the relator
  accumulated enough adjudicated evidence around one observation to
  support a claim?" Slow, cross-session, catches recurrence the
  recency window can never co-locate.

A pair of observations three weeks apart can never share a recency
window, but pair-relate links them the day the second one lands.
Conversely, a five-row burst about tonight's dinner mints from
recency long before the relator gets around to it. Both paths feed
the same dedup guard, so a pattern both can see still produces one
samskara.

## DESCRIPTION

### Layer 1 - how the relevant code behaves today

All in `supabase/functions/venice/agents/samskara.ts` plus
`supabase/schema.sql` unless noted.

- **Pair-relate probe** (`pairRelateProbe`): seeds on the
  most-recent embedded substrate row, ranks partners best-cosine
  first (floor 0.3) across a 40-row window, skips pairs already
  adjudicated (accepts in `samskara_associations`, declines in
  `samskara_pair_declines`), asks the relator once, persists the
  verdict. Accepts go through the `samskara_associate` RPC whose
  `ON CONFLICT` increments `reinforcement`. A fully-adjudicated
  window spends no LLM call.
- **`samskara_associations`**: `(a_id, b_id)` canonical-ordered
  substrate pairs with `articulated_relation` (one-line label),
  `kind in (pattern, contrast, prerequisite, consequence)`,
  `reinforcement`, `last_reinforced_at`. Plus `relation_embedding
  vector(2048)` - reserved at design time for label-level
  clustering, never populated by anything.
- **Mint-tier1 probe** (`mintTier1Probe`): `buildTopicalCluster`
  over the 8 most-recent rows (seed + cosine >= 0.6 neighbours,
  3..5 rows), minter call with `{sample_labels: [],
  sample_situations, reinforcement: rowCount}` - `sample_labels`
  is **always empty**; it is the input slot associations were
  meant to fill - then embed, dedup-guard (cosine >= 0.85 ->
  `samskara_reinforce_existing`, health bump only), and
  `insertMint` with `'substrate'` provenance.
- **`insertMint`**: writes the samskara row + a provenance batch;
  its provenance type union is `'substrate' | 'samskara'`.
- **Drivers**: `samskaraOnTurnTail` runs assimilate-drain ->
  pair-relate -> mint-tier1. `runSamskaraSweepTick` (hourly cron)
  runs the same plus mint-tier2.
- **UI**: `samskara_provenance_detail` already left-joins
  associations to render `articulated_relation` as the label;
  `Samskaras.svelte`'s `provenanceHeading` keys the section
  heading off `provenance[0].kind` (rows ordered by weight desc) -
  which has been safe so far only because no samskara has ever had
  mixed-kind provenance.

### Layer 2 - what this plan changes

#### 2a. Schema: consumption ledger + RPC + column drop

- **`minted_at timestamptz` on `samskara_associations`**
  (nullable, `alter table ... add column if not exists`). The
  consumption stamp: an edge with `minted_at` set has been fed to
  the minter and is permanently out of the candidate pool. Stamped
  on **every minter adjudication** - fresh mint, dedup-hit, and
  decline alike (see Gotchas for why decline must stamp). New
  evidence re-opens a pattern as new *edges*, which arrive
  unconsumed; the stamp is per-edge, never per-hub.
- **Drop `relation_embedding`** (`alter table ... drop column if
  exists`, idempotent). Never populated, never read, and hub-based
  selection below does not need it. Re-adding is one guarded ALTER
  if label-level clustering ever materializes; carrying a dead
  vector column "in case" is the same pathology this plan exists
  to fix. Update the table comment.
- **New RPC `samskara_association_cluster(p_user_id uuid)`**:
  selects the hub - the substrate row with the greatest
  `sum(reinforcement)` over its **unconsumed** edges, requiring
  at least 2 distinct partners (hub + 2 partners satisfies
  `MINT_CLUSTER_MIN = 3` member rows) - and returns that hub's
  unconsumed edges, best-reinforcement first, capped at
  `MINT_CLUSTER_MAX - 1` (4) edges: `(association_id, label, kind,
  reinforcement, hub_id, hub_situation, partner_id,
  partner_situation)`. Two edges to the same partner (different
  labels) are legal and yield one member row with two labels.
  `security definer`, `service_role`-only grants, same shape as
  `samskara_associate`. Returns zero rows when no hub qualifies -
  the probe's quench condition.

#### 2b. Agent: `mintTier1FromAssociationsProbe` (sweep only)

New probe in `samskara.ts`, mirroring `mintTier1Probe`'s skeleton:

1. Call `samskara_association_cluster`. Empty -> trace log, return
   (zero Venice spend - the self-quenching property).
2. Assemble the cluster: members = hub + distinct partners
   (situations -> `sample_situations`), labels = the edge
   `articulated_relation` strings -> **`sample_labels`, non-empty
   for the first time**, `reinforcement` = sum of edge
   reinforcement.
3. `agentMint` with the same `MINTER_PROMPT` (one added sentence,
   2c). Then, in **every** adjudicated outcome - minted,
   dedup-reinforced, or declined - stamp the fed edges:
   `update samskara_associations set minted_at = now() where id =
   any(edgeIds)` (direct service-role update, the documented
   pattern for non-conflict writes). A transport/parse failure
   (`agentMint` -> null vs an explicit decline) must NOT stamp -
   mirror pair-relate's null-result handling so a flaky call
   retries next sweep.
4. On mint: embed, run the same dedup guard, and `insertMint` with
   provenance = member rows as `'substrate'` weight 1.0 plus the
   consumed edges as `'association'` with `weight =
   reinforcement` (snapshot at consumption time). `insertMint`'s
   type union gains `'association'`.

Wire into `runSamskaraSweepTick` only, between mint-tier1 and
mint-tier2 (phase label `mint-tier1-assoc`). The turn-tail stays
untouched: cross-session consolidation is not latency-sensitive,
and this keeps per-turn Venice spend flat. Worst-case added spend
is one minter call + one embed per user per sweep hour, only while
unconsumed evidence exists.

`agentMint`'s `confirm:false` handling needs one refinement: the
probe must distinguish "explicit decline" (stamp) from "call
failed" (no stamp). Today `agentMint` returns null for both; split
the return (e.g. `MintResult | 'declined' | null`) so the caller
can tell.

#### 2c. Minter prompt: explain `sample_labels`

One added paragraph to `MINTER_PROMPT`: when `sample_labels` is
non-empty, each entry is a relation a prior analysis articulated
between two of the observations - treat them as pre-digested
insight about what ties the cluster together, not as user quotes.
Harmless for the recency path, which keeps sending `[]`.

#### 2d. UI: mixed-kind provenance

Association-minted samskaras are the first rows with mixed-kind
provenance (`'substrate'` + `'association'`), and the detail RPC
orders by weight desc - an edge with reinforcement > 1 outranks
substrate weight 1.0, so `provenanceHeading(provenance[0].kind)`
would mislabel the whole section "Related observations". Fix in
`Samskaras.svelte` + `src/lib/ui/` per the frontend split: group
provenance rows by kind and render one headed group per kind
present (substrate group under "Formed from (substrate)",
association group under "Related observations", samskara group
unchanged). The grouping walk is a pure primitive ->
`src/lib/ui/samskara-browse.ts` (or a sibling), vitest-covered.

#### 2e. Observability

`samskara_health_snapshot` gains an `associations_unconsumed`
count next to the existing `associations` total, and the Health
panel renders it as an informational line (NOT severity-bearing -
a standing pile means "evidence awaiting the next sweep", which is
normal between crons). A new pipeline stage with zero
observability is how the original silent failures happened.

### Layer 3 - how this closes PURPOSE

The relator's edges become minting evidence: cross-session
recurrence reaches the minter through the association graph
instead of being structurally invisible to the recency window; the
labels ride in through the input slot designed for them; the mints
they produce carry `'association'` provenance, lighting up the
join and UI affordances that have waited unused. The consumption
stamp makes the whole loop self-quenching, so a quiet graph costs
zero Venice calls - the same property pair-relate just gained.

## Interactions (deltas vs samskara.md)

- **Sweep cron**: one more phase per user tick, bounded at one
  minter + one embed call, quenching to zero.
- **Dedup guard / `samskara_reinforce_existing`**: unchanged and
  shared; an association-derived claim that re-words an existing
  samskara health-bumps it, same as recency mints. Reinforce still
  never writes provenance.
- **Provenance detail RPC**: no SQL change (the association join
  exists); the UI grouping in 2d is presentation-only.
- **Tier-2**: unaffected. Association-minted tier-1s participate
  in co-firing and tier-2 candidacy like any tier-1.
- **Pair-relate**: unchanged, but its output finally matters;
  reinforcement values now influence hub selection and provenance
  weights.

## Gotchas to bake in (and into samskara.md when this lands)

- **Stamp on decline or loop forever.** Without stamping declined
  edges, a stable graph re-feeds the same hub every sweep and
  burns a minter call per hour re-asking an unchanged question -
  the exact pathology the pair-declines ledger just fixed, one
  level up. Decline consumes the *current* evidence; future edges
  to the same hub arrive unconsumed and re-qualify it. That is the
  designed re-open mechanism, not a loophole.
- **Never stamp on transport failure.** A null from a failed call
  is not a verdict; stamping it would silently discard evidence.
  Requires the 2b return-type split - without it the probe cannot
  tell the cases apart.
- **Consumed is permanent per edge.** Re-reinforcement of an
  already-consumed edge (pair-relate re-encountering the pair)
  bumps `reinforcement` but does not re-trigger minting. Known
  limitation: corroboration of an already-minted pattern reaches
  health only if a fresh mint attempt happens to dedup onto it.
  TODO-shaped problem, not prescribed here: re-reinforcement
  signal currently has no path back to the existing samskara's
  health.
- **Mixed-pattern hubs exist.** A hub's edges can span genuinely
  different tendencies (the same observation relating to a baking
  pattern and a family pattern). v1 feeds them all and leans on
  the minter's `confirm:false` guard; decline-stamps guarantee no
  loop. The future problem this leaves open: grouping a hub's
  edges by what the *labels* say (which is what
  `relation_embedding` was reserved for) rather than feeding the
  hub's whole neighbourhood.
- **Association provenance weight is a snapshot.** `weight =
  reinforcement` at consumption time; later reinforcement does not
  retro-update provenance. The audit trail describes formation,
  not live state.
- **Heading regression risk in the detail view.** Any future
  provenance kind addition must extend the 2d grouping, not the
  old first-row heuristic.

## Testing

- **Deno (`supabase/functions/tests/samskara.test.ts`)**: cluster
  assembly from RPC rows (member dedup when two edges share a
  partner, label collection, reinforcement sum), the
  decline-vs-failure stamping split, and the probe's empty-RPC
  early return. Export the new pure helpers through the existing
  `__test`-style surface the file already uses.
- **Vitest**: the provenance-grouping primitive (2d).
- **QA (`docs/qa/use-cases/`)**: new walkthrough
  `samskara-association-mint.md` - seed substrate, drive
  pair-relate to accepted edges, run the sweep, verify the mint,
  its mixed provenance in the UI, the `minted_at` stamps, and the
  quench (second sweep spends no call). Baseline the existing
  `samskara-formation.md` flow pre-change per the backfill-first
  rule, since this touches the shared mint path (prompt + insert
  union).
- **Live SQL spot-checks post-deploy** (read-only): unconsumed
  edge counts draining across sweeps; `'association'` provenance
  rows appearing; no stamp on rows whose probe logged a transport
  failure.

## Sequencing (single PR, ordered within)

1. Schema: `minted_at`, drop `relation_embedding`, the cluster
   RPC + grants, health-snapshot field. All idempotent.
2. Agent: return-type split in `agentMint`, the new probe, sweep
   wiring, prompt paragraph, `insertMint` union.
3. UI: provenance grouping primitive + panel; health line.
4. Docs + QA: samskara.md sections (associations table, mint
   phases, gotchas - retire the "write-only producer" framing),
   user doc one-line note that a samskara's detail can list the
   relations it formed from, new QA use case + baseline runs.
