# Intents (in progress)

> **Status: feature complete; the backtest's real-corpus
> harness remains unbuilt, blocked on both data volume and a
> metric decision.** The sole user has been opted in since
> 2026-06-25, with ~1 month of data accrued (6 intents, 11
> target samples, 167 employments as of 2026-07-29). The
> backtest needs 20 control-bearing movement windows; the
> corpus carries 7, so a verdict is 2-3 months out at the
> current weekly sampling rate.
> **Next check-back: late October 2026** (roughly 13 weeks
> from the 2026-07-29 anchor, when the two long-running
> targeted intents should carry ~20 windows combined). If the
> metric decision is still unresolved by then, the data
> accrual is wasted on the wrong metric - resolve it first. The June 2026 prod inspection
> predicted samskara fire-count volatility would dominate the
> signal; the July 2026 data confirms it (target values swing
> 0-34 across consecutive weekly samples while controls stay
> flat at 4.6-5.5). The metric decision - whether to keep
> fire-count, normalize by trailing baseline, lengthen the
> window, or switch to samskara verdicts - should come before
> building the backtest SQL, because changing the metric
> changes what intent_target_samples records and thus the
> query shape. The metric decision deadline is the
> check-back in late October 2026 - data accruing after
> that point on the wrong metric is wasted. A target-pair dedup bug was also found and
> fixed: the minter could seat two active intents on the same
> (target_kind, target_ref, target_direction) by rephrasing
> the statement, which the statement-only dedup didn't catch.
> The feature ships **off by default** and stays off-by-default
> until the backtest clears its falsifiable bar. This doc
> records the design decisions plus the evaluation plan; the
> Build status below is the live ledger of what exists. When
> the remaining pieces land and the work closes, graduate the
> durable parts into a permanent `docs/dev/intents.md` and
> retire this file per the in-progress doc rules in
> `CLAUDE.md`.

**Build status.** Landed so far:

1. The pure honest-loop math core
   (`supabase/functions/_shared/intent-math.ts`) - sample
   classification against a matched control, the efficacy
   posterior, the population baseline, and the two backtest
   kernels (efficacy/employment correlation, matched-control
   lift) - with full vitest coverage
   (`tests/intent-math.test.ts`).
2. The storage layer in `supabase/schema.sql` (the `intents`
   section at the end of the file): all five tables below with
   RLS, indexes, and `auth.uid()` defaults, mirroring the
   samskara/bias table families. Applied to the linked project
   on the next merge-to-main via the deploy's `sync-supabase`
   job; the table columns match the Data model section below.
3. The pure injection renderer
   (`supabase/functions/_shared/intent-format.ts`) - the
   "Working intentions" system-prompt block, with the
   dispositional-lean framing and the explicit user > accuracy
   > intents precedence baked in - plus full vitest coverage
   (`tests/intent-format.test.ts`). This is the pure half of
   injection; the server orchestration that calls it (an
   `applyIntentPriming` in `venice/priming.ts`, gated on the
   toggle, computing the bias-aware combined cap) is Deno and
   lands with the pipeline.
4. The pure minting proposal processor
   (`supabase/functions/_shared/intent-mint.ts`) - the trusted
   boundary that coerces, validates, dedups, and caps the
   minter agent's raw proposals into a deterministic `MintPlan`
   across the four portfolio verbs (create / retire / dormant /
   revive) - plus full vitest coverage
   (`tests/intent-mint.test.ts`). Enforces the mechanical
   invariants (coherent target bindings, status-transition
   legality with retire > dormant > revive precedence,
   exact-after-normalize dedup where dormant blocks a twin but
   a PRIOR-sweep retired statement is free to re-form, active-set
   cap trimming low-priority creates). A verbatim same-sweep
   retire+recreate (the minter re-wording nothing) is collapsed
   to no change - the retire is cancelled and the duplicate
   create dropped - so it can never leave a tombstone next to an
   identical active twin. See **Gotchas - same-sweep churn**.
5. The minter agent core (`venice/agents/intent.ts`) - the
   judgment-shaping system prompt, the payload builder, and the
   response parser - pinned by a Deno suite
   (`supabase/functions/tests/intent.test.ts`).
6. The minting sweep orchestration (also `venice/agents/intent.ts`,
   `runIntentMintSweep`) plus its coordination schema in
   `supabase/schema.sql` (`intent_mint_runs` + the
   `intent_mint_claim_next_user` / `intent_mint_finish` RPCs +
   the daily `nak-intent-mint-sweep` cron) and its route in
   `venice/index.ts`. Drains due users, gathers the descriptive
   layer + portfolio, runs the minter, validates via
   `processMintProposals`, applies the plan (create + provenance,
   status sets), and stamps the run. Type-checked through the
   full venice graph by `functions-check`; the DB I/O itself is
   review-verified only (no live DB here). v1 gather feeds
   intents+employment, samskara compound + top samskaras,
   surfaced biases, and the user's enabled system prompts +
   recent memories; wiki articles and per-thread summaries are a
   deliberate follow-up.
