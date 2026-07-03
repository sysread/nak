# Bias profile

A silent server-side pipeline that observes the user's conversations
for cognitive biases and System-1 heuristics (Kahneman-style;
representativeness, anchoring, affect heuristic, substitution,
framing effect, etc.), aggregates evidence across conversations
via a Bayesian Beta-Binomial posterior with recency decay, and
injects compensation guidance into the main chat LLM's system
prompt when a bias clears a credible-interval gate.

A v2 calibration loop watches how the user reacts to the
assistant's compensation behavior across conversations and shifts
the surfacing thresholds per bias: consistent affirmation lowers
the bar for that bias to surface, consistent pushback raises it.
The shift is bounded so a single bad reaction cannot knock a
genuine pattern off the map.

The user never sees raw observations in normal conversation -
compensation is silent. A debug modal (chart-pill in the bottom-
right column) shows the per-bias evidence, the per-bias feedback
EMA, the recently processed conversations, and the per-observation
plus per-reaction drill-downs for the curious.

## Role in the app

A bias is a one-of-19 catalog key the observer agent can report
against. Each per-conversation observation carries a confidence
in [0.40, 0.85] (floor/cap clamped on ingest) and a reasoning
string citing the user message that exhibits it. Multiple
same-bias observations on the same conversation collapse via
noisy-OR; across conversations, a weighted Beta-Binomial
posterior aggregates with exponential recency decay
(half-life 60 days). Biases whose 90% one-sided credible interval
lower bound clears the soft threshold (0.15) render a per-turn
compensation bullet into the system prompt; clearing the strong
threshold (0.30) renders the same bullet with stronger phrasing.

The venice edge function's priming stage reads the cached
`bias_summary` row set once per turn entry and appends the rendered
block to the system prompt the browser POSTed, reused across every
round. Pipeline side: the hourly
`nak-bias-sweep` pg_cron job (minute :03) drives the venice edge
function's `bias-sweep` route, which runs two phases per tick
(analyze, then aggregate). Cron is the ONLY driver - there is no
chat-turn tail, because analyze eligibility requires the thread's
last update to fall on a prior calendar day in its owner's
timezone, so a turn's own thread is never eligible at turn time.
Per-turn cost on the chat side is one SELECT against
`bias_summary` plus one fire-and-forget `bias_clear_thread` RPC
when the user's new message lands on a previously-processed
thread.

The math is the load-bearing piece. The sweep's observer agent
is itself a fallible LLM susceptible to the clustering illusion
and the law of small numbers (the very biases it reports against);
the math protects against this with a deliberately conservative
prior, a hard floor on effective sample size, and a credible-
interval lower bound (not the mean) as the surfacing gate.

## Files

- `src/lib/bias/catalog.ts` - the closed 19-entry catalog. Each
  entry ships a definition, positive example, near-miss, and a
  pre-written compensation guidance string. Adding or removing
  an entry is a deliberate code change; the DB stores `bias` as
  free text and the chat-side format pass drops unknown keys
  (so a stale cache can never render a guidance string we can't
  resolve). Survivorship bias is intentionally absent - it
  requires a counterfactual the observer can't see in a
  transcript.
- `src/lib/bias/types.ts` - shared row shapes and the browser-side
  copy of the math tunables (`ALPHA_PRIOR`, `BETA_PRIOR`,
  `HALF_LIFE_DAYS`, `N_EFF_FLOOR`, `CI_LB_SOFT`, `CI_LB_STRONG`,
  `CONFIDENCE_FLOOR`, `CONFIDENCE_CAP`, `PER_CONV_CAP`,
  `RENDER_CAP`, `MIN_USER_MESSAGES`). The chat path and the
  BiasProfile screen read these for rendering and display; the
  sweep's math reads the mirrored constants in
  `supabase/functions/_shared/bias-math.ts`. A tuning pass touches
  both files; the parity test fails the gate on a one-sided edit.
- `supabase/functions/_shared/bias-math.ts` - pure functions for
  the aggregation pipeline, fed by the sweep's aggregate phase.
  `collapseWithinConversation` (noisy-OR + per-conv cap),
  `recencyWeight` (exponential decay), `aggregatePosterior`
  (Beta-Binomial weighted update + CI lower bound + tier),
  `feedbackEMA`, and `clampConfidence` for the ingest path.
  Self-contained (no relative imports) so the Deno island, vitest
  (`tests/bias-math.test.ts`), and tsc can all load it. The
  credible-interval lower bound is computed via an exact inverse
  regularized incomplete beta (continued-fraction expansion +
  Newton-with-bisection inversion) - ~150 lines, no external
  dependency, tested against scipy reference values at seven
  (p, alpha, beta) points.
