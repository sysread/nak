# Samskara evidence backfill: the warmup pool (plan)

Status: IMPLEMENTED rev 8, 2026-10-26. Revised through seven fresh-context
review rounds (deep-mode seven-lens fan-out, then general,
schema-and-data-model, cross-module-contracts, lifecycle, and
prompt/UI lenses, then a general convergence round). Owner's
framing: when a person adopts a new predictive pattern, they
re-read past experience in light of it. The system should do the
same: a newly minted claim is judged against the conversations
that would have tested it, before it is allowed to fire live.

## SYNOPSIS

New claims are minted into a QUARANTINE pool: they do not fire in
live conversations. An hourly backfill worker retrieves the
historical exchanges that would have fired each claim (centered
cosine over a new per-round query-embedding index, top-k by rank
rather than a high bar), judges the claim against each exchange in
its own completion, and folds the verdicts into health at reduced
weight. When the attempt budget is spent and history genuinely
engaged the claim, the claim activates. History that never engaged
it leaves the claim quarantined, where the existing 45-day
probation reaper collects it. This gives every claim an evidence
baseline at mint time instead of waiting weeks for organic tests,
and it removes the "corpus must stay tested" job the 150-cap was
quietly doing.

## PURPOSE

Two measured problems meet at the same design point:

- A minted claim carries no evidence until the live judge happens
  to test it. Age cannot distinguish "dormant" from "dead": the
  median untested row has only 2 judged fires (schema.sql:9578)
  and p90 time-to-first-genuine-test is ~13 days (schema.sql:
  9581-9582). Until tested, the claim is either a dangerous firer
  (an untested claim can prime the model from a plausible-sounding
  hypothesis) or invisible.
- The 150-cap conversation (samskara-lifecycle-plan.md decision 6,
  :167-169) established the cap's real job is metering formation
  against the judge's capacity to test. Backfill decouples that:
  test supply becomes a worker rate the owner controls, not a
  function of what conversations organically fire.

Out of scope: the cap value itself, the mint gates, the eviction
tier definitions, the association backlog. This plan changes what
the cap is FOR (its "keep the corpus tested" rationale dissolves)
but not its value; the cap revisit reads this plan's M5 data.

## DECISIONS

1. Quarantine is real, not advisory: a quarantined claim is
   invisible to the fire RPC (no priming, no fire rows, no cohort
   membership) until activation. Owner decision, 2026-10-26. This
   deliberately reverses the release posture of commit 22d79a38
   ("Release never-tested samskaras"), which lets untested rows
   fire so the judge can test them; quarantine trades that for a
   warmed-up corpus.
2. One completion per (claim, exchange) pair. Each historical
   exchange is judged on its own, never batched with other
   exchanges, and never with multiple claims. Owner instruction:
   separate completions minimize cross-conversation pollution.
   This differs from the live judge (which batches a thread's
   fired predictions into one completion); the backfill prompt is
   single-prediction and reuses the two-step verdict shape.
3. Backfill evidence is folded at reduced weight and separately
   recorded. The health posterior stays a single number; the
   per-verdict audit ledger distinguishes virgin backfill evidence
   from live-fire evidence. Owner instruction. The reduced weight
   is what carries the class distinction into the math; the p0
   prior still sees all evidence (documented, watched in M5).
4. The claim's own birthplace is excluded from its backfill
   candidates: provenance-resolvable threads never judge the claim
   they minted (the mint sources would confirm with near
   certainty). Owner design, 2026-10-26.
5. Existing corpus is grandfathered: every row alive at deploy gets
   activated_at = now() via a one-shot marker. Backfill applies to
   the quarantine pool going forward; no retroactive backfill of
   the ~157 live rows (owner datum, point-in-time).
6. The judge is not told the claim is new, quarantined, or
   backfilled. The prompt presents a prediction and a transcript;
   provenance disclosure risks a leniency or harshness anchor.
7. No new death machinery. The existing 45-day probation reaper
   (samskara_reap_untested, schema.sql:9429-9443) is the quarantine
   death path for never-engaged claims; no 14-day adjacency reaper
   is built. The alternative was rejected as machinery the evidence
   does not need yet; the backfill ledger keeps the not-engaged
   record either way.
8. "Warming up" is the user-facing copy for a QUARANTINED row with
   attempts remaining; a budget-spent never-engaged row reads
   "warmed up - history never engaged this claim" (still
   QUARANTINED mechanically - it dies at the reaper). The state's
   name everywhere mechanical is QUARANTINED.

## STATE AND TRANSITION MATRIX

A claim's activation state. Existing machinery (health posterior,
eviction, reap) is otherwise unchanged. Precedence rule: the
worker's claim columns arbitrate every transition - no actor other
than the claim holder may transition a row whose claim is held;
the holder's own guarded saves are the arbitration mechanism.

| State | Meaning | Entered by |
| --- | --- | --- |
| QUARANTINED | `activated_at` null. Invisible to the fire RPC; no fires, no cohorts, no priming. | Mint insert (column default). One-shot grandfather block. |
| ACTIVE | `activated_at` set. Fires normally; identical to today's semantics. | Transitions 1-3 below. |
| DEAD | Row deleted. | Transitions 4-6 below. |

Transitions QUARANTINED -> ACTIVE (one rule, one exception):