7. Efficacy evaluation, folded into the same daily per-user pass
   (`evaluateTargetedIntents` in `venice/agents/intent.ts`, run
   FIRST so the minter prunes on fresh scores). For each targeted
   active intent it reads the current descriptive-layer metric +
   a matched control, appends an `intent_target_samples` row, and
   folds the movement-vs-control into the efficacy posterior via
   `stepEfficacy`. The control-cohort logic (`biasTargetMetric` /
   `samskaraTargetMetric`) is pure and Deno-tested; the math step
   is vitest-tested. Per-intent sampling is gated to
   `SAMPLE_INTERVAL_DAYS` (weekly) because bias posteriors move
   too slowly for daily deltas to clear the deadband. This is the
   only writer of `intents.efficacy`.
8. The server-side priming orchestration (`applyIntentPriming`
   in `venice/priming.ts`): gated on the `intentsEnabled`
   toggle, reads active intents, renders the block under the
   bias-aware combined cap, appends it to the row-0 system
   message SEQUENCED after the bias appendix (they share the
   row, so concurrent mutation would race), and snapshots the
   rendered ids into `threads.intent_active_at_turn` for
   employment classification. Wired into `runServerPriming` and
   pinned by a sequencing test;
   [`prompt-augmentation.md`](../prompt-augmentation.md) updated.

9. The settings toggle (`profiles.settings.intentsEnabled`,
   default OFF) wired through the type + `coerceSettings` +
   `updateSettings` patch, the app-state seed/reset/setter +
   `persistIntentsEnabled`, and a "Working intentions" control
   in the Settings AI pane. Plus the user doc
   (`docs/user/intents.md` + README link). This is the switch
   that activates the whole pipeline; until a user flips it on,
   everything above stays inert.
10. The inspector - the read-only "surfaced" surface. A
    seedling pill (the `intents` entry in the shared
    diagnostic-pill column, `src/lib/ui/diagnostic-pills.ts`,
    rendered on both the desktop column and the mobile wharf by
    `src/components/DiagnosticPills.svelte`) opens a modal
    (`src/screens/Intents.svelte`, route `modal: 'intents'`)
    that lists the user's intents grouped active / paused / let
    go, each with its target, an honest efficacy read, and the
    rationale. The modal is SHARED with the follow-ups feature
    (see `docs/dev/followups.md`): the pill is always present
    (follow-ups exist for every account), and the
    working-intentions section renders only when
    `app.intentsEnabled` - the toggle gates the section and the
    pill copy, no longer the pill's presence. All intents logic
    is in the tested primitives
    (`src/lib/ui/intents-inspector.ts`); the data read is
    `listIntents()`, fetched only when the toggle is on. No
    write controls - the minter owns the set.
    A retired intent whose statement matches a still-live (active
    or dormant) one is suppressed from "Let go" and the live card
    is flagged "reconsidered" (`reformedIds` + `REFORMED_NOTE`),
    so a goal Nak let go and later re-formed reads as a revival,
    not a duplicated sentence across two sections.
11. Employment classification - the settled-thread judge
    (`venice/agents/intent_employment.ts`,
    `runIntentEmploymentSweepTick`) that reads each settled
    thread whose `intent_active_at_turn` snapshot is non-empty
    and records, per active intention, what happened with it
    (opening / acted / reaction) into `intent_employments`.
    Mirrors the bias analyze phase: per-thread claim
    (`intent_employment_claim_next_thread`, toggle-gated +
    day-gated), save under the message-count guard
    (`intent_employment_save`), independent claim columns on
    `threads`, hourly `nak-intent-employment-sweep` cron, route
    in `index.ts`. Pure prompt + parser Deno-tested. This is the
    minter's pruning telemetry and feeds the gather it already
    reads - and is NEVER an efficacy input (the firewall).
12. The backtest aggregator
    (`supabase/functions/_shared/intent-backtest.ts`,
    `runBacktest`) - the corpus-level verdict (matched-control
    lift + the efficacy/employment firewall correlation + a
    data-volume floor) over the kernels, Deno-tested on
    provisional fixtures (refresh tracked as a scheduled
    operator follow-up). The
    DB-reading harness that feeds it a real corpus is the one
    remaining piece, blocked on field data.