- `supabase/functions/_shared/bias-catalog.ts` - self-contained
  mirror of `src/lib/bias/catalog-keys.ts` + `catalog.ts`. The
  browser copies stay the canonical edit surface for the chat
  path and the modal; the mirror feeds the observer agent's
  prompt and ingest validation. `tests/bias-catalog-parity.test.ts`
  deep-compares the two sides so the mirror cannot drift silently.
- `supabase/functions/_shared/bias-format.ts` - pure renderer for
  the system-prompt block, run server-side. Filters `bias_summary`
  rows to soft+strong, sorts tier-then-CI-descending, caps at
  `RENDER_CAP`, emits one bullet per bias using the catalog's
  pre-written guidance plus a static block of general framing rules
  and the whimsy exception. The canonical renderer; the catalog/math
  data it reads (`bias-catalog.ts` / `bias-math.ts`) is the
  parity-tested pair with the browser `src/lib/bias/catalog.ts` +
  `types.ts`, which the diagnostics modal reads to render its own
  preview.
- `supabase/functions/venice/priming.ts` - the server-side turn-entry
  priming stage. `applyBiasPriming` reads `bias_summary` (scoped by
  the JWT user id - the service-role client has no `auth.uid()`),
  renders the block via `bias-format.ts`, appends it to the row-0
  system message, then fires the active-set snapshot and the
  new-user-message `bias_clear_thread` RPC. Runs inside
  `getStreamingResponse` under the same `EdgeRuntime.waitUntil` as
  the streaming loop, so priming survives a browser disconnect.
- `supabase/functions/venice/agents/bias.ts` - the whole pipeline.
  Owns the observer/reactor system prompt (built dynamically from
  the catalog mirror so a catalog edit flows automatically; five
  sequential falsification questions before any report - could a
  reasonable person be doing this without the bias, is the user
  thinking out loud, is this a joke / banter / whimsy / role-play /
  fiction, is this suspension-of-disbelief content, am I
  generalizing from one sentence; the third and fourth questions
  are the whimsy exception, load-bearing against pedantic
  over-reporting in playful conversations), the single-completion
  `observeThread` call (parse the JSON envelope, drop items that
  fail shape checks or name unknown catalog keys, drop reactions
  for non-active biases as fabrication), the analyze drain
  (claim via `bias_claim_next_thread_for_sweep`, fetch the
  transcript, clamp confidences through floor/cap, save under the
  message-count guard), the aggregate recompute, and the exported
  `runBiasSweepTick(adminClient)` entry the `bias-sweep` route
  calls. The model is hardcoded
  `mistral-small-3-2-24b-instruct` - a static role-to-model
  mapping, not a per-user tier. Per-claim edge loggers use
  source `bias`.
- The chart-glyph pill that opens the diagnostics modal is the
  `bias` entry in the shared diagnostic-pill column - the middle
  slot, below the intuition brain and recall bulb, above the
  samskara mood pill. Rendered by
  `src/components/DiagnosticPills.svelte` from the registry in
  `src/lib/ui/diagnostic-pills.ts`; see
  [diagnostic-pills.md](./diagnostic-pills.md). Always present and
  always enabled - unlike recall/intuition there is no cold-start
  disabled state, because the modal carries useful chrome (the
  full bias catalog with priors) even before the worker has
  observed anything. The glyph is static regardless of tier state -
  revealing "something is shaping responses right now" via the
  chrome itself violates the "absorption over disclaimer" framing.
- `src/screens/BiasProfile.svelte` - the diagnostics modal. Reads
  `bias_summary` and `biasListProcessedThreads` on mount;
  per-thread observations are pulled on demand when a row is
  expanded. Three sections: per-bias evidence table, processed
  conversations list with drill-down to observations, footer
  citing the math constants.
- `supabase/schema.sql` (bias-profile section) - the tables
  (`bias_observations`, `bias_summary`, `bias_reactions`), the
  columns on `threads` (`bias_processed_at`,
  `bias_processed_msg_count`, `bias_claim_holder`,
  `bias_claim_expires`, `bias_active_at_turn`), the RPC surface
  covering the sweep claim, save, clear, and the per-bias
  contribution queries, plus the `nak_trigger_bias_sweep()`
  dispatcher and the `nak-bias-sweep` pg_cron job.

## Entry points

- **`applyBiasPriming` server-side turn-entry** - in
  `supabase/functions/venice/priming.ts`, the opening stage of
  `getStreamingResponse` before the first round. Reads the cached
  rows (scoped by the JWT user id), renders the system-prompt
  section, and appends it to the row-0 system message the browser
  POSTed. In the same pass it snapshots the rendered active set into
  `threads.bias_active_at_turn` and fires `bias_clear_thread`
  (passing `p_user_id`) so the sweep re-analyzes with the fresh
  message. All three writes swallow their errors - bias never blocks
  a turn.
