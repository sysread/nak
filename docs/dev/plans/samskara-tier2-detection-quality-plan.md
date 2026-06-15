# Samskara Tier-2 Detection Quality Plan

Status: PROPOSED. Not implemented. This doc is the design of record;
the living reference once it lands is `docs/dev/samskara.md` (Tier-2
detection formula + Gotchas). Grounded in a read-only prod audit of
the single live user's data on 2026-06-15 - the numbers in
**EVIDENCE** are from that audit and should be re-pulled before
implementation, since the corpus will have moved.

## SYNOPSIS

Tier-2 detection (`samskara_tier2_candidate`) has minted exactly
**one** compound in a 151-samskara, ~29k-fire corpus, and currently
returns empty every sweep. Three independent holes in the detection
SQL - **winner-take-all coverage-skip**, **no base-rate
normalization** on the co-fire count, and an **inert cosine floor** -
combine so that the most elaborate machinery in the feature is
effectively non-functional in production. This plan fixes all three.

## PURPOSE

The intent of tier-2 is to mint a higher-order claim ("the pattern
behind the patterns") from a recurring co-fire *constellation* of
tier-1 samskaras that are topically distinct but reliably activate
together. The detection RPC is supposed to surface such
constellations; the minter agent then decides whether they
generalize.

In production it surfaces nothing usable:

- The default `samskara_tier2_candidate()` returns **empty** despite
  thousands of eligible co-firing pairs.
- Disabling only the coverage-skip surfaces a candidate, but it is an
  **incoherent cross-topic grab-bag** (pork chops + technical
  implementations + assistant-memory reminders + gig delivery + Thai
  food + emoji meanings) - exactly what the minter is built to refuse.

So the feature has two failure layers stacked: detection returns
empty (no candidate reaches the minter), and even when forced to
return a candidate, the candidate is junk. The net effect is a
permanent ceiling of ~1 tier-2 regardless of corpus growth.

## EVIDENCE (prod audit 2026-06-15, single live user)

Corpus shape:

- 151 samskaras: **150 tier-1 (pinned at the dedup population cap),
  1 tier-2**. The single tier-2 carries 6 children (`provenance.kind
  = 'samskara'` count = 6).
- 28,968 lifetime fires.

Co-fire structure among tier-1s (pairs co-firing in `>= 4` cohorts):

```text
cofiring_pairs_ge4          4923
above_band (cos >= 0.68)     303   -- dedup territory
in_tier2_band [0.30, 0.68)  4620   -- the eligible pool
below_band (cos < 0.30)        0
max_cos                     0.814
min_cos                     0.381
```

The eligible pool is enormous (4,620 pairs; the co-fire graph is
~41% dense over 150 nodes). Detection is **not** fuel-starved.

Forced candidate (called with `p_overlap_skip := 1.01` to disable the
coverage-skip) returned a 6-member group whose members are
topically unrelated, each with a `cofire_weight` of **1,525-1,945**
(i.e. each member co-fires with the rest of the group on the order of
hundreds-to-thousands of cohorts). These are among the
highest-firing samskaras in the corpus - they bind by *frequency*,
not affinity.

## The three holes

### Hole 1 - winner-take-all coverage-skip

`samskara_tier2_candidate` (`supabase/schema.sql`, the seed +
coverage-skip block) selects **the single strongest eligible edge**
(`order by cofires desc limit 1`), grows one group around it, and if
that group's Jaccard overlap against any existing tier-2's child-set
is `>= p_overlap_skip` (0.60) it **`return`s empty** - it never
advances to the next-strongest *uncovered* edge.

Consequence: the strongest edge sits in the densest region of the
co-fire graph, which is the same region the existing tier-2 was
minted from. So once one tier-2 exists, the strongest edge is
perpetually covered, the skip fires, and detection returns empty
forever - even though 4,620 eligible pairs and many uncovered
constellations exist elsewhere. Proven: disabling only the skip makes
a candidate appear.

### Hole 2 - no base-rate normalization on the co-fire count

Eligibility is `cofires(A, B) >= p_min_cofires` (raw count, default
4). Two samskaras that each fire on 20%+ of all turns co-fire
thousands of times *regardless of any real association* - pure
base-rate binding. The **dedup** pass already defends against exactly
this with a ratio gate (`cofires / min(fires_A, fires_B) >=
p_min_cofire_ratio`); tier-2 detection omits the normalization
entirely, so it ranks the busiest (least topically specific)
samskaras to the top. That is why the forced candidate's members are
the generic always-on predictions, not a coherent habit cluster.

### Hole 3 - the cosine floor is inert

The eligible band is `[p_cosine_lo, p_cosine_hi)` = `[0.30, 0.68)`.
But every prediction shares the "In situations like X, this user
tends to Y" template, which floors *any* pairwise prediction-cosine
around 0.38 (audit: `min_cos = 0.381`, **zero** co-firing pairs below
0.30). So `p_cosine_lo = 0.30` filters nothing; the band collapses to
"anything below dedup's 0.68," admitting ~94% of co-firing pairs. The
intended coherence gate is not gating - it is template-similarity
noise, not topical similarity.

## DESCRIPTION

### Layer 1 - how detection behaves now

The candidate RPC: precondition (>= 8 fired tier-1s) -> materialize
eligible edges (raw co-fire `>= 4`, cosine in `[0.30, 0.68)`) -> pick
the single strongest edge as seed -> grow a group of nodes co-firing
with both seed members -> reject if group `< 3` -> coverage-skip
(empty if any existing tier-2 covers it by Jaccard `>= 0.60`) ->
emit. Each call inspects exactly one seed.

### Layer 2 - what this plan changes

Same pipeline, three changes at the named decision points:

- **Eligible-edge filter (Holes 2 + 3):** add a base-rate ratio gate
  parallel to dedup's - require `cofires(A,B) / min(fires_A, fires_B)
  >= p_min_cofire_ratio` so frequency-bound pairs drop out - and make
  the coherence gate real. Two candidate approaches for the latter,
  to be decided in implementation (see Open questions): raise
  `p_cosine_lo` well above the ~0.38 template baseline, or compute
  coherence on the members' **substrate / situation** embeddings
  (which carry topical content) rather than the template-heavy
  prediction embeddings.
- **Seed selection (Hole 1):** when the strongest-edge group is
  coverage-skipped, **advance to the next-strongest edge whose group
  is uncovered** instead of returning empty. Equivalent alternative:
  exclude already-covered child-sets from the eligible-edge pool
  before seeding, so a covered region cannot win the seed at all.
  Either way the call must be able to return an uncovered
  constellation when one exists.

### Layer 3 - how that fixes PURPOSE

The ratio gate removes the always-on samskaras that dominate the raw
co-fire ranking, so the surviving edges represent genuine affinity,
not shared base rate. A real coherence gate then keeps the group
topically tight. Seed iteration stops one covered tier-2 from
masking every other constellation. Together they let detection
surface coherent, uncovered candidates the minter can actually
generalize - lifting the permanent ~1-tier-2 ceiling.

## Open questions (resolve during implementation)

1. **Coherence gate: raise the floor vs. switch embedding source.**
   Raising `p_cosine_lo` is a one-line change but stays hostage to
   the prediction template; scoring on substrate/situation embeddings
   is truer to topical coherence but requires joining substrate
   provenance into the detection self-join (heavier query, and tier-2
   provenance points at child samskaras, not substrate, so the join
   path needs design). Spike both; prefer the floor bump if it
   cleanly separates the forced-candidate junk from real clusters.
2. **Where the base-rate ratio lives.** Mirroring dedup's
   `p_min_cofire_ratio` (0.5) may be too strict for tier-2's
   "distinct but co-activating" intent (distinct claims co-fire
   *less* reliably than duplicates by definition). The ratio floor
   for tier-2 is likely lower than dedup's; derive it from the audit
   distribution, do not copy 0.5 blindly.
3. **Interaction with the 150 population cap.** The corpus is pinned
   at the tier-1 cap by dedup. Tier-2s do not count against that cap
   (`tier in (1,2)`, cap targets tier-1), so unblocking tier-2 does
   not fight the cap directly - but confirm the dedup self-join and
   tier-2 self-join still do not overlap once the bands move (the
   existing dedup-coupling gotcha: keep `p_cosine_hi` strictly below
   dedup's 0.70 floor).

## Testing

- Deno unit coverage in `supabase/functions/tests/samskara.test.ts`
  for any JS-side helper that moves; the RPC itself is SQL, so the
  primary proof is a seeded-fixture exercise of
  `samskara_tier2_candidate` asserting: (a) a frequency-bound but
  topically-incoherent trio is rejected, (b) a covered strongest edge
  yields the next uncovered constellation rather than empty, (c) a
  genuinely coherent uncovered trio is emitted.
- Re-run the prod audit queries (co-fire band split; forced-candidate
  call; default-call) before and after to show the candidate the
  default call surfaces is now coherent, not the pork-chops grab-bag.
- QA walkthrough: extend or add a use-case under
  `docs/qa/use-cases/` proving a second tier-2 can mint end-to-end
  (detection -> minter confirm -> insert -> provenance).

## Interactions

- **Dedup** (`samskara_collapse_by_cofiring`) - the source of the
  base-rate-normalization pattern this plan ports, and the half-open
  cosine-band coupling that must be preserved (tier-2's `p_cosine_hi`
  stays strictly below dedup's `p_cosine_floor`). See the
  dedup-coupling gotcha in `samskara.md`.
- **Mint-tier2 probe** (`samskara.ts`) - the consumer of the
  candidate; unchanged in shape, but it should start seeing coherent
  candidates and so actually mint past the first. Watch the minter's
  `confirm:false` rate as the signal that candidate quality improved.
- **Observability / B3** - the standing
  "tier-2-candidate-available?" readout (currently unbuilt; see the
  observability plan) is the instrument that would have surfaced this
  stall without a manual self-join. Building it alongside this fix is
  recommended so the next regression is visible on the Health panel.