| # | Trigger | Condition |
| --- | --- | --- |
| 1 | Worker gate check | The candidate pool for this claim is exhausted (attempts spent OR no eligible candidates remain) AND the claim has >= 1 genuine engaged backfill test (held + contradicted + not-borne-out). |
| 2 | Empty-corpus exception | The user has no substrate rounds outside the claim's birthplace AT ALL (checked by round existence with a live user message, NOT by embedding state - the embedding poll lags the deploy and would otherwise mass-activate early mints). Nothing exists to judge against; quarantine would be indefinite starvation. Activate immediately. |
| 3 | Grandfather block | One-shot at the deploying merge; every row alive that day activates. |

Transitions QUARANTINED -> DEAD:

| # | Trigger | Condition |
| --- | --- | --- |
| 4 | Probation reaper (existing) | 45 days, evidence tallies still zero. A fully not-engaged backfill leaves tallies zero, so history-disproved-adjacent claims die here. Genuinely tested claims are immune (tallies > 0). A mid-backfill row is protected by its youth (45 days) and, post-fold, by the same tallies. |
| 5 | Merge (existing, ACTIVE only) | The collapse RPC merges ACTIVE pairs only (M1's filter), so a quarantined row cannot currently be merge-deleted; this transition exists for the day the collapse filter changes. The ledger cascade note (M1) documents the data path either way. |

ACTIVE -> DEAD: existing machinery only (probation reaper, reap_dead,
cap-pressure eviction tiers). Backfill never touches an ACTIVE row.
Cap-pressure eviction is INVISIBLE to quarantined rows: they hold no
live-corpus slots (M1), so evicting one frees nothing; every victim
tier gains the activation filter. The reaper and the reaper alone
closes out never-engaged quarantine.

Readers of the activation state - the COMPLETE enumeration (every
`.from('samskaras')` call site and every schema-side select on the
table, classified):

FILTERED readers (gain `activated_at is not null`, or the inverse
where the death paths need it):

| Reader | Where | Why filtered |
| --- | --- | --- |
| Fire RPC | schema.sql:8526 | Decision 1: no priming, no fires, no cohorts. |
| corpusAtCap | agents/samskara.ts:1183 | Quarantined rows hold no live-corpus slots. |
| Eviction tiers (x3) | schema.sql:9635-9683 | Evicting a quarantined row frees no slot. |
| Collapse, both passes | schema.sql:10155+ | Overflow must never merge a quarantined claim. |
| Control draw | agents/samskara_evaluation.ts:365 | The live selection instrument stays clean. |
| Compound-regen sample | agents/samskara.ts:1634 | The always-on paragraph is fed by the LIVE corpus; a quarantined row (health 1.0 default, zero negative evidence) would rank at the TOP of this read and prime every system prompt - the exact outcome decision 1 forbids. |
| Compound-regen count | schema.sql:9808 (samskara_should_regen_compound) | The regen trigger meters the live corpus; counting quarantine churn would trip regen on mints that cannot fire. |
| Intent-agent context reads (x2) | agents/intent.ts:393,513 | The intent-employment prompt consumes claims as standing context; quarantined claims cannot have been employed (they never fire) and only pollute. |

UNFILTERED readers, each an argued non-reader or deliberate death
path:

| Reader | Why unfiltered |
| --- | --- |
| Judge prediction fetch | agents/samskara_evaluation.ts:502 - reads by fired ids; only ACTIVE rows have fire rows. |
| Mint insert | agents/samskara.ts:880 - writer. |
| Claim-mean compute | schema.sql:8418 - geometry ignores activation (dedup register); consistent with the non-reader stance below. |
| Embed poll | schema.sql:9150 - infrastructure writer. |
| population_p0 | schema.sql:9237 - p0 sees all evidence (gotcha below). |
| apply_evaluation + reconcile | schema.sql:9333,9769 - operates on rows with evidence events; a quarantined row's backfill tallies SHOULD reconcile to the posterior. |
| reap_dead | schema.sql:9384-9386 - requires last_fired_at; quarantined rows never fire (verified). |
| reap_untested (45d) | schema.sql:9436 - THE death path (transition 4); deliberately unfiltered. |
| nearest_by_prediction, reinforce, merge_pair | schema.sql:9968,10013,10103 - geometry/evidence mechanics; activation-agnostic by the dedup non-reader stance. |
| Cluster-thread-fires seed read | schema.sql:8753 - reads claim embeddings by seed id; fires only exist for ACTIVE rows. |
| Search + cluster RPCs | schema.sql:10363,10426+ - DELIBERATE unfiltered reads: the browse surface must show quarantined rows (that is M4's badge). |
| Intent-mint user enumeration | schema.sql:15867 - user-existence read, no claim data. |

## DELTAS-FROM-TEMPLATE LEDGER

Template: the live judge, `agents/samskara_evaluation.ts` (the
next-day evaluation sweep). The backfill judge is its clone with
these deltas. Each row verified against the source this drafting.

| Aspect | Live judge | Backfill judge |
| --- | --- | --- |
| Completion unit | One completion per judged THREAD, predictions batched (p1..pn tags, buildVerdictRequest). | One completion per (claim, exchange) pair; single prediction, single tag. |
| Trigger | Fires recorded in a thread; day-gated thread claim; */10 cron. | Quarantine pool; hourly claim-based sweep (:21); claim-RPC pattern. |
| Conversation framing | "predictions that were live during the conversation above" | Prediction + transcript only; framing sentence replaced wholesale, no live/quarantine/backfill disclosure (decision 6). |
| Message layout | Thread transcript as native role turns, then the verdict-request user turn. | Same layout: slice as native role turns, then the verdict-request user turn. |
| Transcript input | Whole thread transcript. | Exchange slice: target round's user message + assistant reply, +-1 adjacent exchange. |
| Verdict kinds | held / contradicted / not-borne-out / not-engaged, two-step prompt, skeptical bias. | Same four kinds, same two-step shape, same semantics; the framing sentence and the batch contract change, everything else transfers. |
| Evidence weights | held -> confirm += 1; contradicted -> disconfirm += 1; not-borne-out -> disconfirm += w_soft (0.25); not-engaged -> nothing. | Same mapping scaled by w_backfill (0.5): held 0.5, contradicted 0.5, not-borne-out 0.125. not-engaged counts toward attempts, never toward tallies. |
| Record of verdicts | `verdict` column on the existing samskara_fires row. | New samskara_backfill_verdicts row per attempt. NO fire row is ever written. |
| Control arm | Yes - samskara_control_verdicts draws unfired controls per thread; the standing selection instrument. | None. The live control instrument stays clean for its own question (selection); the backfill's validity instrument is M5's agreement readout. Excluding quarantined claims from the control draw (M1) keeps the live instrument unpolluted. |
| Model | EVALUATION_MODEL = BIG_WINDOW_MODEL (agent-models.ts:71, samskara_evaluation.ts:38,559). | Same model constant. |
| Parse defense | JSON parse; malformed/missing/out-of-enum entries dropped silently (parseVerdicts). | Reused - the symbols are exported from the same module (M3). |
| Discount | Evidence aged by d per genuine test, inside apply_evaluation. | Same discount math inside apply_backfill; a claim's backfill attempts fold in one batch (one discount event per tick), vs the live judge's once-per-thread. Comment in the fold RPC. |
| Reuse mechanics | parseVerdicts / buildVerdictRequest / VerdictKind are module-private (test-reachable only via the __test namespace). | Promoted to top-level production exports of samskara_evaluation.ts; the backfill agent is their first production consumer. |

## VERIFIED MECHANICS THIS PLAN BUILDS ON

- The fire predicate is reproducible math. Live fire embeds the
  round's user-message text (extractUserText; priming.ts:815-832,
  fireSamskaras at priming/samskara.ts:225-245) and calls
  samskara_fire_top_k (priming/samskara.ts:171). Score = centered-
  cosine ramp x sqrt(health x confidence) x evidence bonus
  (schema.sql:8495-8543). The doubt-note splice belongs to the
  read-only refinement probe (priming.ts:547-549), which records
  no fires - so "user message embedded the same way" IS the exact
  composition of every judged fire. A historical exchange's user
  message, embedded identically, gives an exact would-have-fired
  test against the judged-fire population.
- The centering register for message-vs-claim comparison is the
  SUBSTRATE mean, `_samskara_centering_mean` (schema.sql:8323-
  8338, used by the fire RPC at :8510). The schema warns that
  swapping registers invalidates a tuned bar (:8266-8271). The
  claim mean (`_samskara_claim_centering_mean`, :8354) is for
  claim-vs-claim work only. The candidates RPC MUST use the
  substrate mean.
- The measured register: message-vs-claim centered cosine tops out
  at 0.299 over an 800-message prod sample, with rank 11 near 0.08
  (register note, schema.sql:8453-8462). THEREFORE candidate
  selection is TOP-K BY RANK above a LOW floor (0.05 initial), not
  a 0.30-style bar - the fire ramp's 0.30 knee is a score-saturation
  point, not an admission floor, and a 0.30 floor here would return
  zero candidates for nearly every claim, silently disabling
  quarantine via transition 2. The floor gets its own labeled
  probe set (message-vs-claim pairs; the existing probe set is
  claim-pairs under claim-mean centering - a different register
  that cannot calibrate this number).
- All embeddings share one space: claims, substrate situations, and
  fire queries are embedded by the local edge-runtime embedder
  (gte-small, 384-dim, zero-extended to the vector(2048) columns;
  _shared/local-embed.ts:1-30) and registered through the
  embeddings worker's EMBED_SOURCES table (samskara-substrate and
  samskara-predictions at _shared/embed-input.ts:213,219). The
  substrate column's inline comment still says "bge-m3's 1024" -
  stale; the model rotated to gte-small and everything was
  re-embedded (docs/dev/embeddings.md). M4 sweeps that comment.