- **`buildSystemPrompt()`** - in `src/lib/chat/system-prompt.ts`, builds the
  baseline only. The browser ships a bias-free system prompt; the
  server appends the bias block with the same blank-line separator
  `buildSystemPrompt` uses between sections, so the wire bytes are
  unchanged - the assembly site moved server-side, the output did
  not. Absent entirely on cold start - no placeholder text.
- **`nak-bias-sweep` pg_cron job** - hourly at minute :03 (the
  x7 ladder is full; :03 starts a new column clear of the */5
  embed ticks and the :13/:43 samskara decay). The job calls
  `nak_trigger_bias_sweep()`, which reads the project URL and
  service-role key from Vault and pg_net-POSTs the venice
  function's `bias-sweep` route. The route's `sweepHandler`
  wrapper calls `runBiasSweepTick(adminClient)`.

## Data model

Three tables and five columns on `threads`. All
RLS-scoped to `auth.uid() = user_id`, all created with
`if not exists`, all RLS policies drop-then-recreated per the
project's idempotency convention (see `supabase/schema.sql`'s
header comment).

### `threads` additions

- `bias_processed_at timestamptz` - when the sweep last
  analyzed this thread. NULL means the thread is eligible for a
  fresh analyze pass. A thread also re-eligibles
  when `bias_processed_at < threads.updated_at` (a new user
  message bumps `updated_at`).
- `bias_processed_msg_count int` - the user-message count the
  sweep saw at analysis time. The save RPC's optimistic-
  concurrency token: if a new user message landed during the
  agent call, the save drops the work and releases the claim.
- `bias_claim_holder text` / `bias_claim_expires timestamptz` -
  per-thread claim columns, independent of samskara's claims on
  the same thread. The mutual exclusion: the atomic
  update-returning inside `bias_claim_next_thread_for_sweep`
  ensures overlapping sweep ticks never both win the same
  candidate. Claim TTL is 300s - generous enough for one LLM
  call against a long transcript.

### `bias_observations`

Per-conversation per-bias evidence rows written by the sweep's
analyze phase.

- `id uuid primary key default gen_random_uuid()`.
- `user_id uuid` (FK to `auth.users`).
- `thread_id uuid` (FK to `threads` on cascade).
- `bias text not null` - catalog key. No DB-side enum check
  because the catalog is the source of truth in TypeScript;
  unknown values are dropped at the chat-loop read.
- `confidence real not null check (confidence between 0.40 and
  0.85)` - the DB constraint mirrors the
  `(CONFIDENCE_FLOOR, CONFIDENCE_CAP)` clamp at ingest. An
  agent that ignores its prompt floor still cannot land bad
  data.
- `reasoning text not null` - one to two sentences from the
  agent citing the user message that exhibits the bias.
- `evidence_message_id uuid references messages on delete set
  null` - soft pointer to the cited user message. Survives the
  message being deleted (the observation keeps its text; the
  deep link is lost).
- `created_at timestamptz`.
- Indexes on `(thread_id)` and `(user_id, bias)` - the aggregate
  phase's per-bias query and the modal's per-thread drill-
  down query, respectively.

### `bias_summary`

Per-(user, bias) aggregate cache. The chat-loop's only read.

- `(user_id, bias)` composite primary key. One row per catalog
  entry per user; the sweep upserts on each aggregate pass.
- `effective_n real` - sum of recency weights. Real (not int)
  because of the continuous decay.
- `posterior_alpha real` / `posterior_beta real` - Beta-Binomial
  parameters after the weighted update. Stored so the modal can
  recompute the CI bounds if a future change to the inverse-beta
  routine wants to verify against the persisted row.
- `posterior_mean real` - `alpha / (alpha + beta)`. Cached for
  display.
- `ci_lower real` - 90% one-sided credible interval lower
  bound. The surfacing gate.
- `feedback_score real default 0` (v2) - EMA in [-1, +1] from
  `bias_reactions` for this (user, bias). Shifts the surfacing
  gates at tier-evaluation time. Default 0 so v1-aggregated rows
  behave identically.
- `tier text check (tier in ('elided', 'soft', 'strong'))`.
- `computed_at timestamptz`.

### `bias_reactions` (v2)

Per-conversation per-bias compensation-feedback signal. One row
per (user, thread, bias) where the bias was active in the system
prompt during the conversation. The merged observer/reactor
agent emits these from the same LLM call as observations so the
two stay in sync.

- `(user_id, thread_id, bias)` unique constraint.
- `was_confirmed boolean` - true (user affirmed), false (user
  pushed back), null (neutral / no clear signal). The three-state
  is load-bearing: null means "the agent looked and saw nothing
  for this bias" distinct from "the agent never ran for this
  bias" (absence of row).
- `reasoning text not null` - one to two sentences from the
  agent citing what the user said or did.