Not yet built: the DB-reading half of the backtest harness.
The sole user has been opted in since 2026-06-25 and data is
accruing (7 control-bearing movement windows as of
2026-07-29, against the 20-window bar), but the metric
decision (see "What the June 2026 prod inspection taught the
backtest" below) should come before the SQL, because changing
the metric changes what intent_target_samples records. The
pure verdict logic exists and is tested; only the real-corpus
query and the data-derived thresholds remain. The sections
below document the design and the realized behavior.

Intents are the first layer in nak that is **normative**
rather than descriptive. Every other user-model the app
builds - samskara (predictions), bias profile (observed
tendencies), memories, wiki - *describes* the user. An intent
is a self-authored standing goal the chat model forms *about
how it wants to help the user grow*: "help them notice when
they're seeking confirmation rather than testing a belief,"
"lean on their strength at reframing when they're stuck." It
is the line between nak-as-recorder and nak-as-participant.

That shift carries an ethical weight the descriptive layers
do not, and the design is shaped around containing it. See
**The normative asymmetry** below before changing anything
about visibility or efficacy.

## Decisions already settled

These came out of design discussion and are not open
questions; they are the constraints the rest of the doc
builds on.

1. **Surfaced, not steerable - the samskara parallel.**
   Intents are inspectable in a debug surface (a pill +
   modal/tab, like the bias profile's diagnostics modal and
   samskara's mood modal), but they are NOT user-editable
   controls. They are emergent internal state, same contract
   samskara already run under. The user can see what the
   model is working toward; they cannot hand-author or
   directly delete an intent any more than they can
   hand-author a samskara.

2. **The efficacy model is "C" (split employment from
   efficacy).** See **The C efficacy model**. The retrospective
   agent records *employment* (what the model did, whether it
   got an opening, how the user reacted) as neutral process
   telemetry. *Efficacy* (the health posterior that decides
   whether an intent strengthens or retires) is measured by
   movement in the descriptive layer the intent targets -
   never by the model's own read of how it went. The model
   structurally cannot grade its own homework.

3. **Injection rides the bias-appendix path, not the
   `<think>` chain.** Intents are standing behavioral guidance
   ("here is what I'm working toward with this person"), the
   same shape as bias compensation guidance - not
   internal-monologue state. So a capped, rendered appendix on
   the row-0 system message, assembled server-side in the
   priming stage alongside `applyBiasPriming`. See
   `prompt-augmentation.md` - this adds a row-1 (baseline
   system) contributor, NOT a new `<think>` block.

4. **Gated behind a settings toggle, off by default.** A new
   AI-pane (or its own pane) toggle persisted to
   `profiles.settings`. When off: no minting, no injection, no
   evaluation - the whole pipeline is inert. See **Settings**.

5. **No topic restriction on what an intent may target.** The
   minter may form intents about anything the descriptive layer
   surfaces, including emotionally sensitive / shadow-work
   material (self-worth, grief, relationships). The alternative
   - fencing the minter to lighter cognitive/behavioral ground
   until the loop is proven - was considered and declined; the
   original "help the user navigate growth and shadow work"
   vision is the point. The brakes that contain this are
   subject-agnostic (visibility, dispositional framing, the
   user-instruction precedence, the honest loop), so they hold
   regardless of topic. "Never clinical, never diagnostic,
   supportive-dispositional" stays as prompt hygiene, not as a
   topic gate.

6. **Free will means the ability to abandon.** The minter is
   not append-only with a hard cap (that is hoarding until
   full). It actively reconsiders: an intent whose lever is not
   landing or whose pattern has gone quiet is *paused*
   (dormant), one that is genuinely done is *retired*, one
   worth retrying is *revived* - possibly re-framed. The four
   verbs (create / retire / dormant / revive) are the portfolio
   vocabulary that makes "deciding something is not working" a
   real action. Dormancy also prevents churn: a paused intent
   still exists, so the dedup blocks the minter from
   re-proposing the same goal the next day. See **Minting**.

## The normative asymmetry

Samskara are descriptive, so "visible but not steerable" is
ethically free: there is nothing to consent to in a
prediction. Intents are normative, so the same UI means the
user can watch the model pursue an agenda about their life
without a brake. Two things contain this, and both are
load-bearing - do not weaken either without re-opening the
discussion:

- **Visibility is the anti-covertness guarantee.** An intent
  in an inspectable tab is not a covert manipulation; the
  user can see exactly what the model is trying to do to
  them. The inspector copy must therefore be honest about the
  *goal*, not just the existence of the intent - it states
  "I'm working toward X with you," not a euphemism.
- **The honest loop is the anti-self-justification
  guarantee.** Because efficacy reads the descriptive layer
  and not the model's self-assessment, an intent cannot
  manufacture its own evidence of working. This is the same
  discipline the bias math uses against the observer agent's
  own biases, applied to the normative layer. The shadow-work
  use case is exactly where self-confirmation would be most
  seductive and most damaging, which is why the loop is built
  this way and not the flexible-but-self-graded way.

The implicit user veto is the same one samskara have: the
patterns decay when unfed, and the user can always push back
in conversation or (via the same affordance samskara will
eventually get) retire state they reject.

## Role in the app

An intent is a one-or-two-line first-person goal statement
with provenance (what seeded it), an optional descriptive-layer
**target** binding, an efficacy posterior (only when a target
exists), and a status (active / dormant / retired). A small
active set (cap ~3-5, mirroring the bias `RENDER_CAP` of 4)
renders into the system prompt every turn as standing guidance.

Everything that forms, scores, and retires intents runs
server-side on the existing background-job fleet. Nothing
needs a tab open. Three pipelines, all parallel to mechanisms
that already exist:

- **Minting** - a daily per-user cron sweep reads the
  descriptive layer (samskara compound + summary, bias
  summary, memories, wiki, recent settled threads) and
  creates / updates / retires intents. Parallel to the
  memory-librarian and wiki-librarian daily passes.
- **Injection** - the priming stage renders the active set
  into the system prompt. Parallel to `applyBiasPriming`.
- **Evaluation** - a next-day retrospective agent processes
  settled threads (same 2-round + prior-calendar-day gate as
  the samskara evaluation sweep and reflection) to write
  *employment* records, and a separate descriptive-layer
  sampler appends *efficacy* time-series points. Parallel to
  `samskara_evaluation.ts`.

## Data model

Built - see the `intents` section at the end of
`supabase/schema.sql`. All tables RLS-scoped to
`auth.uid() = user_id`, all `create table if not exists`, all
policies drop-then-recreate per the schema idempotency
convention. Mirrors the samskara/bias table families.
Provenance and target-samples are append-only (no UPDATE
policy); the rest get full CRUD.

### `intents`

The unit.

- `id uuid primary key default gen_random_uuid()`.
- `user_id uuid` (FK to `auth.users`).
- `statement text not null` - the first-person goal the
  minter wrote ("help them notice when ...").
- `rationale text` - why the minter formed it; shown in the
  inspector.
- `status text check in ('active', 'dormant', 'retired')`.
  Active = renders + scored. Dormant = kept but not rendered
  (e.g. its seeding pattern has gone quiet but not long enough
  to retire). Retired = tombstoned, kept for the inspector's
  history, never rendered.
- **Target binding** (the heart of efficacy model C):
  - `target_kind text check in ('bias', 'samskara', 'none')`.
  - `target_ref text` - the bias catalog key (for `'bias'`)
    or the `samskaras.id` (for `'samskara'`). Null for
    `'none'` (free-form).
  - `target_direction text check in ('reduce', 'reinforce')`.
    Which way "better" runs for this target.
- `efficacy real` / `confidence real` - the posterior. NULL
  for free-form intents (no target -> no honest signal -> no
  posterior). See **The C efficacy model**.
- `last_minted_at`, `created_at`, `updated_at`, plus claim
  columns if the minter needs per-row coordination (likely
  per-user, not per-intent - see Minting).

### `intent_provenance`

Audit of what seeded each intent. Direct analog of
`samskara_provenance` - kept even if the referenced row is
later deleted (no FK on `ref_id`); debugging beats
normalization.

- `intent_id` (FK on cascade), `user_id`,
  `kind text check in ('samskara', 'bias', 'memory',
  'wiki', 'thread')`, `ref_id uuid` (or text for the bias
  key), `weight real default 1.0`.
- Primary key `(intent_id, kind, ref_id)`.

### `intent_employments`

The retrospective *process* telemetry. One row per (intent,
settled thread) where the evaluation agent judged the model
acted on the intent. **Neutral - never feeds efficacy.** This
is the part that lets us answer "is the model actually using
its intents" without letting the answer leak into "are they
working."

- `id`, `user_id`, `intent_id` (FK on cascade),
  `thread_id` (FK on cascade).
- `acted boolean` - did the model get an opening and take it.
- `opening boolean` - did the conversation even present a
  chance (distinguishes "no opening" from "opening missed").
- `user_reaction text check in ('receptive', 'neutral',
  'resistant', null)` - how the user responded, three-state +
  null like `bias_reactions.was_confirmed`. Recorded as
  *observation only*; explicitly NOT an efficacy input (see
  Gotchas - "engagement is not efficacy").
- `reasoning text not null`, `created_at`.

### `intent_target_samples`

The efficacy time-series. One row per (intent, evaluation
cycle) capturing the targeted descriptive-layer metric's value
at that time, plus the matched-control value. **This table is
what makes the feature provable** (see Evaluation) - without a
time series we cannot distinguish a real decline from
regression to the mean, and cannot compute "faster than
control."

- `id`, `user_id`, `intent_id` (FK on cascade).
- `sampled_at timestamptz`.
- `target_value real` - the targeted metric at sample time.
  For a bias target: the `bias_summary.posterior_mean` (or
  `ci_lower`) for `target_ref`. For a samskara target: the
  fire-frequency / fire-score of the targeted prediction over
  a trailing window (see below).
- `control_value real` - the same metric averaged over a
  matched cohort that is NOT an intent target (comparable
  biases / comparable-valence samskaras). The counterfactual
  baseline.
- Null `control_value` is allowed when no comparable cohort
  exists yet; the row still records `target_value` so the
  series is unbroken.

### `intent_compound_summary`

Cached rendered prose, one row per user, the always-on block
injected into the prompt. Direct analog of
`samskara_compound_summary` - per-row regen claim so multiple
devices coordinate instead of duplicating the render.

- `user_id uuid primary key`, `summary text`,
  `intent_count_at_regen int`, `last_regen_at timestamptz`,
  `regen_claim_holder text`, `regen_claim_expires timestamptz`.

## The C efficacy model

This is the load-bearing design choice and the part most
likely to be subtly wrong. The rule: **the intent layer only
reads descriptive-layer signals; it writes none of them.** Bias
posteriors come from the bias sweep; samskara fire verdicts
come from the samskara evaluation sweep. The intent layer
cannot fake the numbers that judge it.

Three target kinds, three efficacy treatments:

- **Bias target** - `{kind:'bias', ref:'confirmation_bias',
  direction:'reduce'}`. Efficacy = movement in that bias's
  `bias_summary` posterior over the intent's life. For
  `direction:'reduce'`, a falling posterior is a confirm; a
  rising one is a disconfirm; flat is a soft miss. The
  posterior is already recency-decayed and CI-gated by the
  bias math, so the signal is conservative by construction.

- **Samskara target** - `{kind:'samskara', ref:<samskara_id>,
  direction:'reduce'|'reinforce'}`. The subtle part:
  efficacy is NOT samskara `health`. Health measures
  *prediction accuracy* - a negative behavioral pattern can
  stay perfectly predictable (high health) while the user is
  actively improving. Using health would reward the intent
  for making the model better at predicting the behavior it
  is supposed to be reducing. Instead, efficacy =
  movement in the **fire frequency / fire score** of the
  targeted prediction over a trailing window, read from
  `samskara_fires`. "The pattern shows up less" is the honest
  signal for a reduce-intent; "the pattern shows up more
  reliably" for a reinforce-intent.

- **Free-form** - `{kind:'none'}`. No measurable target ("help
  them build a healthier relationship with food" has no
  structured metric, only conversation). These get employment
  records but **no efficacy posterior**. They persist while
  their seeding pattern persists and fade when the minter no
  longer re-seeds them - decay by absence, not by self-graded
  success. This is the deliberate graceful-degradation case:
  free-form intents are allowed to exist but are never allowed
  to claim they work.

Posterior math (built: `intent-math.ts` `classifySample` +
`updateEfficacy` + `stepEfficacy`): the samskara
verdict-posterior shape - a recency-discounted hit rate with a
population-prior shrinkage, recomputed online from the
`intent_target_samples` deltas. A sample whose target moved the
right way RELATIVE TO ITS CONTROL is a confirm; wrong way a
disconfirm; flat a soft miss (fractional, like samskara's
`not-borne-out` `w_soft`). The constants are LAUNCH PLACEHOLDERS,
clearly marked in the module; the backtest derives the real
values - they are not yet data-fit.

## Minting

The pure proposal processor is built
(`supabase/functions/_shared/intent-mint.ts`,
`processMintProposals`): it is the trusted boundary that turns
the agent's fallible raw output into a deterministic plan over
the four portfolio verbs - coercing/validating each create,
dropping incoherent target bindings, deduping by normalized
statement (dormant blocks a twin, retired does not), resolving
status-change legality and precedence, and capping the active
set (trimming low-priority creates, never existing intents). It
deliberately does NOT judge semantic conflict with bias
compensation or the user's system prompts - that is the
agent's job (it is handed both in its prompt); a pure function
cannot read intent.

Built (Deno): the minter agent core in
`venice/agents/intent.ts` (prompt, payload builder, parser,
Deno-tested) and the sweep orchestration
(`runIntentMintSweep` + the `intent_mint_runs`
coordination table, the claim/finish RPCs, the daily
`nak-intent-mint-sweep` cron, and the route). The DB I/O is
review-verified only - no live DB in this environment. Daily
per-user cron, parallel to the librarian passes. The minter
agent (fast model, like the samskara/bias agents) reads:

- samskara compound summary + the top samskaras by health,
- `bias_summary` (the soft+strong tier rows),
- the existing intents WITH their efficacy posteriors and
  recent employment records (what it has been trying, and
  whether the levers are landing - this is what lets it decide
  to pause or abandon, not just add),
- recent memories + relevant wiki articles,
- recent settled threads (with read tools, like the wiki
  agent).

It then proposes a portfolio plan - create / retire / dormant /
revive - against `intents`, respecting the active cap. An
intent that targets a bias or samskara records that binding;
one that can't name a measurable target is minted free-form.
Provenance rows capture what it read. Because it sees efficacy
and employment, a daily run is as much pruning as adding: a
low-efficacy intent whose situations keep arising (the lever is
wrong) gets retired or re-framed; one whose pattern has gone
quiet gets paused. The cap and the once-a-day cadence are the
rate limit - nothing rotates continuously, same discipline as
the samskara phases.

## Injection

The pure renderer is built
(`supabase/functions/_shared/intent-format.ts`,
`formatIntentsBlock`): it filters to active rows, caps at a
caller-supplied bias-aware budget, and emits the "Working
intentions" block with the dispositional-lean framing and the
explicit user > accuracy > intents precedence. Returns null to
mean "omit the section" (the bias/samskara null convention).

Built (Deno): in the priming stage
(`supabase/functions/venice/priming.ts`), `applyIntentPriming`
gates on the toggle, reads the active `intents` rows, computes
the intent cap as
`min(INTENT_RENDER_CAP, COMBINED_APPENDIX_CEILING - biasRendered)`,
calls `formatIntentsBlock`, and appends the result to the row-0
system message with the same blank-line separator
`applyBiasPriming` uses - rendered AFTER the bias block, run
SEQUENCED after `applyBiasPriming` (they share the row, so
concurrent mutation would race) so the precedence note's
"guidance above" resolves. Same failure contract as every
priming injector: swallow errors, omit the block, never block
or delay a turn. It also snapshots the rendered ids into
`threads.intent_active_at_turn` for employment classification.

Per `prompt-augmentation.md` (contributors table updated), this
is a new **row-1 (baseline system appendix)** contributor
sitting alongside the bias appendix. It is NOT a `<think>`
block - intents are stable standing guidance, not volatile
per-turn synthesis.

### Appendix budget and conflict

Two distinct hazards live where the intent appendix meets the
bias appendix on row-1. The second is the load-bearing one.

**Budget (the mild hazard).** Bias caps its compensation
bullets at `RENDER_CAP` (4) because more than four behavioral
rules "crowd out the actual instruction surface" (see
`bias-profile.md`). Intents add their own ~3-5. Treat the two
as **one shared ceiling (~6), not two independent caps**, so a
second feature doesn't silently double the total guidance load
past the point bias already found the ceiling to be. Intents
yield to bias when both are full: bias is evidence-backed,
intents are aspirational.

**Conflict (the real hazard).** Unlike two descriptive
features, bias compensation and an intent can issue *opposing*
behavioral directives in the same prompt. Three kinds, worst
first:

1. **Intent vs. the user's explicit system prompts.** The user
   set "just answer, don't coach me" and an emergent intent
   wants to coach. This is NOT a tie to break - the user's
   stated instruction always wins. An intent that fights an
   explicit user wish IS the "agenda without a brake" failure
   the whole design exists to contain. The minter must never
   seat an intent that contradicts the user's system prompts,
   and render-time precedence puts user instructions above
   everything emergent.
2. **Intent vs. bias compensation.** Bias says "name a
   contrary view, introduce doubt about overconfident claims";
   an intent aimed at building self-trust says "affirm their
   capacity to decide." Opposite pulls, same prompt.
3. **Intent vs. intent.** The active set could hold "help them
   sit with discomfort" and "help them stop ruminating and
   act."

Resolution, mostly via framing altitude:

- **Render intents as dispositional leans, not turn commands.**
  Bias compensation is an in-the-moment imperative ("do this
  *this turn*"). Phrase intents as "when it's natural, incline
  toward X" so they shade the model's default stance instead of
  issuing a competing order. A bias imperative and an intent
  lean then coexist - the model names the contrary view AND
  does it in a way that affirms the user's capacity, a richer
  behavior rather than a contradiction. Most apparent conflicts
  dissolve here. This makes the rendered phrasing of an intent
  load-bearing, not cosmetic.
- **The minter owns coherence at formation.** It already reads
  the bias summary and the user's system prompts as seeding
  inputs, so "do not form an intent that contradicts active
  compensation or the user's explicit instructions" is an
  explicit minting constraint. Conflicts are cheapest to
  prevent at birth, by the one agent that sees both layers.
- **Explicit precedence in the rendered block** for residual
  cases: user instructions > bias compensation > intents.
  Stated, not implied by ordering (the prose-ordering
  precedence the `<think>` chain relies on is too weak for
  directives that actively oppose each other).
- **Intent x intent**: the minter owns the active set, so it
  should not seat two directly-opposing intents. If growth
  genuinely pulls both ways, that is ONE intent about holding
  the tension, not two fighting ones.

## Evaluation: how we know it works

The product question that gates this feature: given an
existing samskara corpus and existing bias findings, how do we
know the algorithm and implementation choices are effective,
before we trust them and before we ever default the toggle on?

### The trap: regression to the mean

The failure mode that would make this *look* like it works
when it doesn't. A bias posterior spikes (a noisy stretch of
threads). The minter sees the spike and forms an intent
targeting it. The bias reverts on its own - because spikes
revert. The intent claims the win, its efficacy climbs, it
strengthens, and we congratulate the machine. The honest-loop
firewall does NOT catch this: the movement is real; the
*attribution* is fake. This is the confirmation engine
relocated from self-grading to false causal credit.

### The bar: beat a matched control

The single metric that separates real from theater. Do
bias/samskara targets that received an intent decline faster
than comparable targets that did NOT? `intent_target_samples`
carries both the target series and the matched-control series
precisely so this is computable. **Falsifiable bar, committed
up front: if targeted patterns do not beat matched controls
within N evaluation cycles, the feature stays off by default
and is labeled experimental.** Stating this before we have
results we like is the discipline; deciding it after is not.

### The layered metric set

1. **Offline backtest on the existing corpus** (the pre-merge
   gate - this is what the corpus history is for):
   - **Grounding rate** - every minted intent binds to a
     target that actually exists and is live. Target 100%;
     hallucinated or orphaned targets are a hard fail.
   - **Provenance integrity** - each intent traces to real
     seeding evidence in the snapshot it was minted from.
   - **Selection quality** - replay minting against historical
     snapshots; do intents cluster on the high-confidence,
     high-valence-cost patterns, or wander? Score against a
     small hand-labeled "worth working on" set.

2. **Honest-loop validation** (proves the firewall holds):
   - **Efficacy must NOT correlate with employment count.**
     The key check. If an intent the model "worked hard on"
     gains efficacy regardless of whether its target moved,
     the descriptive/normative separation has leaked. Target:
     correlation near zero. Negative control: a
     high-employment + flat-target intent must stay
     low-efficacy.
   - **Efficacy MUST track target movement** - diverge
     correctly between a target that genuinely declined and
     one that stayed flat.

3. **The causal control** - metric #2 from "The bar" above:
   targeted-vs-untargeted decline rate over the matched
   cohort.

4. **Operational sanity** (continuous, cheap; lands as a QA
   use-case): active count under cap, zero orphaned targets,
   retirement fires when seeding decays, minting cost/latency
   bounded.

### Backtest harness

**Built: the pure corpus-level aggregator**
(`supabase/functions/_shared/intent-backtest.ts`,
`runBacktest`) that composes the kernels into the three-part
verdict - matched-control lift > 0, |efficacy/employment corr|
under `BAR_MAX_ABS_CORR` (the firewall holding), and enough
movement windows - returning a `BacktestReport` with the
reasons it did or didn't clear. Deno-tested
(`supabase/functions/tests/intent-backtest.test.ts`) over
**provisional, best-guess fixtures**. Replacing them with the
real prod shape (and re-deriving the eyeballed `BAR_*`
placeholder thresholds from that data) is tracked as a
scheduled follow-up in the operator's session - a date-armed
in-suite tripwire used to carry this reminder, but firing it
turned every Tests run and the Deploy chain red until handled,
so the reminder moved out of the suite.

Also built: the pure **DB-rows -> corpus mapper**
(`buildCorpus`) that groups `intent_target_samples` into
per-intent time-series (ordered by `sampled_at`), counts
`intent_employments` ACTED rows as the firewall's
employment axis, and joins efficacy/target metadata into the
`BacktestIntent[]` the aggregator eats. Deno-tested with
DB-shaped fixtures, plus an end-to-end test (DB-shaped rows ->
buildCorpus -> runBacktest). So the whole fixture-driven test
runs the full path.

**Not built: the literal SQL query** that pulls those rows from
prod into `buildCorpus`. The sole user has been opted in since
2026-06-25 and data is accruing (7 control-bearing windows as
of 2026-07-29, against the 20-window bar), but the metric
decision should come first - changing the metric changes what
intent_target_samples records and thus the query shape. The
pure logic it will feed (mapper + aggregator) is complete and
tested.

### What the June 2026 prod inspection taught the backtest

Inspected the live descriptive layer (the controls' source)
and triggered the first mint. Findings the backtest must start
from, baked into the fixtures:

- **Bias targets are signal-less for the inspected user** - all
  19 biases sit at `elided` with posteriors floored ~0.011. The
  minter correctly formed zero bias-target intents. A backtest
  on this account exercises only the samskara + free-form arms.
- **Reduce and valence are decoupled.** The first mint bound a
  `reduce` intent to a **+0.50** (positive) samskara - moderating
  a competent-but-overused habit. So the valence-sign control
  partition draws a reduce-target's cohort from the deep positive
  pool, not the thin negative one; the earlier cohort-size worry
  was misplaced.
- **The real metric risk is topic-exogeneity, not cohort size.**
  Negative samskaras' windowed fire counts swung 2->185 and
  219->25 across adjacent 14-day windows - driven by what the
  user happened to discuss, not by any intervention, and cohort
  members moved in opposite directions at once. So the
  matched-control differential on the fire-frequency metric is
  expected to be ~0 (noise), and a reduce-target can score a
  false "confirm" when its topic simply goes quiet. **Treat
  samskara-target efficacy as suspect until the backtest says
  otherwise; the fixtures encode lift ~ 0 as the honest default
  expectation.** Candidate metric fixes if the backtest confirms
  the problem: normalize each samskara by its own trailing
  baseline rather than a cohort mean, lengthen the window, or
  switch from fire-frequency to the samskara evaluation's
  confirm/disconfirm verdicts.
- **Data accrues slowly.** Efficacy sampling is weekly-gated per
  intent and employment is hourly, so a usable corpus is weeks
  out, and the volatility finding suggests the weekly sample gate
  may want to be *longer*, not shorter.

### July 2026 prod data: the corpus as it stands

Queried the live DB on 2026-07-29. The sole opted-in user
has been running since 2026-06-25 (~1 month):

- 6 intents (4 active, 2 retired), 11 intent_target_samples,
  167 intent_employments, 6 intent_provenance.
- 7 control-bearing movement windows (bar needs 20). At
  weekly sampling per intent, reaching 20 windows across the
  2 long-running targeted intents takes 2-3 more months from
  the 2026-07-29 anchor (target: late October 2026).
- 2 intents carry efficacy scores (0.39 and 0.56); the
  firewall's pearson correlation needs more than 2 to be
  meaningful.

The June inspection's volatility prediction is confirmed in
real data. Samskara fire-count target values swing wildly
across consecutive weekly samples (0-34 for one intent, 4-27
for another) while control values stay flat (4.6-5.5). The
matched-control lift will be dominated by topic noise, not
intervention signal. The metric decision should come before
building the backtest SQL.

Also found and fixed: a target-pair dedup gap in
`processMintProposals`. The statement-only dedup let the
minter seat two active intents on the same samskara
(`8b9e8e0e`, reinforce) by rephrasing the statement
slightly. The fix adds a `(target_kind, target_ref,
target_direction)` dedup key alongside the normalized-
statement key, so two active intents can no longer target
the same measurable pattern.

## Settings

Built: one toggle, `profiles.settings.intentsEnabled` (default
false), coerced in `coerceSettings`, patched in `updateSettings`,
seeded/reset in app-state, and surfaced as the "Working
intentions" control in the Settings AI pane (auto-apply with
rollback, the pane convention). Off disables minting, injection,
AND evaluation wholesale - gated at the injection side in
`applyIntentPriming` and at the source in
`intent_mint_claim_next_user` (the claim requires the flag, so an
opted-out user is never picked up - see Gotchas). Per the
bias-profile precedent, the efficacy/minting math constants are
NOT user-facing knobs - the toggle is the only control.
`settings.md` and `docs/user/intents.md` document it.

## Interactions

- **Samskara** (`./samskara.md`) - intents READ samskara
  (compound summary + the corpus for seeding, `samskara_fires`
  for samskara-target efficacy). Intents NEVER write samskara
  state. One-way dependency, descriptive -> normative.
- **Bias profile** (`./bias-profile.md`) - intents READ
  `bias_summary` (for seeding and for bias-target efficacy).
  Never write. Injection sits alongside the bias appendix on
  row-1 under a shared budget, and the two can issue opposing
  directives - see **Injection -> Appendix budget and
  conflict** for both the shared-cap rule and the conflict
  resolution (dispositional framing, minter-owned coherence,
  explicit user > bias > intent precedence).
- **Prompt augmentation** (`./prompt-augmentation.md`) - adds
  a row-1 baseline-appendix contributor. Update the
  contributors table and ordering notes.
- **Memory / Wiki** (`./memory.md`, `./wiki.md`) - read as
  minting inputs; the librarian cron cadence is the model to
  mirror for the minting sweep.
- **Settings** (`./settings.md`) - the enable toggle.
- **Logging** (`./logging.md`) - the sweeps write through
  per-claim edge loggers (new source `intent`) so the Logs
  drawer surfaces minting / evaluation lifecycle.

## Gotchas

- **The toggle gates at the claim, not just at injection.**
  `applyIntentPriming` checks `intentsEnabled`, but that only
  governs the chat-turn side. Minting AND the efficacy
  evaluation that rides inside the per-user pass would otherwise
  run for any user with a descriptive layer, writing intents to
  the DB while the user has the feature off - violating "off =
  inert". `intent_mint_claim_next_user` therefore joins
  `profiles` and requires `settings->>'intentsEnabled' = 'true'`,
  so an opted-out user is never claimed. Both gates are
  load-bearing; removing either re-opens the leak.
- **Engagement is not efficacy.** `user_reaction` on
  `intent_employments` is tempting to read as "is it working"
  - a receptive user feels like success. It is NOT an efficacy
  input. A user can be warmly receptive to a nudge that
  changes nothing, and resistant to one that lands. Efficacy
  comes only from descriptive-layer movement. This is the
  single most likely place for the firewall to leak during
  implementation; the table separation exists to make the
  wrong wiring obvious in review.
- **Samskara-target efficacy reads fire frequency, not
  health.** Health is prediction accuracy; a reduce-intent
  that works makes the pattern *rarer*, not *less
  predictable*. Wiring efficacy to health would invert the
  signal. See **The C efficacy model**.
- **The user's explicit instructions are not negotiable.** An
  intent that contradicts the user's own system prompts is a
  bug, not a tradeoff - the minter must refuse to seat it and
  render-time precedence must subordinate every intent to user
  instructions. This is the bright line between "a participant
  that helps you grow" and "an agenda about your life with no
  brake." See **Injection -> Appendix budget and conflict**.
- **Intent phrasing is load-bearing, not cosmetic.** Intents
  render as dispositional leans ("when natural, incline toward
  X"), never as turn imperatives ("do X"), specifically so they
  cannot hard-conflict with bias compensation's in-the-moment
  imperatives. A minter that emits commanding phrasing
  reintroduces the conflict the framing was chosen to avoid.
- **Free-form intents never gain a posterior.** A `'none'`
  target with a non-null efficacy is a bug - it means
  something self-graded its way to a score.
- **Off-by-default is part of the contract, not a soft
  launch.** The toggle defaults off until the backtest clears
  the matched-control bar. Flipping the default is a separate,
  evidence-gated decision.
- **Same-sweep churn vs. legitimate re-form.** The dedup rule
  "retired does not block a twin" is for re-forming a pattern
  that was retired in a PRIOR sweep (it genuinely came back). It
  is NOT a license to retire and recreate the identical statement
  in ONE plan - that is a fumbled reframe (the minter meant to
  re-word and didn't), and applied literally it tombstones the
  old row beside an identical fresh active twin, which surfaced
  as the same sentence under both "Active" and "Let go" in the
  inspector. `processMintProposals` collapses that case (cancel
  the retire, drop the duplicate create); the inspector also
  defensively hides a retired twin of a live statement. Both
  guards are load-bearing for the "don't show duplicates" UX -
  the minter fix stops new churn at the source, the inspector fix
  also covers a genuine cross-sweep re-form (which is allowed and
  should read as "reconsidered", not a duplicate).
- **Target-pair dedup, not just statement dedup.** The minter
  can rephrase a statement slightly while keeping the same
  (target_kind, target_ref, target_direction) binding. Without
  a target-key dedup, two active intents land on the same
  samskara or bias, which inflates the active set, double-
  counts efficacy sampling on that target, and confounds the
  matched-control backtest (both intents compete for the same
  control cohort). `processMintProposals` now dedups on both
  normalized statement text AND target key; removing either
  check re-opens the gap.

## QA

Two `docs/qa/use-cases/` walkthroughs cover what is built:

- [`intent-mint-pipeline`](../../qa/use-cases/intent-mint-pipeline.md)
  - the daily pass: the toggle-gated claim, efficacy
  evaluation (target-vs-control sampling into the posterior),
  the create/retire/dormant/revive plan, the run stamp.
- [`intent-injection-toggle`](../../qa/use-cases/intent-injection-toggle.md)
  - the toggle, the "Working intentions" system-prompt block
  after the bias appendix under the shared cap, the
  `intent_active_at_turn` snapshot.

Both were **executed live against `mise run dev-start` and
pass** (see each case's results log). The injection case had its
verification rewritten during that run: the original "read the
block in the `stream` wire" step was not observable (the block
is spliced server-side after the browser logs its pre-priming
wire), so it now reads `threads.intent_active_at_turn` - the
rendered ids - as the faithful proxy, with byte-ordering left to
the orchestration test. The QA run also caught real precondition
bugs (nondeterministic `$UID` on a multi-profile volume, the
gateway needing the legacy-JWT service key, and the
evaluation-runs-before-minting timing). The inspector and
employment cases shipped with those pieces
([`intent-inspector`](../../qa/use-cases/intent-inspector.md),
[`intent-employment`](../../qa/use-cases/intent-employment.md)).

Writing the mint-pipeline case is what surfaced the toggle-gate
bug (below) - the use-case's step 1 ("off -> nothing minted")
failed against the pre-fix claim, which is exactly why the rule
to ship the walkthrough with the feature exists.