- The judge's verdict scale: held -> confirm += 1; contradicted ->
  disconfirm += 1; not-borne-out -> disconfirm += w_soft (0.25);
  not-engaged -> no evidence, no discount (schema.sql:9288-9330,
  w_soft at :9314). The two-step prompt (engagement gate, then
  outcome) and the skeptical bias exist because prod data killed
  their absence (92.5% held-rate incident; agents/
  samskara_evaluation.ts:141-161).
- Mint provenance resolves to threads by TWO paths:
  samskara_provenance kind 'substrate' carries ref_id directly into
  a samskara_substrate row (thread_id at schema.sql:7357); kind
  'association' carries ref_id into samskara_associations
  (:7453), whose a_id/b_id point into substrate - a TWO-hop join.
  The birthplace exclusion must resolve both paths; a one-hop join
  silently matches nothing for association-minted claims, which
  are exactly the claims that have association provenance.
  Substrate pointers are SOFT - they survive message deletion
  (schema.sql:7358-7363), so candidate retrieval must join to
  messages for existence.
- The claim-RPC pattern is the house mutual-exclusion primitive
  (per-row claim columns + claim RPC + guarded save). The substrate
  table already carries TWO independent claim pairs for its two
  phases (schema.sql:7383-7391); the embedder's save RPC clears the
  claim on save (schema.sql:9188-9189), so one claim cannot carry
  two saves. A third claim pair is the house-shaped answer for
  query_embedding.