- `created_at timestamptz`.

Re-analyzing a thread (which happens whenever a new user
message lands; see bias_clear_thread) replaces the prior
reactions via the unique-key upsert in bias_save_observations,
matching the observations table's "fully replace on re-analyze"
contract.

### `threads.bias_active_at_turn` (v2)

`text[]` column, default `{}`. Snapshot of bias keys that
rendered into the system prompt on the most recent chat-loop
turn for this thread. The chat-loop writes per turn; the sweep
reads via `bias_claim_next_thread_for_sweep` so the reactor
knows which biases the user's messages could have been reacting
to. Empty array means no biases were active and the reactor pass
produces zero rows.

### RPCs

- `bias_claim_next_thread_for_sweep(p_holder_id, p_ttl_seconds,
  p_min_user_messages)` - SECURITY DEFINER, service-role only,
  scans across ALL users. Returns `(thread_id,
  user_message_count, active_biases, user_id)` for the next
  eligible thread (oldest `updated_at` first) or empty; `user_id`
  attributes the per-claim logger to the row's owner. Atomic
  update-returning. Eligibility = at least `p_min_user_messages`
  user messages, never processed or processed before the
  thread's most recent update, `updated_at` on a calendar day
  before today in the owner's timezone (the profile's
  `displayTimezone` via `nak_safe_timezone`, UTC fallback), no
  live claim. The user-message-count predicate lives inline in
  the WHERE, not as a post-SELECT check - see the starvation
  gotcha below. `active_biases` is the snapshot from
  `threads.bias_active_at_turn` so the agent knows what
  compensation was on the wire during this conversation.
- `bias_save_observations(p_thread_id, p_holder_id,
  p_expected_msg_count, p_observations, p_reactions, p_user_id)` -
  in a transaction, verify claim plus ownership plus
  user-message-count, delete prior observations and reactions for
  the thread, insert the new ones (empty arrays are valid saves),
  set `bias_processed_at = now()` and `bias_processed_msg_count =
  expected_count`, release claim. Returns false if any guard
  fired. Observations and reactions persist atomically in one
  transaction so the two sides of the merged-agent output cannot
  drift. `p_user_id` is the b-strict overload pattern: the sweep's
  service-role client has no `auth.uid()`, so it passes the
  claimed row's owner explicitly; an authenticated caller omits
  it and gets `auth.uid()` scoping.
- `bias_clear_thread(p_thread_id, p_user_id default null)` - delete
  observations AND reactions for the thread, clear
  `bias_processed_at`, `bias_processed_msg_count`, the claim
  columns, and `bias_active_at_turn`. Called from the server-side
  priming stage on every user-message send, passing `p_user_id`
  (the b-strict overload pattern - the service-role client has no
  `auth.uid()`); authenticated callers omit it and get `auth.uid()`
  scoping. Idempotent and cheap.
- `bias_processed_threads_for_bias(p_bias, p_user_id)` -
  aggregation input. Joins every processed thread against the
  per-thread noisy-OR-collapsed probability for the specified
  bias. Returns `pConv = 0` for threads with no observation of
  this bias so the denominator stays the full processed set.
  `p_user_id` is the same b-strict overload as the save RPC -
  the sweep's aggregate pass scopes per claimed user.
- `bias_reactions_for_bias(p_bias, p_user_id)` (v2) -
  aggregation input for the feedback EMA. One row per reaction
  with age in days. Same b-strict `p_user_id` overload.

### Cron job

`nak-bias-sweep`, scheduled hourly at `3 * * * *`.
`nak_trigger_bias_sweep()` (SECURITY DEFINER, revoked from every
non-owner role) reads `project_url` and `service_role_key` from
Vault and dispatches a pg_net POST to the venice function's
`bias-sweep` route. Missing Vault secrets make the trigger a
silent no-op so a fork without the automation wired up doesn't
spam errors.

## Contracts

### Turn-entry side (server, synchronous, no LLM)

All in `supabase/functions/venice/priming.ts`'s `applyBiasPriming`,
which runs as the opening stage of `getStreamingResponse`. The
service-role admin client has no `auth.uid()`, so every read/write
scopes by the explicit JWT user id.

- read `bias_summary` for the user, filter to soft+strong, render
  via `bias-format.ts`'s `formatBiasProfileBlock`. Cold start, no
  clearing rows, or a read error all yield no block - the system
  prompt is left unchanged. The rendered active set is post
  tier-filter and post render-cap so the snapshot reflects what was
  on the wire, not the broader pool.
- snapshot the active set to `threads.bias_active_at_turn` (scoped
  `.eq('user_id', userId)`) so the sweep's reactor can read it via
  the claim RPC. Empty array is a valid write.
