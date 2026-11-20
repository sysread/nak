# The dynamic smoothing rubric (B10) - the samskara-built per-user calibration

Status: PLAN (refinement round 1 folded; round 2 pending).

## SYNOPSIS

The smoothing check (B9) judges every reply against a fixed fleet
rubric. B10 adds the DYNAMIC layer Jeff asked for: the samskara
formation machinery - the same pipeline that builds the user's
compound summary - ALSO builds a per-user smoothing rubric
("what smoothing looks like for THIS user"), stored next to the
summary, and the composite stage appends it to the smoothing
question's instructions at judge time.

The fleet rubric stays and always rides: the dynamic section can
only SPECIALIZE the standard (concrete tells drawn from the user's
observed patterns), never weaken it. A user with no summary (cold
start) or a failed build runs the fixed rubric alone - fail-open.

## BACKGROUND

- **The regen lane (mapped)**: `agentSummarizeCompound`
  (`agents/samskara.ts:664`) runs `COMPOUND_SUMMARY_PROMPT` over the
  top live samskaras through `callOnce` (2 attempts + a strict
  shape guard against the reasoning-channel leak - the 2026-09-04
  lesson), then `samskara_save_compound_summary_if_claimed` (the
  claim-guarded upsert RPC) writes `samskara_compound_summary`
  (user_id PK, summary, samskara_count, last_regen_at). The read:
  `getCompoundSummary` (`priming/samskara.ts`) with a 24h stale
  ceiling, all errors swallowed to null.
- **The regen cadence**: the compound-regen probe runs in the
  server-side sweep (TTL/claim-driven) plus the stale-summary
  catch-up lane - slow, background, budget-light.
- **The B9 surface**: the smoothing question's `instructions` string
  in `getStreamingResponse.ts`'s composite stage (the fixed rubric
  rides `criteria: SMOOTHING_RUBRIC_LEVELS`; the instructions carry
  the substance + the boundary + the exemptions).
- **The candor contract** (`samskara.md:217-243`): both minter
  prompts and the summary prompt produce honest, friction-carrying
  output - the summary prompt is "deliberately softer - honest,
  friction in proportion to the evidence" (`samskara.md:230-231`;
  the prompt itself phrases it "in proportion to how strongly the
  claims support it", `agents/samskara.ts:400-403`). The dynamic
  rubric inherits this: it reads the user's OWN patterns as
  material for what comfort-rewriting would look like for them.
- **The bless-the-disease guard (B9's recorded risk, now the
  load-bearing constraint)**: a per-user rubric derived from
  user-controlled text could enforce the user's bias. The samskara
  summary is the SYSTEM's calibrated model (not user-authored), and
  the dynamic section appends to - never replaces - the fixed
  anchors. The prompt-level rule: specialize and tighten only.

## DECISIONS

- **D1 - A second output of the same regen pass, not a change to
  the summary's call.** The summary prompt's wire format is prose
  only and its shape guard is a hard-won lesson; B10 adds a SECOND
  cheap call (`SMOOTHING_RUBRIC_PROMPT` through the same `callOnce`,
  2 attempts + its own shape guard) in the same regen probe.
  Independent failure: a rubric failure never blocks the summary
  (and vice versa). The extra call rides the regen cadence (slow,
  sweep-driven) - not the turn path.