- Prior related measurement, recorded in commit 22d79a38 (2026-07-
  13): embedding-recurrence matching was measured and REJECTED as
  an eviction signal - at a 0.6 floor a mint-cluster centroid
  matched 30-70% of the archive, and at 0.7 known one-off junk
  still spanned 12 distinct weeks. This plan reuses retrieval for
  a different job (candidate retrieval for per-pair LLM judging,
  at a much lower floor, with half-weight verdicts and an M5
  agreement gate) - not as a direct evidence-free eviction signal.
  The distinction is load-bearing and cited here deliberately.
- Hourly cron minute :21 is free. Map re-derived from the schema's
  actual cron.schedule calls on 2026-10-26: every-minute embed
  backfill and stream janitor; :03 bias; :07 wiki; :13 reap;
  :17 wiki-records and rem; :23 samskara sweep; :27 reflection;
  :33 intent-employment; :37 wiki-librarian; :47 deep-sleep;
  :53 conversation-digest; :57 curation; */10 evaluation; :43
  fork-gc; daily/6-hourly jobs at 4:00-5:49. (The architecture
  doc's ladder is stale: it still lists samskara decay at :43 and
  omits :33/:53.)

## M1 - SCHEMA

All idempotent, per the house rules (add column if not exists,
drop-if-exists + recreate for RPCs; the new table is created ABOVE
the grants block at file end - tests/schema-grants.test.ts fails
loudly otherwise, and its floor >= 52 accommodates one more table).

- `samskaras` gains:
  - `activated_at timestamptz` - NULL = quarantined. Default NULL
    (new mints land quarantined).
  - `backfill_claim_holder text` + `backfill_claim_expires
    timestamptz` - the claim-RPC pair for the worker.
  - `backfill_attempts int not null default 0` - spent attempt
    budget.
  - One-shot grandfather block: `app_config` is a SINGLETON row
    (`id boolean primary key default true` + a singleton check,
    schema.sql:198-203) - there is no key column, so the marker is
    a new BOOLEAN COLUMN on the singleton (the columns-over-
    migrations pattern the model price caps use, schema.sql:216-
    233): `samskara_backfill_grandfathered boolean not null default
    false`. The guarded do-block: ensure the singleton row exists
    (insert on conflict do nothing); if the flag is false, run
    `update samskaras set activated_at = now() where activated_at
    is null` and set the flag true. Re-applies see the flag and
    skip - provably one-shot, so post-grandfather mints stay
    quarantined (the plain null-check form would re-run on every
    deploy and activate them - the deploy-blocking bug this
    mechanism exists to prevent).
- New table `samskara_backfill_verdicts`: one row per judged
  (claim, exchange) attempt. Columns: id, user_id, samskara_id,
  thread_id, user_message_id, verdict text, cosine real, judged_at,
  model text. ON DELETE CASCADE on samskara_id (house pattern,
  mirrors fires) and on user_id (auth.users - account deletion
  cascades transitively): the ledger is historical-only, a merged
  or dead claim's rows go with it, and M5 readouts accept the
  attrition.
  UNIQUE (samskara_id, user_message_id) - the candidate-exclusion
  key, doubled as the double-judge guard (the fires unique-
  constraint precedent, schema.sql:8183-8189). Index on (user_id,
  judged_at desc) for the M5 agreement joins and "n of m" counts
  (mirrors samskara_control_verdicts_user_idx, :8147-8148). CHECK
  verdict in the four kinds (mirrors control_verdicts, :8142-8143).
  RLS: owner-selectable, service-role writes. This table is the
  audit ledger (decision 3) and the candidate-exclusion and
  gate-check input.
- `samskara_substrate` gains `query_embedding vector(2048)` plus a
  THIRD claim pair `query_claim_holder text` + `query_claim_expires
  timestamptz` (the two existing pairs cover assimilate + situation
  embedding; one claim cannot carry two saves).