- fire `bias_clear_thread` with `p_user_id` (no-op when the thread
  was never processed) so the sweep re-analyzes against the fresh
  message.

All three swallow their errors; bias must never fail a chat turn.
`formatBiasProfileBlock(rows): string | null` is pure - the server
calls it here, and the diagnostics modal renders its own preview
from `bias-format`'s browser-side counterparts in
`src/lib/bias/catalog` + `types`.

### Sweep side (async, fast-model agent calls)

`runBiasSweepTick(adminClient)` runs two phases per tick,
non-throwing by contract (one phase failing must not stop the
other, and nothing may throw into the sweep handler):

- **Analyze** - drains the cross-user queue up to a per-tick cap
  of 10 threads (`ANALYZE_SWEEP_CAP`; the cap bounds a tick's
  worst-case Venice spend, and a cap hit is logged so a queue
  growing faster than the drain is visible). Each step claims the
  most-overdue eligible thread via
  `bias_claim_next_thread_for_sweep`, fetches its transcript
  (user + assistant turns; tool calls and reasoning are out of
  scope), runs `observeThread` with the claim's `active_biases`
  set, clamps confidences through `clampConfidence`, and saves
  both observations and reactions in one RPC under the
  message-count guard. The save-rejected outcome (claim lost or
  count drifted) is not an error - the thread becomes re-eligible
  on a later tick with fresh state, and the drain continues. An
  error stops this tick's drain; the next hourly tick retries.
- **Aggregate** - recomputes `bias_summary` for every user the
  analyze drain touched this tick, plus any user whose oldest
  `bias_summary.computed_at` is older than 24h
  (`SUMMARY_MAX_AGE_MS`, the freshness floor - the posterior and
  feedback EMA are age-weighted, so tiers drift even with no new
  observations, and the floor keeps that drift surfacing). Per
  user it walks `BIAS_KEYS` and upserts one summary row per
  catalog entry; v2 also reads reactions and computes the
  feedback EMA per bias, threading it into the feedback-aware
  `tier()` call so the persisted tier reflects the shifted gates.
  Cold start (no observations, no reactions) still emits N
  upserts, all rendering as `tier='elided'` on the prior alone
  with `feedback_score=0`.

Phase order is analyze-then-aggregate deliberately: the same
tick's aggregate sees the analyze drain's new observations, so a
fresh save reaches `bias_summary` (and the next day's prompt
block) without waiting an extra hour.

### Math contract

Math constants live in two mirrored files:
`supabase/functions/_shared/bias-math.ts` (the sweep's math
kernel) and `src/lib/bias/types.ts` (the chat path's render
constants and the modal's display copy).
`tests/bias-catalog-parity.test.ts` fails the gate on a one-sided
edit. The tunables that change feature behavior:

```text
ALPHA_PRIOR = 2                    # prior alpha
BETA_PRIOR  = 8                    # prior beta (mean 0.2, weight 10)
HALF_LIFE_DAYS = 60                # observation recency decay
CI_LB_SOFT  = 0.15                 # soft-tier gate on CI lower bound
CI_LB_STRONG = 0.30                # strong-tier gate
N_EFF_FLOOR = 5                    # min effective N for any non-elided
FEEDBACK_HALF_LIFE_DAYS = 30       # reaction recency decay (v2)
FEEDBACK_THRESHOLD_DELTA = 0.10    # max gate shift at +/- 1 feedback
FEEDBACK_PRIOR_WEIGHT = 3          # neutral pseudo-count on EMA
```

If a user complains "you're calling out a bias I'm not actually
exhibiting", raise `CI_LB_STRONG`. If a user complains "you're
not picking up on my pattern", lower `ALPHA_PRIOR` (less prior
weight) or lower `CI_LB_SOFT` (more permissive gate). Do NOT
expose these as user settings; they are not user-facing knobs.

The credible-interval lower bound is computed via an exact
inverse regularized incomplete beta. At our typical (alpha, beta)
ranges the normal approximation consistently overstates
uncertainty (5-30%), which would silently suppress real signal.
At very large samples (alpha + beta > ~200) the normal
approximation becomes accurate enough to swap in for speed -
not worth doing until then.

### Feedback-aware tier (v2)

The compensation-feedback calibration layer is the v2 addition.
Each conversation analysis classifies, for each bias that was
active in the system prompt during the conversation, whether the
user affirmed the compensation (was_confirmed=true), pushed back
(was_confirmed=false), or showed no clear signal (null). Those
reactions accumulate into a per-(user, bias) EMA in [-1, +1]:

```text
feedback_score(B) = sum(w_i * (was_confirmed_i ? +1 : -1))
                  / (FEEDBACK_PRIOR_WEIGHT + sum(w_i))
```

where `w_i` is the recency weight at FEEDBACK_HALF_LIFE_DAYS.
Neutrals are skipped; the prior pseudo-count carries the
no-signal mass so a single early disconfirm cannot peg the score
at -1.