- **D2 - Storage: a new `smoothing_rubric text` column on
  `samskara_compound_summary`** (same PK, shared stale ceiling, the
  regen cadence already correct). The save RPC
  (`samskara_save_compound_summary_if_claimed`) gains
  `p_smoothing_rubric text default null` - a schema change.
  **Migration mechanism (re-rooted per the round-1 audit; the
  plan's original citation pointed at another repo's flow)**: edit
  `supabase/schema.sql` directly (the column + the RPC body) -
  the `sync-supabase` CI job applies schema.sql on merge
  (CLAUDE.md:919-930), and the dml-columns scanner
  (`tests/schema-dml-columns.test.ts`) pins the RPC body against
  schema.sql only. **UPDATE semantics (the wipe guard)**: the
  rubric build failing while the summary succeeds must not wipe a
  previously stored good rubric - the RPC's UPDATE uses
  `smoothing_rubric = coalesce(p_smoothing_rubric, smoothing_rubric)`
  (null means KEEP the stored rubric). Without this, one failed
  rubric call silences the dynamic layer for 6h+ (the regen
  trigger's next-fire window) for a user who had a good one.
- **D3 - The prompt's contract**: given the same top-samskaras
  payload, name what validation and comfort-rewriting look like for
  THIS user specifically - concrete tells drawn only from the
  claims (e.g. a user whose patterns show deep expertise in X:
  validating surface claims about X is the smoothing tell). The
  floor rule in the prompt: the fleet standard (the fixed rubric's
  anchors) is the minimum; the dynamic section names ADDITIONAL or
  SHARPERER tells, it never licenses softer behavior. The candor
  contract's tone: a colleague's honest briefing. Output: one short
  prose block (a ~600-char cap, enforced by the shape guard), no
  headings, no JSON. Null on failure - the fixed rubric runs alone.
- **D4 - The judge-time assembly**: the composite stage reads the
  rubric via a SIBLING GETTER (the decided option - the alternative,
  extending `runServerPriming`'s return, was rejected: it returns
  void today and its result is never captured, so it means
  reshaping the priming orchestrator AND threading the value
  through `getStreamingResponse`; the getter is self-contained,
  one PK read per clarity-enabled turn, and sits OUTSIDE the
  priming 1500ms race - no turn-start latency). Same swallow
  contract + stale ceiling as `getCompoundSummary`. The stage
  appends to the smoothing question's instructions: "User-specific
  calibration (the assistant's private model of this user):
  <rubric>". Null-safe at every step: no row / stale / empty /
  failed build -> the instructions are unchanged (the fixed rubric
  alone). The FIXED anchors always ride in `criteria` - the
  dynamic text is additive context, never the scale.
- **D5 - Judge-facing only.** The dynamic rubric is detection-side
  material (the negative form is legal there); it never rides a
  system prompt (the priming-hazard rule). Smoothing-only: the
  clarity check keeps the fleet rubric (extending later is a
  one-line append if ever wanted).
- **D6 - Observability**: the checks debug line gains
  `smoothingRubricChars=N` (0 = none) - the live QA can verify the
  calibration reached the judge without logging its content (the
  summary's content never logs either).

## PLAN

1. **`supabase/schema.sql`**: the `smoothing_rubric text` column on
   `samskara_compound_summary` + the save RPC's signature and body
   (the coalesce semantics per D2). Applied by the `sync-supabase`
   CI job on merge; the dml-columns scanner pins the RPC body here.
2. **`agents/samskara.ts`**: `SMOOTHING_RUBRIC_PROMPT` (D3's
   contract) + `agentBuildSmoothingRubric` (its OWN shape guard -
   the summary's `isCleanSummaryParagraph` assumes the summary's
   third-person voice and has no length cap; the rubric guard
   enforces the ~600-char cap, no headings, no JSON, no lists) +
   the regen probe calling both and passing both to the save RPC
   (the null-rubric path hits the RPC's coalesce - the wipe guard).
3. **`priming/samskara.ts`**: the sibling getter
   `getSmoothingRubric(admin, userId, log): Promise<string | null>`
   - the same swallow contract + stale ceiling as
   `getCompoundSummary` (D4's decided plumbing).
4. **`getStreamingResponse.ts`**: the stage reads the rubric and
   assembles the smoothing instructions (D4) + the debug line's
   chars count (D6).
5. **Tests**: the prompt's floor lint (the tighten-only rule cannot
   be violated - the prompt must carry the fleet anchors as the
   minimum); the agent's shape guard (the cap, no headings/JSON);
   the assembly's null/empty/stale arms; the coalesce semantics
   (a null rubric write keeps the stored value - the wipe guard's
   pin, in the schema/RPC test surface); the body assertion (the
   calibration rides the smoothing question ONLY - not clarity,
   not the system prompt).
6. **Docs + QA**: `samskara.md` gains the second output; 
   `clarity.md` the dynamic layer; the QA doc the arms.
7. **Gate, refine, QA, land.** The standard loop.

## RISKS

- **The bless-the-disease risk in its new form**: the summary says
  "this user wants warmth" -> a naive rubric would license softer
  replies. Mitigation: D3's floor rule (specialize/tighten only) +
  the fixed anchors always riding (D4) + the summary itself being
  the system's calibrated model under the candor contract.
- **Wire growth**: the smoothing instructions grow by the rubric's
  ~600-char cap per judge call for summary-bearing users - bounded,
  and the judge call is once per turn.
- **The regen lane's budget**: one extra small call per regen pass
  (sweep cadence, not turn cadence).
- **Cold start / sparse patterns**: a user with thin samskaras gets
  a thin or absent rubric - fail-open to the fixed rubric; no
  behavioral cliff.

## VERIFICATION

- Unit: the extended suites (`mise run check`, un-piped).
- **Live QA (shared-stack protocol, fixtures prefixed `ZZQA-B10`)**:
  1. **Calibration arm**: the dev profile (summary-bearing) - FIRST
     force a regen (existing rows carry `smoothing_rubric = null`
     until a post-B10 regen; backdate `last_regen_at` and run the
     sweep tick, the `samskara-formation.md` precondition pattern),
     then assert: the stored row's rubric names tells consistent
     with the fixed standard; a turn with the toggle on shows
     `smoothingRubricChars>0` in the checks debug line.
  2. **Cold-start arm**: a fresh user (no summary row) runs a turn;
     the line shows `smoothingRubricChars=0`; the judge behaves as
     B9 shipped.
  3. **Wipe-guard arm**: with a good rubric stored, force a regen
     where the rubric build fails (the summary succeeds); assert
     the stored rubric survives (the coalesce).
  4. **Regression arms**: B9's clean + clarity-bait arms re-run
     green under the dynamic layer.
  The executed row lands in the QA doc's Results log.