- RPC `samskara_backfill_candidates(p_samskara_id, p_k, p_user_id)`:
  returns the top-p_k substrate rounds by CENTERED cosine between
  the claim's prediction_embedding and substrate.query_embedding,
  centered by `_samskara_centering_mean` (the substrate mean - the
  fire path's register), ordered cosine desc, where centered
  cosine >= p_floor (0.05 initial; re-derived on a labeled
  message-vs-claim probe set before deploy), EXCLUDING: rounds in
  threads reachable from the claim's samskara_provenance rows -
  resolving BOTH provenance paths (substrate: one hop;
  association: provenance -> samskara_associations -> a_id/b_id ->
  substrate; decision 4), rounds whose user_message_id no longer
  resolves to
  a real message row (soft pointers survive deletion; the slice
  could not be judged), (claim, round) pairs already present in
  samskara_backfill_verdicts (crash-retry exclusion, M3), and
  rounds from threads with fewer than 2 user messages (the
  recorded single-round junk-data gate, docs/dev/samskara.md
  "The >=2-user-message gate"). Candidate age >= 48 hours
  (conversations settled before judging - the recorded next-day
  rationale). Invoker-safe with explicit p_user_id (b-strict
  overload pattern).
- RPC `samskara_claim_quarantined_samskara(p_holder_id text,
  p_ttl_seconds int)`: mirrors the sibling claim-RPC shape - polls
  across ALL users (the service-role worker does not pre-enumerate
  users), oldest quarantined row with backfill_attempts < budget
  and claim columns free, `for update skip locked`, stamps the
  claim pair, returns the claim id, user_id (the generic embed
  wiring reads it for the per-user Logs tally), and prediction
  TEXT (not the embedding - vectors read back as strings; the
  candidates RPC re-reads it by id). The save path (fold RPC) only
  commits if the claim still belongs to the caller - the canonical
  guarded save.
- RPC grants: every new RPC (claim, candidates, fold) gets the
  house `revoke all ... from public, anon, authenticated; grant
  execute ... to service_role` block - all are security definer or
  cross-user, and an un-revoked claim or fold RPC would let any
  authenticated caller pass another user's id.
- RPC `samskara_apply_backfill(p_user_id, p_samskara_id, p_held
  uuid[], p_contradicted uuid[], p_not_borne_out uuid[],
  p_not_engaged_count int, p_claim_holder text)`: the uuid arrays
  carry LEDGER ROW ids (derivable to user_message_ids via the
  unique pair). Folds genuine
  verdicts into the SAME tallies via the same discount math as
  samskara_apply_evaluation scaled by w_backfill (0.5): held ->
  confirm += 0.5; contradicted -> disconfirm += 0.5; not-borne-out
  -> disconfirm += w_soft x 0.5; not-engaged counts only toward
  attempts. Advances backfill_attempts by the total attempt count,
  then releases the claim. Guarded on claim holder + expiry. A
  MIRROR-COMMENT pin ties its constants (k, L, d, w_soft) to
  samskara_apply_evaluation's, with a parity TEST asserting it: a
  vitest in tests/ that reads supabase/schema.sql and extracts the
  k/L/d/w_soft literals from BOTH RPC bodies (the schema-grants
  test's file-reading precedent, tests/schema-grants.test.ts:38).
  The plan's earlier "Deno test (the SAMSKARA_POPULATION_CAP
  precedent)" was a misattribution: that precedent pins only a
  TS-side constant's value and asserts nothing about schema.sql.
  The alternative - generalizing the live RPC to take a weight -
  would drop/recreate load-bearing prod SQL and was rejected.
- Activation write path: the gate check (M3 step 6) runs while the
  worker still holds the claim, and the activation itself is a
  direct service-role `update samskaras set activated_at = now()
  where id = $1` (same writer class as the mint writes) performed
  by the holder before releasing - so the matrix's precedence rule
  (only the holder transitions a claimed row) stays honest.
- Fire RPC filter: samskara_fire_top_k gains
  `and s.activated_at is not null`. Quarantined claims cannot fire,
  join cohorts, inflate fire_count, or enter the co-fire graph.
  Placement note: the recorded house pattern is "no health filter
  in the RPC, trim in the application layer" (schema.sql:7848-7852,
  priming/samskara.ts:187-192). Activation is a LIFECYCLE state,
  not a quality signal - the co-fire rationale does not apply -
  and the RPC is the single chokepoint every fire consumer shares;
  application-layer filtering would let any future caller leak
  quarantined rows into cohorts, which is the exact bug quarantine
  exists to prevent. Deliberate divergence, documented here.
- Cap, collapse, and eviction see ACTIVE rows only:
  `corpusAtCap` (venice/agents/samskara.ts:1177-1191) counts rows
  with activated_at not null (the plan's own purpose statement is
  why: quarantined rows are not competing for live-corpus slots).
  The quarantine pool is bounded by mint rate, the worker's drain
  rate, and the 45-day reaper. samskara_collapse_by_cofiring's
  candidate predicates gain the same filter in BOTH passes: the
  overflow pass is evidence-free cosine merging and must never
  merge a quarantined claim (it could absorb an active row and
  stay non-firing, or inherit merged tallies with no ledger
  linkage). Every samskara_evict_for_mint victim tier gains the
  filter too: eviction frees a live-corpus slot for a mint, and a
  quarantined row holds no such slot - evicting one would burn
  earned evidence for nothing.
- samskara_health_snapshot's evictable-pool columns deliberately
  mirror the eviction predicates ("keep them in lockstep" is the
  standing rule) - they gain the activation filter with the tiers.
  The probation-due column mirrors the reaper, which is unchanged,
  and correctly counts quarantined tally-0 rows (they ARE due).