The EMA shifts both CI gates symmetrically:

```text
softGate_eff   = CI_LB_SOFT   - FEEDBACK_THRESHOLD_DELTA * feedback_score
strongGate_eff = CI_LB_STRONG - FEEDBACK_THRESHOLD_DELTA * feedback_score
```

Affirming users (feedback approaching +1) see gates drop by up to
0.10; pushing-back users see gates rise by up to 0.10. The math
kernel does not touch the underlying posterior - the EMA only
nudges where the gate sits. The N_eff floor is independent of
feedback so no amount of positive feedback can lift a bias out of
elided before the small-N gate is cleared.

### Render contract

The system-prompt block is a tail section of the baseline prompt
(after the toolbox catalog). It is rendered when at least one
bias is at soft or strong tier; absent entirely otherwise.

Maximum rendered biases: `RENDER_CAP` (4). When more biases
clear soft+strong, the top 4 by `ci_lower` descending make it
into the prompt; the rest stay in `bias_summary` (visible in
the modal) but ride no further. The cap exists because more
than four compensation rules crowds out the actual instruction
surface.

Per-bias guidance strings live in `BIAS_CATALOG[<key>].guidance`:
pre-written, two sentences max, imperatives. Below the bullets a
static block of general framing rules (don't pre-anchor, surface
base rates, name a contrary view, evaluate on marginal grounds,
phrase questions neutrally) and the whimsy exception (suspend the
rules in jokes / banter / fiction / role-play / hypotheticals)
closes the block.

## Interactions with other features

- **Chat ([./chat.md](./chat.md))** - the priming stage is the only
  reader of `bias_summary` on the synchronous path. `applyBiasPriming`
  (`venice/priming.ts`) reads the rows at turn entry, renders the
  block, and appends it to the row-0 system message. In the same pass
  it fires the `bias_clear_thread` RPC (with `p_user_id`) once per turn
  (cheap, idempotent) so a previously-analyzed thread gets re-observed
  against the fresh message. See `./chat.md`.
- **Samskara ([./samskara.md](./samskara.md))** - sibling
  feature, no data flow. Bias profile rides at the END of the
  baseline system prompt; samskara's compound summary rides as
  a `<think>` block AFTER the user turn. Both are always-on
  contributions to the model's view of the user, but they sit
  in different parts of the prompt so they don't conflict.
  Both run server-side in the venice function with per-row
  claims as the mutual exclusion; bias is cron-only while
  samskara's formation pipeline is dual-driver (turn tail +
  hourly sweep).
- **Intuition ([./intuition.md](./intuition.md))** - sibling
  feature, no data flow. Intuition fires per-thread on title /
  mood / staleness triggers and produces a `<think>` block.
  Bias profile fires per-user across conversations and
  produces a system-prompt section. Both expose a pill in the
  bottom-right column; bias stacks below intuition.
