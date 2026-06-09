# Samskara Tier-2 Implementation Plan

Status: proposal. Nothing here is built yet. The tier-2 phase has
been a stub since v1 (`runMintTier2Phase` returns `'empty-phase'`);
this plan turns it into a real phase.

Read [`../samskara.md`](../samskara.md) first - this plan assumes its
data model and worker-phase vocabulary.

## SYNOPSIS

Mint tier-2 (compound) samskaras from recurring co-fire groups of
tier-1 samskaras. A tier-2 is a "samskara-of-samskaras": when a
constellation of distinct tier-1 claims reliably activates together
across many turns, compress that constellation into one higher-order
predictive claim. Detection is a new SQL RPC over the co-fire
self-join; synthesis is a new fast-model agent method; the existing
`runMintTier2Phase` wires them together exactly as `runMintTier1Phase`
wires substrate clustering to the minter agent.

## PURPOSE

Currently the formation worker only ever produces tier-1 samskaras -
flat, one-per-substrate-cluster predictive claims. As the tier-1 pool
grows, recurring *patterns across* tier-1 claims go uncaptured. The
user has, say, three distinct tier-1 samskaras - "pushes back on
flowery prose", "wants code without preamble", "corrects
over-explanation" - that are individually true but that, together,
encode a single higher-order disposition (terseness in technical
contexts). Today nothing names that disposition. The priming block
sees three sibling bullets; it never sees the compound.

Tier-2 is the missing compression layer. It does NOT replace its
children - they stay live and fire individually - it adds a parent
claim that fires when the constellation's situation recurs, giving the
chat model a single strong signal instead of three weak ones that may
not all clear the priming token budget on a given turn.

Bad outcomes this prevents:

- the long tail of correlated tier-1 claims never consolidating into
  the kind of stable, high-confidence read that belongs in the
  always-on compound summary;
- priming-budget starvation, where three correlated tier-1 bullets
  compete for the same budget slot that one tier-2 parent would
  occupy more efficiently.

## Why tier-2 is NOT dedup

This is the single most important distinction and the easiest thing
to get wrong. The existing `samskara_collapse_by_cofiring` dedup phase
ALSO works off the co-fire self-join, so the two look superficially
identical. They are opposites in intent:

- **Dedup** merges pairs that are *functionally the same claim* -
  high co-fire ratio AND high embedding cosine (>= 0.70 floor). One
  IS the other; the loser is deleted. Output: a smaller pool.
- **Tier-2** groups claims that *co-activate but stay distinct* -
  high co-fire frequency but embedding cosine BELOW the dedup floor
  (they are related, not duplicate). Nothing is deleted; a new parent
  row is added. Output: a richer pool with a hierarchy.

The cosine band is the seam. Dedup claims the high-cosine pairs;
tier-2 claims the mid-cosine co-firing groups that dedup deliberately
leaves alone. If tier-2's detection floor ever overlaps dedup's
floor, the two phases will fight over the same pairs - dedup deleting
what tier-2 just grouped. Keep tier-2's cosine window strictly below
dedup's `p_cosine_floor`.

## DESCRIPTION

### Layer 1 - how the relevant code behaves today

- `PHASES` (`src/lib/agents/samskara/loop.ts:91`) already lists
  `'mint-tier2'` after `'mint-tier1'`. `runOneCycle` dispatches it
  (`loop.ts:190`). `runMintTier2Phase` (`loop.ts:622`) returns
  `'empty-phase'` unconditionally - the wiring exists, the body is a
  stub.
- `runMintTier1Phase` (`loop.ts:458`) is the template: throttle-gate,
  fetch candidate input, call the agent, embed the prediction, run a
  cosine dedup guard (`samskara_nearest_by_prediction` +
  `samskara_reinforce_existing` when cosine >= `MINT_DEDUP_COSINE`
  0.85), else insert a `samskaras` row + `samskara_provenance` rows,
  fire `onMint`.
- `samskara_collapse_by_cofiring` (`supabase/schema.sql:6074`) holds
  the co-fire self-join this plan reuses: `samskara_fires f1 join
  samskara_fires f2 on f1.cohort_id = f2.cohort_id and
  f1.samskara_id < f2.samskara_id`, grouped to per-pair co-fire
  counts, filtered to `tier = 1` on both sides. It enumerates *pairs
  to merge*; tier-2 needs *groups to compound*.
- `samskara_fire_top_k` (`schema.sql:5166`) selects from `samskaras`
  with NO tier filter (`schema.sql:5216`). `samskara_apply_reaction`
  (`schema.sql:5318`) operates per cohort, tier-agnostic.
  `samskara_decay` (`schema.sql:5689`) has no tier filter. The
  `samskaras` table already permits `tier in (1, 2)`
  (`schema.sql:4847`) and `samskara_provenance.kind` already permits
  `'samskara'` (`schema.sql:4925`) for parent-points-at-children
  provenance.