- Compound-summary and intent-agent reads (agents/samskara.ts:1634;
  agents/intent.ts:393,513; schema.sql:9808): the activation filter
  is added to each - the always-on paragraph and the intent-employment
  prompt are priming surfaces (decision 1's guarantee is "no
  priming from a quarantined claim", not just "no fire rows"), and
  a quarantined row's default health 1.0 would rank it at the top
  of the health-ordered summary sample.
- samskara_health_snapshot's total_samskaras (schema.sql:10606)
  gains the same filter: the Health panel feeds that total into the
  compound-regen backlog delta, and quarantine depth would
  otherwise light the panel's warn/alarm headline on a healthy
  pipeline (SamskaraHealthPanel.svelte:105; the module's stated
  purpose is preventing false alarms). The never_fired column's
  reading shifts (normal quarantine mints now count there) - a doc
  note, not a filter.
- Control-draw exclusion: the evaluation sweep's control sample is
  drawn in TypeScript (`sampleControlClaims`,
  samskara_evaluation.ts:351-367), not SQL - the activation filter
  is added to that query (M3's agent work; listed here because it
  is part of the same correctness surface).
- Browser RPC return shapes: the browse/detail UI also renders rows
  from `samskara_search_by_prediction`, `samskara_cluster_corpus`,
  and `samskara_verdict_counts` (src/lib/supabase/samskara.ts:401,
  448,559) - all three gain `activated_at` in their RETURNS TABLE
  (drop-if-exists + recreate), and the search RPC also gains
  `backfill_attempts` (the detail pane renders from `selected`
  whether the claim arrived by list or by search, Samskaras.svelte:
  231), so the releaseStatus derivation and the progress line
  render on every arrival path.

## M2 - EMBEDDER WIRING

Register `query_embedding` as a NEW EMBED_SOURCES entry
`samskara-substrate-query` (_shared/embed-input.ts): the source
contract is one buildInput -> one string -> one vector -> one save
column, so a second output column on the existing source cannot
work (the BackfillDeps.save contract and the claim/save RPC pair
are single-vector). Components:

- Third claim pair on samskara_substrate (M1).
- Claim RPC variant keyed on `query_embedding is null AND the
  round's user message still exists` (soft pointers can point at
  deleted messages; such rounds are permanently un-embeddable and
  must not be re-claimed forever). The claim RPC returns the user
  message TEXT via a join to messages (the text is not stored on
  substrate - only user_message_id).
- Save RPC writing query_embedding only, guarded on the query
  claim pair. The poll predicate also requires the round's user
  message to be non-empty (mirroring the situation gate), so an
  empty round cannot cycle claim -> fail -> re-claim; partial
  index on (user_id, created_at) where query_embedding is null,
  matching the sibling substrate polls (:7404-7406).
- embed-input.test.ts pins the full EMBED_SOURCES name list with
  assertEquals - the new name is added to that pin in the same
  change (the 2026-08 outage's guardrail).

Historical substrate rows drain through the normal backfill poll
(bounded by the worker's per-tick cap). The 2026-08 retrieval-
outage lesson is the reason registration is load-bearing: a missing
EMBED_SOURCES entry fails silently as cross-space cosine noise
(docs/dev/embeddings.md covers the rotation and the registry; the
outage's full causal story - three weeks of dark corpus, held-rate
78% -> 34% - is in docs/dev/samskara.md).

## M3 - THE BACKFILL WORKER

New agent `supabase/functions/venice/agents/samskara_backfill.ts`,
route `/samskara-backfill-sweep`, cron `21 * * * *` (pg_net POST,
house dispatch shape). The cron schedule lands in schema.sql's
cron block (M1's schema changes and the schedule apply together);
the Deploy workflow syncs the schema BEFORE deploying the function
(deploy.yml:51-83, sequential steps in one job), so the first
scheduled POST may 404 harmlessly in the minutes before the
function is live - mints landing in that window are quarantined by
the column default, which is inherently safe. A schema re-apply
during an in-flight tick can transiently fail an in-flight RPC;
TTL expiry plus next-tick re-claim recovers, and the ledger
exclusion prevents re-judging. The frontend (Pages) deploys last
and all RPC return-shape changes are additive, so the cached-PWA
mixed-version window is safe. CLAIMS_PER_TICK = 2 (enough to drain
well ahead of the mint rate, capped spend; headroom math in the
constants block below). Work registered under EdgeRuntime.waitUntil.

Per-claim flow:

1. Claim one quarantined claim (oldest mint first).
2. Retrieve candidates: samskara_backfill_candidates with
   p_k = ATTEMPT_BUDGET (8) - backfill_attempts.
3. If the candidate list is EMPTY and the user has no substrate
   rounds outside the birthplace at all (an existence check on
   rounds joined to live messages - NOT embedding state, which
   lags the deploy): activate immediately (transition 2), release
   the claim, done. If rounds exist but embeddings have not
   drained yet, do nothing this tick - the pool re-opens as the
   embedding poll catches up.
4. For each candidate, in order (highest cosine first):
   - Fetch the exchange slice: the round's user message + its
     assistant reply, plus the adjacent exchange on each side for
     context (the judge's "pointable moment" standard needs a
     quotable transcript; whole threads would multiply tokens for
     marginal evidence).
   - ONE completion: the message layout mirrors the live judge -
     the exchange slice rides as native role turns (same transcript
     rendering the evaluation sweep uses for thread messages), then
     a FINAL user turn carrying the prediction + the verdict
     request (single tag, JSON reply). The framing sentence
     replaces "predictions that were live during the conversation
     above" with a no-provenance equivalent ("Below is a standing
     prediction about the user. Judge how the conversation above
     bears on it, using only evidence visible in the transcript.")
     - the skeptical two-step structure, worked examples, and
     parse defense are unchanged. Reuse parseVerdicts /
     buildVerdictRequest / VerdictKind exported from
     samskara_evaluation.ts, and completeJsonObjectWithMeta for the
     completion (response format, retry, finishReason guard).
   - A Venice error on one candidate SKIPS that exchange (not
     ledgered, not folded; it is eligible again next tick) and
     continues with the rest. A message deleted between candidate
     retrieval and the slice fetch yields an empty slice - same
     skip path.
   - Insert the ledger row FIRST (including not-engaged - every
     judged attempt is ledgered; the candidate exclusion keys on
     ledger rows, so a crash between ledger insert and fold never
     re-judges the same exchange; on-conflict-do-nothing against
     the unique pair, never a throw).
5. Fold the batch via samskara_apply_backfill with the verdict
   arrays (guarded save; the no-claim no-ops are the crash-recovery
   path - the next tick re-claims and the ledger exclusion skips
   judged exchanges).
6. GATE CHECK - every tick, while still holding the claim, using
   LEDGER state for the genuine count (an indexed exists: any
   ledger row for this claim with verdict <> 'not-engaged') and
   attempt state for the budget:
   - Candidates returned fewer than requested (pool exhausted this
     tick) OR attempts now >= ATTEMPT_BUDGET:
     - genuine >= 1 -> set activated_at = now() (transition 1),
       release, done.
     - genuine = 0 -> PIN backfill_attempts = ATTEMPT_BUDGET and
       release. The row leaves the claim queue permanently (the
       claim RPC's attempts < budget predicate drops it) and the
       45-day reaper collects it (transition 4). Without the pin,
       a never-engaging row is re-claimed every tick and starves
       the queue's 2 slots for up to 45 days.
   - Candidates remain and budget unspent -> release normally; the
     row is re-claimed next tick.

The ledger (not the tallies) is the gate's evidence source because
the ledger is written first: a crash in the insert-to-fold window
loses tallies but not ledger rows, so the gate still sees genuine
engagement and activates correctly. Reading tallies instead would
let a genuinely-engaged claim pin out of the queue and die at the
reaper on its ledger-proven evidence.

Constants (initial values; the floor gets a labeled probe set
before deploy): ATTEMPT_BUDGET = 8, candidate floor = 0.05
centered cosine (substrate-mean register), w_backfill = 0.5,
exchange context = +-1 adjacent exchange, candidate age >= 48h,
CLAIMS_PER_TICK = 2 (drains 48 slots/day against a measured
~7/day mint rate - 49 mints/week, docs/dev/samskara.md:1610; the
2026-10 vetting observed 9 mints in a 48-hour burst (owner
datum), so headroom covers bursts), claim TTL = 900s (worst tick
is 2 claims x 8 BIG_WINDOW completions; the TTL must outlive it so
a concurrent tick cannot claim a row mid-batch).

## M4 - SURFACES

- Health panel + detail pane: a quarantined claim renders in the
  EXISTING releaseStatus axis (the detail-pane status line at
  Samskaras.svelte:231 - NOT a new list-row badge mechanism), with
  a PRECEDENCE RULE: the QUARANTINED check comes FIRST, ahead of
  the existing genuine > 0 / probation branches - backfill tallies
  sit in the same columns the probation branch reads, and
  samskara_verdict_counts reads fires only (schema.sql:10545), so
  without the precedence a mid-flight row falls through to the
  probation copy and predicts a reaper release the tallies immunize
  against (the drift samskara-browse.ts's own lockstep warning at
  :202-214 names). Rendered as "warming up" (decision 8) with a
  progress line rendered as one fused string,
  "warming up - n of 8 exchanges judged" (the denominator is
  ATTEMPT_BUDGET; the never-engaged pin's copy is decision 8's
  second string). Backfill evidence
  is deliberately NOT rendered as per-verdict rows in the verdict
  list (that list stays fires-only) - the progress line is the
  user surface, the ledger is the audit surface (decision 3). The
  browse select list (src/lib/supabase/samskara.ts:366,428) gains
  activated_at + backfill_attempts.
- samskara_health_snapshot gains a quarantined count and a stuck-
  backfill-claim metric (claim held past its expiry - the house
  leak detector pattern, schema.sql:10692-10699). Thresholds: the
  stuck metric mirrors the existing stuckClaims bands; the
  quarantined count is informational, never thresholded.
- docs/dev/samskara.md: the "Health: the verdict posterior" and
  formation-side sections gain the quarantine stage and the
  backfill worker, plus four prompt-lens notes: the not-borne-out
  asymmetry (a slice gives one chance per exchange vs a thread's
  many, so backfill soft misses are weaker evidence than live ones
  - w_backfill scales uniformly and M5's agreement readout is the
  guard), the truncation-bias direction (a pointable moment just
  outside the slice biases toward not-borne-out/not-engaged), the
  raised situation-arose base rate from similarity retrieval (STEP
  1's skeptical default becomes the main precision control), and
  the never_fired snapshot reading. The stale "bge-m3" comment on
  situation_embedding is swept (local-embed.ts:14-21 is the
  authority); Interactions ledgers updated (embeddings, evaluation
  sweep, eviction, fire path).
- docs/user/samskara.md: the observable behavior - new claims do
  not influence replies immediately; they warm up against history
  first; the detail-pane status line.
- src/lib/supabase/types/samskara.ts: the row types gain
  activated_at, backfill_attempts, and the claim columns - M4's
  browser work consumes them.
- New QA use case: docs/qa/use-cases/samskara-backfill.md. It is
  the LOAD-BEARING guard, not a nice-to-have: schema RPCs have no
  automated test net in this repo (no SQL test harness exists -
  verified), so the use case must cover: forge a quarantined
  claim, seed substrate query embeddings, run the sweep route with
  the service-role JWT, assert ledger rows and fold weights,
  activation gate both branches, birthplace exclusion (both
  provenance paths), zero-candidate exception, stuck-row pinning
  (pool exhausted, zero genuine), the grandfather marker firing
  exactly once across two re-applies, AND the UI states (detail-
  pane warming-up status with the precedence rule, progress line,
  health panel quarantined count and regen delta).

## M5 - READOUTS

- Agreement: for claims with >= 1 backfill genuine test and later
  live genuine tests, P(live verdict agrees with backfill verdict).
  This is the signal-validity gate: if backfill verdicts do not
  predict live verdicts better than chance, the mechanism measures
  the judge's mood, not the claim, and gets retired.
- Throughput: activation rate per week, quarantine pool depth,
  attempts per claim, not-engaged share, p0 drift (backfill
  evidence moves the population prior - decision 3's reduced
  weight is the only moderator; and because a batch of 8 folds in
  ONE discount event where the live path discounts per judged
  thread, backfill evidence ages more slowly per verdict - watch
  both in the drift readout).
- Precision side-effect: live fire not-engaged share for
  backfill-activated claims vs grandfathered claims (does an
  evidence-backed claim fire more precisely?).
- Cap inputs: population now decomposes into quarantined / active
  (the matrix's two living states), with genuine-test counts from
  the ledger - the data the cap revisit consumes.

## GOTCHAS AND PREMISE LEDGER

- The grandfather marker (app_config row) is the deploy-blocking
  premise. The plain `where activated_at is null` form re-runs on
  every schema re-apply and would activate every new quarantined
  mint - silently disabling the whole feature. The marker form is
  provably one-shot.
- The 0.30 fire-ramp knee is NOT a candidate floor (message-vs-
  claim centered cosine tops out at 0.299; a 0.30 floor returns
  zero candidates and transition 2 then activates everything,
  silently disabling quarantine). Candidate selection is top-k by
  rank above a low floor. The existing probe set cannot calibrate
  it (claim-pair register); a new message-vs-claim labeled set is
  required before deploy.
- The candidates RPC uses `_samskara_centering_mean` (substrate
  mean) - the same register as the fire path. Using the claim mean
  would invalidate the floor and misstate "would have fired."
- A fully not-engaged backfill leaves tallies zero: the claim can
  never activate and dies at the 45-day probation reaper. That is
  the intended death; the ledger records the not-engaged history
  for debugging. No new reaper is built (decision 7).
- Fires are NEVER written for backfill attempts: fire_count stays
  "live fires", the co-fire graph stays behavioral, collapse is
  untouched. The backfill ledger table is the only record.
- Dedup-reinforce at mint time may hit a quarantined claim
  (geometry ignores activation). samskara_reinforce_existing bumps
  health only - it writes no tallies and is not a claim-guarded
  save (schema.sql:10020-10023) - so a health bump on a non-firing
  row is invisible and harmless; it does not activate, does not
  affect the gate arithmetic, and cannot immunize the row against
  the 45-day reaper (tallies stay zero). The only tally writers
  are apply_evaluation (ACTIVE rows - only fired claims are
  judged) and apply_backfill (QUARANTINED rows): disjoint row
  sets, so no concurrent-tally-writer window exists beyond the
  house pattern's.
- Backfill evidence shifts p0 (samskara_population_p0 sums all
  tallies, schema.sql:9230-9239). Accepted: reduced weight is the
  class distinction's carrier; M5 watches the drift. Excluding
  quarantined rows from p0 was rejected - it would split the
  posterior's calibration surface by lifecycle state.
- Centered cosine uses the LIVE substrate mean, which drifts as
  the corpus changes: "would have fired" is evaluated against
  today's centering, not the historical day's. Accepted; noted for
  the readout.
- Crash window between the ledger inserts (step 4) and the batch
  fold (step 5): the ledger rows exist but the fold did not commit
  - up to ONE BATCH (8 verdicts) of tallies can be lost per crash,
  not one verdict; attempts can also lag the true ledger count, so
  total completions may exceed ATTEMPT_BUDGET. Accepted: the gate
  reads the ledger, so activation is unaffected by the tally loss;
  the ledger keeps the record; single-user stakes make the rare
  event cheap. The alternative - fold-per-exchange - multiplies
  the guarded-save round trips 8x.
- "157 live rows" in decision 5 is an owner datum from the
  2026-10-25 deployment census, not a repo-verifiable number.

## WHAT THIS PLAN REPLACES

- The "backfill" sketches in the 2026-10-26 cap conversation
  (this document is their resolution).
- Nothing else: the cap, mint gates, eviction tier definitions,
  and the lifecycle plan's milestones M1/M2/M4 are untouched. The
  lifecycle plan's decision 6 (cap parked) now reads THIS plan's
  M5 as additional input.