- **Logging ([./logging.md](./logging.md))** - the sweep writes
  through per-claim edge loggers (`createEdgeLogger(userId,
  'bias')`), attributed to the claimed thread's owner and
  flushed per claim; the edge-log broadcast streams the lines
  into the owner's in-app Logs drawer. The Trace+ filter
  surfaces the per-phase decisions ("analyze: observer returned
  null", "analyze: save rejected"). The Info+ default surfaces
  the lifecycle headlines ("analyze: claimed thread X",
  "analyze: saved N observations", "aggregate: recomputed N
  summary rows"). Tick-level plumbing failures (claim RPC
  errors, the analyze-cap notice, stale-scan failures) go to
  the function's console log - they have no single owner to
  attribute.
- **Settings** - no bias controls (no enable/disable, no
  threshold sliders, no catalog editor). The math defaults are
  the contract; tuning happens in `bias-math.ts` + `types.ts`
  (both sides of the mirror) if it has to happen at all. The
  profile's `displayTimezone` setting does feed the claim's
  day-gate, so a timezone change shifts which threads count as
  "settled" on the next tick.

## Gotchas

- **Non-hit threads must be in the denominator.** The aggregate
  query in `bias_processed_threads_for_bias` is a LEFT JOIN
  against the per-bias hit set. Threads with no observation of
  the bias get `pConv = 0` and still count toward the
  denominator. Without that join the math collapses: the rate
  estimate becomes "fraction of bias-positive threads where the
  bias was observed", which is always 100%. The math tests
  (`tests/bias-math.test.ts`) cover the zero-pConv contributions
  directly.
- **The cap on per-conversation noisy-OR is intentional.**
  `collapseWithinConversation` clamps the within-conv
  probability at `PER_CONV_CAP` (0.85). Three same-bias
  observations at confidence 0.7 each would naively give
  `1 - 0.3^3 = 0.973`, which is "near-certain" from what is
  really one agent pass with correlated signals. The cap pulls
  this back to 0.85 - we acknowledge repeated evidence (more
  than a single observation) but refuse to let the same pass
  race past the calibration ceiling.
- **The credible-interval lower bound, not the mean, is the
  gate.** A high posterior mean with wide variance (small N)
  must not surface a bias. The CI lower bound combines "high
  estimate" AND "narrow uncertainty"; both have to be true to
  cross. This is the clustering-illusion defense.
- **The prior is conservative on purpose.** Beta(2, 8) at mean
  0.2 with effective weight 10 means the first ~10 weighted
  observations don't move the posterior far. Three confidence-
  0.85 hits in a row cannot lift any bias out of the elided
  tier - this is the law-of-small-numbers defense. Don't tune
  the prior weight down without raising `N_EFF_FLOOR` in
  parallel; they protect against the same failure mode from
  different angles.
- **The whimsy exception is in TWO places.** The observer agent
  has falsification questions 3 and 4 that suppress reporting
  in jokes / fiction / role-play. The system-prompt block also
  carries a sentence telling the main chat model to suspend
  the framing rules in those registers. Both are load-bearing
  per the original design constraint - the agent side keeps
  bad data out of the cache, and the chat side prevents
  pedantic intervention from the main model.
- **Today's conversations are excluded.** The claim's day-gate
  requires `threads.updated_at` to fall on a calendar day before
  today in the thread owner's timezone, resolved per candidate
  row from the profile's `displayTimezone` setting via
  `nak_safe_timezone` (UTC fallback for missing or garbage
  values). The server has no device clock, so the profile
  timezone is the source of truth: a traveler whose device
  timezone has moved ahead of their profile setting can have a
  thread analyzed a few hours early, which the save-time
  message-count guard tolerates.
- **There is no open-thread exclusion list.** The day-gate
  subsumes it: a thread the user is actively chatting in was
  updated today, which already excludes it from eligibility.
  The save RPC's user-message-count guard covers the remaining
  mid-analysis race (a message landing while the agent runs
  drops the save and releases the claim).
- **The count predicate lives inline in the claim's WHERE.**
  `bias_claim_next_thread_for_sweep` takes one candidate
  (LIMIT 1, oldest `updated_at` first), so a candidate that
  fails the `min_user_messages` bar has to be excluded BEFORE
  the limit - a post-SELECT early return leaves it as the
  permanent queue head and starves every thread behind it. A
  one-shot Q&A thread at the head of the queue once wedged the
  analyze pipeline this way for weeks: the logs read "no
  eligible threads" while eligible multi-message threads sat
  unprocessed behind it.
- **The save RPC is the optimistic-concurrency boundary.** If
  a new user message lands while the agent is running,
  `bias_save_observations` rejects the save because
  `count(messages where role='user')` no longer matches
  `expected_count`. The sweep drops the work and the thread
  becomes re-eligible. The priming stage's `bias_clear_thread`
  RPC call helps by clearing `bias_processed_at` directly, but the
  save-side guard is what actually prevents stale observations from
  landing.
- **`survivorship_bias` is intentionally absent from the
  catalog.** It requires a counterfactual ("the cases we don't
  see") that an LLM cannot infer from a single transcript.
  Including it would invite false positives from the agent
  pattern-matching on surface features. If a future signal
  source surfaces (e.g. a citation tool that names what was
  searched but not found), revisit.
- **The pill icon is static on purpose.** A tier-reflective
  icon (different glyph when biases are firing) would tell the
  user that something is currently shaping the assistant's
  responses, which would collapse the "absorption over
  disclaimer" framing. The pill is just an entry point to the
  diagnostics modal; revelation lives inside.
- **Confidence floor drops observations entirely.** The
  agent's prompt anchors at 0.50 and forbids reporting below
  0.40 - the "I am not sure" channel returns nothing rather
  than a low-confidence report. The ingest clamp drops
  anything that slips below the floor anyway. This is the
  prefer-false-negatives policy: a missed bias today gets
  caught next conversation; a fabricated bias contaminates
  aggregate evidence for months.
- **No co-occurrence modeling.** Per-bias posteriors are
  independent. confirmation_bias and overconfidence
  statistically co-occur in real users, but the math treats
  them as separate facts. A future enhancement would replace
  the bag of Beta-Binomials with a logistic-normal multivariate
  prior over the catalog. Manageable size (19x19 correlation
  matrix); deferred until we have field data to fit it against.
- **Feedback shifts thresholds, not the posterior.** The v2
  EMA only nudges where the surfacing gates sit; the
  underlying alpha/beta values don't change based on user
  reactions. This is deliberate - the evidence record is what
  the observer saw, and a separate signal (the reaction)
  decides how to interpret that evidence. Future variations
  could instead decay posterior_alpha on disconfirm or weight
  observations by subsequent confirm/disconfirm; both were
  considered and rejected because they entangle "what
  happened" with "how the user feels about us calling it out."
- **Reactions are scoped to the active set.** The reactor only
  classifies reactions for biases that were in
  `bias_active_at_turn` when the conversation happened. A
  reaction for a non-active bias is dropped at agent parse time
  - no compensation was on the wire to react to. If the
  chat-loop's snapshot write fails silently the sweep sees an
  empty active set and produces no reactions, which is the
  correct fallback (no false feedback signal generated). The
  browser chat path is the only snapshot writer - a reactor
  pass that never fires points at the snapshot write, not the
  agent.
- **Three-state was_confirmed.** true / false / null. Null
  means "agent looked and saw no clear signal", distinct from
  the absence of a row which means "agent never ran for this
  bias on this conversation". The EMA skips nulls; the modal
  shows them so the user can see what the agent looked at.

## Future work

Parked ideas, in rough priority order. None of these are blocked
by anything in v2; they're deferred because v2 needs field data
to settle before the next round of iteration.

### Co-occurrence modeling

Replace the bag of independent Beta-Binomials with a logistic-
normal multivariate prior over the 19-entry catalog so
statistically correlated biases update each other. confirmation_
bias and overconfidence co-occur in real users, as do anchoring
and availability_heuristic; the current math treats every
catalog entry as an independent fact. A 19x19 correlation matrix
is manageable to store and update. The blocker is the prior -
without field data to fit the off-diagonal entries against, any
correlation structure we hand-code is just another opinion. Wait
until v2 has produced enough cross-bias observations across
enough users to estimate the entries empirically.

### Time-series view in the diagnostics modal

The modal currently shows a snapshot: per-bias evidence as of the
last aggregate pass, plus the per-bias feedback_score. There's no
view of how the feedback EMA has moved over time. A small
sparkline per bias (or one combined chart filtered to a single
bias) would answer "why did this bias stop surfacing?" or "did my
recent pushback actually shift the gate?" Stack: read all
`bias_reactions` rows for the user filtered to one bias, project
the EMA at each historical timestamp, plot. Cheap; the rows are
already indexed by `(user_id, bias)`. Debug-only - not a v1
user-facing feature.

### Mark-a-reaction-as-wrong control

The reactor agent's classification quality is currently
unmeasured. A small control on each reaction card in the modal
(thumb-down or "this isn't a fair read") that writes a
`reactor_disagreement` flag against the row would give us a
ground-truth signal to evaluate the reactor's calibration
against. The flagged rows could either be excluded from the EMA
or weighted lower; the simpler version excludes. This pairs
naturally with the time-series view since "I marked the last
three as wrong" should visibly correct the EMA trajectory.

### Per-tier guidance differentiation under feedback

Currently soft and strong tiers render different phrasing
("occasional" vs "consistent"); the feedback EMA shifts whether a
bias clears each tier but doesn't change the rendered text inside
a tier. A high-positive-feedback bias still gets standard
"occasional" framing even though the user has signaled they want
direct engagement. Worth exploring whether the EMA should also
drive a phrasing variant within a tier - softer for "I push back
on hedging" users, more direct for "I appreciate the surfacing"
users. Risk: every additional rendered-text variant is another
surface for the underlying LLM to misinterpret, and the
compensation guidance is already tuned conservatively.

### Adaptive FEEDBACK_THRESHOLD_DELTA per bias

The threshold-shift envelope is a single global constant (0.10).
Some biases (overconfidence, hindsight_bias) might warrant a
larger envelope because the compensation is more intrusive when
unwanted; others (base_rate_neglect, planning_fallacy) might
warrant a smaller envelope because the compensation rides quietly
in normal estimation language. Per-bias deltas in the catalog
would let the calibration loop respond more proportionately. Wait
until we have enough field data to know which biases get
disproportionate pushback before sizing the per-entry deltas.

### Reaction half-life sensitivity sweep

FEEDBACK_HALF_LIFE_DAYS = 30 is a guess (half the observation
half-life). Real preference shifts may move faster or slower; a
sensitivity analysis once we have a few hundred reactions per
user would tell us whether 30 is too sticky or too jumpy. Cheap
to retune; one constant edit.

## Where to go next

- `./chat.md` - the seam where the bias-profile block plugs
  into the per-turn system prompt.
- `./samskara.md` - sibling background feature; same
  server-side fleet, different aggregation shape.
- `./intuition.md` - sibling subconscious-layer pattern; bias
  is its slower-moving cross-conversation counterpart.
- `./logging.md` - where the sweep's edge-log lines surface
  for debugging.
- `./architecture.md` - the browser/function split in context.