- The mood-pill UI carries `tier: 1 | 2` through
  (`src/lib/samskara/events.ts`, `mood.svelte.ts`) and maps emoji off
  *valence*, not tier. The toast does not special-case tier.

The load-bearing consequence: **tier-2 rows ride the entire existing
fire / reaction / decay / priming / UI machinery for free the moment
they exist.** No chat-loop change. No `fire_top_k` change. No UI
change. The work is entirely (a) detect a group, (b) synthesize a
parent, (c) insert it - all inside the formation worker and schema.

### Layer 2 - what this plan changes

Four units, mirroring the tier-1 split: SQL detection, LLM synthesis,
worker wiring, dedup guard.

#### 2a. New RPC: `samskara_tier2_candidate(...)` (schema.sql)

One candidate group per call, the strongest currently-uncovered one,
in the same one-unit-of-work-per-cycle spirit as tier-1 minting one
cluster per cycle. Signature (defaults are the starting dial, tune
against real corpus behaviour):

```text
samskara_tier2_candidate(
  p_min_cofires      int   default 4,     -- group edges need >=4 shared cohorts
  p_cosine_lo        real  default 0.30,  -- below this = spurious co-fire
  p_cosine_hi        real  default 0.68,  -- at/above this = dedup's job (floor 0.70, margin)
  p_min_group_size   int   default 3,     -- a group of 2 is a dedup candidate, not a compound
  p_max_group_size   int   default 6,     -- cap LLM input + keep the claim coherent
  p_overlap_skip     real  default 0.60   -- skip if an existing tier-2 already covers this set
) returns table (samskara_id uuid, prediction text, valence real, cofire_weight real)
```

Algorithm (plpgsql, `security invoker`, `auth.uid()`-scoped, same
shape as `samskara_collapse_by_cofiring`):

1. Build `pair_cofires` from the tier-1/tier-1 cohort self-join
   (lift it verbatim from the dedup function), keeping pairs with
   `cofires >= p_min_cofires` AND prediction-embedding cosine in
   `[p_cosine_lo, p_cosine_hi)`. The half-open top end is what keeps
   tier-2 off dedup's territory.
2. Seed = the surviving pair with max `cofires` (tie-break higher
   cosine, then older `created_at` for determinism).
3. Greedily grow the group: repeatedly add the tier-1 samskara that
   co-fires (>= `p_min_cofires`) with the largest number of current
   members and whose cosine to at least one member is in band. Stop
   at `p_max_group_size` or when no candidate qualifies.
4. Coverage skip: if any existing `tier = 2` samskara's provenance
   child-set (`kind = 'samskara'`) overlaps the candidate group by
   Jaccard >= `p_overlap_skip`, return empty - that compound already
   exists, and re-minting it as membership drifts by one element is
   the tier-2 analog of the tier-1 twin problem.
5. Return the group's `(samskara_id, prediction, valence,
   cofire_weight)` rows when size >= `p_min_group_size`, else empty.

`cofire_weight` (per member, e.g. its summed co-fire count with the
rest of the group) feeds provenance `weight` and the valence
aggregation.

A cheap precondition guard belongs at the TOP of the function (before
the self-join, which is the expensive part): if the user has fewer
than ~8 tier-1 samskaras with `fire_count > 0`, return empty
immediately. Tier-2 is meaningless on a thin, barely-fired corpus, and
the self-join is the costliest query in the phase.

#### 2b. New agent method: `SamskaraAgent.mintTier2(...)` + `TIER2_MINTER_PROMPT`

`src/lib/agents/samskara/agent.ts` gains a `mintTier2` method
paralleling `mint` (`agent.ts:218`). Input: the child predictions
(plus their valences). Output: the same `MintResult` shape (`confirm`,
`prediction`, `inner_voice`, `valence`, `confidence`) so the worker
path is uniform. `confirm: false` is the quality gate - the agent
refuses incoherent groups, exactly as the tier-1 minter refuses noisy
substrate clusters.

`src/lib/agents/samskara/prompts.ts` gains `TIER2_MINTER_PROMPT`. It
differs from `MINTER_PROMPT` in framing: the input is not raw
situations but a set of *existing predictive claims that fire
together*, and the task is to name the higher-order disposition they
share - "the pattern behind the patterns" - in one claim that is
strictly more general than any child, or to refuse (`confirm: false`)
when the children only coincidentally co-fire and share no real
super-pattern. The prompt must forbid merely concatenating or listing
the children (that is what makes a vapid compound) and must keep the
output in the same "in situations like X, this user tends to Y" shape
so it embeds and fires like any other samskara.

Why LLM synthesis and not pure SQL: a compound's *value* is the
generalization, which only a model can write. A SQL-only tier-2 could
at most concatenate child text, producing a claim that is longer but
not higher-order - and that pollutes both the fire query (a bloated
embedding) and the compound summary. The `confirm: false` escape
hatch is the same first-line filter tier-1 relies on. (Alternative
considered: pure-SQL clustering with no LLM, mirroring dedup. Rejected
because dedup's output is a *delete*, which needs no prose, whereas
tier-2's output is a *new claim* - exactly the thing models are for.)

#### 2c. Implement `runMintTier2Phase` (loop.ts)

Replace the stub body with the tier-1-shaped flow:

1. Throttle-gate via `isPhaseThrottled(ctx, 'mint-tier2')`. Use a
   LONGER interval than mint-tier1's 60s - compound patterns form over
   many turns, and the detection self-join is heavier than tier-1's
   substrate fetch. Add a `tier2ThrottleMs` (suggest 5 min) rather
   than reusing the shared `minIntervalMs`, OR widen the throttle map
   to per-phase intervals. The cheap precondition inside the RPC
   (2a step 0) is the second line of defense if the throttle is too
   loose.
2. Call a new `ctx.supabase.samskaraTier2Candidate(...)` wrapper. If
   it returns < `p_min_group_size` rows, `'empty-phase'`.
3. Call `ctx.agent.mintTier2(children, ctx.signal)`. Null or
   `confirm: false` -> `'empty-phase'`.
4. Embed `minted.prediction` (same `embed` + `padEmbeddingForStorage`
   path as tier-1, `loop.ts:492`).
5. Dedup guard against existing tier-2s: query nearest existing
   samskara by prediction embedding, FILTERED to `tier = 2`, and if
   cosine >= `MINT_DEDUP_COSINE` reinforce instead of inserting. This
   needs either a `p_tier` argument on `samskara_nearest_by_prediction`
   or a tier-2 variant - the current function
   (`schema.sql:5876`) returns all tiers. (The provenance-overlap
   skip in 2a already catches the same-children case; this embedding
   guard catches the different-children-but-same-claim case.)
6. Insert the `tier = 2` row (raw client insert, same as tier-1's
   `loop.ts:557`), then upsert `samskara_provenance` rows with
   `kind = 'samskara'`, `ref_id = child.samskara_id`,
   `weight = child.cofire_weight`.
7. `ctx.onMint?.({ tier: 2, valence, confidence })`. The pill and
   events already handle tier 2 - no UI change.

Seed `valence` as the cofire-weighted mean of child valences (or take
the agent's value); seed `confidence` conservatively (mean child
confidence, or the schema default 0.5) and let reaction-classify move
it - tier-2 rows are classified by the exact same cohort machinery
once they start firing.

#### 2d. Client wrapper + worker tunable

- `src/lib/supabase.ts`: add `samskaraTier2Candidate(...)` next to
  `samskaraCollapseByCofiring` (`supabase.ts:6463`), returning the
  typed child-row array; add the `tier = 2` filter to
  `samskaraNearestByPrediction` (`supabase.ts:6408`).
- `src/lib/agents/samskara/worker.ts`: thread a `tier2ThrottleMs`
  tunable through `StartMessage` and into the `phaseThrottle` config
  (`worker.ts:42` is where `PHASE_THROTTLE_MIN_INTERVAL_MS` lives).

### Layer 3 - how this closes PURPOSE

Once 2a-2d land, the formation worker, between user turns, detects a
recurring constellation of co-firing tier-1 claims, asks the fast
model to name the disposition behind it, and writes a tier-2 parent
that thereafter fires and primes through the unchanged hot path. The
correlated long tail consolidates into stable parents; the compound
summary (which reads top samskaras regardless of tier) starts
incorporating those parents; and priming budget that three correlated
bullets used to split now goes to one higher-signal claim. The
missing compression layer is filled, additively, without touching the
chat turn.

## Interactions with other features (deltas vs samskara.md)

- **Dedup (`samskara_collapse_by_cofiring`)** - the tightest
  coupling. Both read the co-fire self-join. Dedup filters `tier = 1`
  on both sides, so it never merges tier-2 rows and never sees
  tier-2<->tier-1 co-fires - good. But tier-2 detection MUST keep its
  cosine window (`[p_cosine_lo, p_cosine_hi)`) strictly below dedup's
  `p_cosine_floor` (0.70), or the two phases fight over the same
  pairs. Document the shared dial in both function headers.
- **Fire / priming** - no change. `fire_top_k` already returns tier-2
  rows. Watch for tier-2 + its own children all firing in the same
  cohort (they co-fire by construction); the priming formatter may
  want a future "suppress children when the parent fired" rule, but
  v1 ships without it - extra correlated bullets are a budget concern,
  not a correctness one. Note as follow-up, do not build speculatively.
- **Reaction-classify** - no change; tier-2 rows are confirmed/
  disconfirmed per cohort like any other. A tier-2 and its children
  can land in the same cohort and all get classified together - the
  parent and children may move in the same direction, which is the
  intended reinforcement, not double-counting (each is a distinct row
  with its own confidence).
- **Compound-regen** - `samskaraTopForSummary` is tier-agnostic, so
  strong tier-2 parents naturally feed the prose summary. This is
  mildly recursive (a compound feeding the summary) and desirable -
  the strongest higher-order read should dominate. No change needed.
- **Decay** - tier-2 rows decay like tier-1. Orphan case: if dedup
  later merges/deletes a tier-2's children, provenance (`no FK on
  ref_id`) does not cascade and the tier-2 keeps standing on its own
  embedding and fire history. Acceptable - a compound that earned its
  confidence does not need its scaffolding. Note it; don't add cleanup.
- **UI** - none. The mood pill renders tier-2 mints through the same
  valence->emoji path.

## Gotchas to bake in (and into samskara.md when this lands)

- **Cosine-band coupling with dedup** - see Interactions. The single
  likeliest source of a confusing bug ("my tier-2 keeps disappearing"
  = dedup eating an overlapping-band group).
- **Re-mint storm without the coverage skip** - once a tier-2 covers
  a group, the group still co-fires every cycle and detection will
  re-surface it forever. The Jaccard `p_overlap_skip` guard (2a step
  4) is load-bearing, not optional. The embedding dedup guard (2c
  step 5) is the second net.
- **Self-join cost** - the detection query is the heaviest in the
  phase. The cheap tier-1-count precondition (2a step 0) and the
  longer throttle (2c step 1) both exist to keep it off the common
  idle path. Do not drop either.
- **Provenance has no FK on ref_id** - by existing design
  (`schema.sql:4917`). Tier-2 provenance pointing at children inherits
  this: deleting a child does not break the parent. Intended.
- **Tier cap stays `(1, 2)`** - no tier-3. A compound-of-compounds is
  a noise amplifier; the `check (tier in (1, 2))` constraint
  (`schema.sql:4847`) is the guard and must not be lifted as a
  side effect of this work.

## Testing

- `tests/samskara-loop.test.ts` is the harness - it drives
  `runOneCycle` against a mock `SupabaseService`. Add a `mint-tier2`
  block paralleling the existing `mint-tier1` tests: candidate group
  returned + agent confirms -> asserts insert(tier:2) + provenance
  (kind:'samskara') + `onMint({tier:2})`; no candidate -> `empty-phase`;
  agent `confirm:false` -> `empty-phase`; embedding dedup hit ->
  reinforce, no insert, no `onMint`; throttled -> `empty-phase` with
  no RPC call.
- Agent-level: a `mintTier2` parse test (valid JSON -> MintResult;
  `confirm:false` -> null; garbage -> null), mirroring the `mint`
  tests.
- The detection RPC itself has no vitest coverage (no DB in the unit
  suite). Validate it via `mise run sync` against the linked project
  and a manual SQL exercise: seed two cohorts of co-firing tier-1
  rows in the mid-cosine band, confirm a candidate group comes back;
  add a covering tier-2 and confirm the coverage skip suppresses it.
  State this gap explicitly in the PR per the cloud-agent
  can't-open-a-browser / can't-run-the-DB posture.

## Sequencing

1. Schema: `samskara_tier2_candidate` + the `tier`-filtered
   `samskara_nearest_by_prediction` variant (or argument). Apply with
   `mise run sync`; exercise by hand.
2. `prompts.ts` + `agent.ts`: `TIER2_MINTER_PROMPT` + `mintTier2`.
   Unit-test the parse.
3. `supabase.ts`: wrappers.
4. `loop.ts` + `worker.ts`: implement `runMintTier2Phase` + the
   throttle tunable. Unit-test the phase.
5. Update `docs/dev/samskara.md`: flip every "stubbed" / "empty-phase"
   note on tier-2 (the Files entry for `loop.ts`, the Mint-tier2
   worker-side contract, the Gotcha) to describe the live phase, and
   fold this plan's Gotchas into its Gotchas section. The plan doc is
   the design record; samskara.md is the living reference - keep them
   from drifting by retiring the stub language in the same PR.

This is purely additive: no existing tier-1 / fire / reaction / decay
behaviour changes, so the blast radius is the new phase plus the two
schema functions. Land it behind nothing - the phase produces no
tier-2 rows until a corpus is large enough to trip the precondition,
so a quiet deploy is self-gating.
