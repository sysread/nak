# Follow-ups

Pending questions the assistant saves for itself - "Ask how the
lasagna turned out" - so a later conversation knows the outcome is
UNKNOWN instead of hallucinating one, and so a dated question ("how
did Thursday's meeting go?") gets raised proactively once its moment
has passed. The `followups` table, five `followup_*` tools, a fourth
arm on the context-recall gather, and follow-up duties on the
reflection agent. No dedicated background agent and no new setting.

A follow-up is scaffolding, not knowledge: when the user reports the
outcome the row is closed (`status='answered'` + a one-line
`resolution` audit stamp) and the durable fact reaches `memories`
through the normal channels. The followup layer writes NOTHING into
the descriptive stores directly.

## Role in the app

The problem this solves: the chat model hallucinated outcomes across
conversations - a recipe planned in one thread read as a recipe made
by the next, because recall surfaced the plan with no notion of
"unresolved". Intents were evaluated for this and rejected (wrong
author, cadence, lifetime, and budget - see the git history of
`docs/dev/in-progress/followups.md` for the full design narrative).

Three moving parts:

- **Capture** - two writers, mirroring memory's volitional /
  subconscious split. The chat model saves a follow-up mid-turn via
  the gated `followups` toolbox when the user shares a plan worth
  asking about later; the reflection agent records unresolved plans
  it finds in settled threads, so capture doesn't depend on mid-turn
  volition.
- **Surfacing** - a fourth arm of `gatherContextIndex` in the
  context-recall pipeline. Semantic: open loops matching the derived
  query ride the embedding backfill and surface beside the memories
  that describe the plan. Date-due: open loops whose
  `relevant_after` has passed are pulled deterministically at the
  next priming boundary regardless of topic, capped and
  cooldown-gated. Rendered by the smoothing pass under an explicit
  epistemic register (below).
- **Resolution** - the same two writers, because a resolution can
  only ever ARRIVE through a conversation. The chat model closes
  live (it asked and heard the answer); reflection closes as the
  settled-thread backstop (outcome volunteered unprompted, close
  missed, toolbox off).

## The epistemic register

An open loop renders in exactly one of three states, computed by the
gather (never inferred by the smoothing model):

- **upcoming** - `relevant_after` still ahead: "planned, hasn't
  happened yet". Never framed as done.
- **pending / outcome unknown** - date passed, or undated and
  semantically surfaced: "you don't know how this went; ask if
  natural, never assert". Due rows additionally carry "you've been
  meaning to ask" - a dispositional lean, not a turn command; a
  heavy current topic outranks the ask and the loop stays open.
- **resolved** - closed loops never render as loops; the outcome
  reaches later recall as an ordinary memory.

## Files

- `supabase/schema.sql` (the `followups` section at the end) - the
  table (RLS, status check, surfacing ledger, embedding + claim
  columns), the embedding-clear trigger, the backfill claim/save RPC
  pair, and `search_followups_by_embedding` (open rows only, plain
  cosine order - loops have no corroboration axis to boost by).
- `supabase/functions/_shared/followups.ts` - the shared caps and
  the pure due-side selection: `isDue` / `isExpiredByPolicy` /
  `isCoolingDown` / `selectDueFollowups`. The anti-nag constants
  live here (`DUE_SURFACE_CAP` 2, `DUE_SURFACE_COOLDOWN_MS` 20h,
  `MAX_UNANSWERED_SURFACINGS` 3, `DUE_EXPIRY_MS` 30d) - LAUNCH
  PLACEHOLDERS tuned for feel, not data. Vitest-pinned in
  `tests/followups.test.ts`.
- `supabase/functions/venice/tools/followup_*.ts` - the five tool
  impls (create / update / close / dismiss / list), b-strict
  throughout. `followup_list` returns `{open, recently_closed}` -
  the closed window is the create-side dedup evidence.
- `src/lib/tools/followup_*.schema.ts` - the browser wire schemas;
  `followupsToolbox` + the always-on `followup_list` registration in
  `src/lib/tools/index.ts`; the hand-maintained name mirror in
  `supabase/functions/venice/tools/toggle_tools.ts`.
- `supabase/functions/venice/priming/context-recall.ts` -
  `gatherFollowups` (the fourth arm: due pull + semantic union +
  lazy expiry) and `stampFollowupLedger` (the post-smoothing ask
  stamp), plus the `ContextIndexFollowup` shape. The gather/stamp
  timing contract is Deno-pinned in
  `supabase/functions/tests/followup-gather.test.ts`.
- `supabase/functions/venice/priming/context-recall-smoothing.ts` -
  the follow-up rules in the smoothing system prompt and
  `renderFollowupBlock` (uncited, state-labelled).
- `supabase/functions/venice/agents/context.ts` - the umbrella
  `context` tool's `followups` result array (the full open set,
  unfiltered - it is small by construction).
- `supabase/functions/venice/agents/reflection.ts` - the follow-up
  wire schemas, the toolbox additions, and the reconcile section of
  the reflection prompt.
- `supabase/functions/_shared/embed-input.ts` - the `followups`
  entry in `EMBED_SOURCES` (`buildFollowupEmbedInput`).
- `src/lib/ui/followups-inspector.ts` +
  `src/screens/Intents.svelte` - the read-only inspector: the
  follow-ups section of the shared seedling modal (grouping,
  the open-card status chip, headlines, the intents-off title),
  fed by `listFollowups()` in `src/lib/supabase.ts`. The
  seedling pill (`src/lib/ui/diagnostic-pills.ts`) is always
  present because of this section; the intents toggle only
  switches its copy. See
  [`diagnostic-pills.md`](./diagnostic-pills.md).

## Data model

One table, `followups`:

- `question text` - first-person prompt to self.
- `context text` - one or two lines of seeding context.
- `source_thread_id` - FK to `threads`, SET NULL on delete (the
  question outlives the conversation that seeded it).
- `status` - `open` / `answered` / `dismissed` / `expired`. Only
  open rows ever surface; closed rows are audit + dedup evidence.
- `relevant_after timestamptz` - start of proactive relevance.
  NULL = never proactively asked; the loop surfaces only when the
  topic comes up semantically, and never expires (its "outcome
  unknown" stays true until the user resolves it).
- `resolution text` - stamped by `followup_close`. Audit only.
- `last_surfaced_at` / `surface_count` - the anti-nag ledger.
  Written ONLY by `stampFollowupLedger`, which the pipeline calls
  AFTER the smoothing pass ships a non-empty note - a surfacing
  counts when it is delivered, not when it is gathered (see
  Gotchas). Semantic surfacing is not an ask-prompt, so it neither
  stamps the ledger nor counts toward expiry. `followup_update`
  resets the ledger when it changes `relevant_after` - a rescheduled
  plan has a fresh ask horizon.
- `embedding` + model + claim columns - rides the standard backfill
  (see [`embeddings.md`](./embeddings.md)).

## Lifecycle contracts

- `followup_create({question, context?, relevant_after?})` -
  callers check `followup_list` first; a question already open OR
  already answered/dismissed must not be created again. The
  answered/dismissed half is the **stale re-creation guard**:
  reflection may process an old planning thread AFTER the outcome
  landed in a different conversation, and must not mint a fresh
  loop for a resolved plan.
- `followup_update({id, question?, context?, relevant_after?})` -
  the reschedule/revise verb for a plan that MOVED rather than
  resolved. `relevant_after: null` clears the date. Open rows only.
- `followup_close({id, resolution})` - open rows only, so a
  double-close reads as not-found instead of silently rewriting a
  recorded resolution.
- `followup_dismiss({id})` - the user's veto ("stop asking about
  that"). Chat-only: reflection deliberately does NOT carry it,
  because a background agent must never infer "stop asking" from a
  transcript.
- `followup_list()` - always-on read; `{open, recently_closed}`.

## How outcomes reach the descriptive layers

**The conversation is the conduit, deliberately.** A follow-up's job
is to elicit the outcome INTO a transcript - and settled transcripts
are already the input to the whole background fleet: reflection
writes memories, the record extraction sweep writes records, the
wiki agents write articles, samskara formation reads the same
evidence. None of them need to know follow-ups exist. `resolution`
is the loop's own audit stamp, NOT the persistence channel;
reflection is the guaranteed path for the durable outcome memory,
and a volitional `memory_create` at close time is optional judgment.

Two hazards this split creates, both guarded:

- **Stale re-creation** - covered by the create-side dedup contract
  above (the reflection prompt's "already answered/dismissed" check,
  pinned by `supabase/functions/tests/reflection.test.ts`).
- **Double-write** - a volitional outcome memory plus reflection
  later writing the same fact yields near-twins. Handled by the
  existing discipline (reflection searches before creating; the
  memory librarians consolidate) - named here so nobody adds a third
  writer thinking the path is empty.

## Gotchas

- **Reflection is the ONLY background agent with follow-up tools.**
  The wiki/record extraction sweep also reads settled transcripts
  and must NOT get them - two background resolvers means
  double-close races and prompt sprawl for zero coverage gain. A
  dedicated follow-up agent was considered and rejected: it would
  duplicate reflection's whole coordination apparatus for a second
  pass over the same transcripts, and mint-vs-resolve is one
  portfolio judgment over one context.
- **Reflection runtime is the cost to watch.** Reflection already
  runs near the hosted wall clock (the measured ~9-minute run that
  motivated its attempt cap - see [`memory.md`](./memory.md)); the
  follow-up duties add prompt + tool weight. If it starts dying at
  the wall, trim the follow-up prompt section - do not split out a
  second agent.
- **The surfacing gate is `contextRecallEnabled`.** Follow-up
  surfacing lives inside the context-recall pipeline, so disabling
  context recall silently disables the asks too (capture still
  runs). If users who disable context recall want follow-ups, the
  feature needs its own toggle - a deliberate v1 simplification.
- **A due follow-up forces a non-empty note.** The pipeline's
  empty-gather short-circuit counts the followups arm, and the
  smoothing prompt is told a "due" follow-up is always worth
  surfacing - otherwise the off-topic ask (the whole point of the
  date axis) would be dropped whenever the other three layers come
  up empty.
- **Follow-ups are uncited in the recollection.** They never join
  the numbered source list - there is no drill-down tool behind
  them; question and context ride verbatim. The `^N^` citation
  machinery and the Recall modal's citation rows are untouched.
- **Due asks surface only at refresh boundaries.** The gather runs
  when a context-recall trigger fires: `cold` (a thread with no
  cached payload - i.e. a NEW thread), a mood shift, or the stale
  fuse (8 user-rounds / 1h). Between boundaries the cached note is
  re-injected as-is. Two consequences: (a) a loop that becomes due
  mid-thread will not be asked about until the next boundary in
  that thread - the reliable moment for the ask is the next
  thread-open, which is the designed behavior; (b) when QA-forging
  state via SQL (making a loop due by editing `relevant_after`),
  the edit is invisible until a boundary - open a FRESH thread to
  force a `cold` fire, don't keep messaging an existing one and
  conclude the pull is broken.
- **The ask ledger stamps on delivery, not on gather.**
  `stampFollowupLedger` runs after the smoothing pass returns a
  non-empty note. If it stamped at gather time, a smoothing failure
  (pipeline returns null, prior cache kept) or an empty model
  output would consume ask budget for an ask that never reached a
  prompt - a flaky smoothing path could burn all
  `MAX_UNANSWERED_SURFACINGS` slots and expire a loop the user was
  never asked about. Expiry still flips at gather time: it is a
  policy judgment about the row, not about this turn's delivery.
- **The ledger increment can race.** Two devices priming
  concurrently do a read-modify-write on `surface_count` with no
  atomic RPC; a lost increment costs one extra ask before cooldown
  or expiry catches up. Accepted - not worth a coordination
  primitive.
- **Undated loops never expire.** Expiry is a dated-loop policy
  (ask budget spent, or 30d past the date). An undated loop's
  "outcome unknown" remains true indefinitely, and it only surfaces
  when topical - so it persists until closed or dismissed.

## QA

Three `docs/qa/use-cases/` walkthroughs are the behavioral spec,
written BEFORE the implementation:

- [`followup-capture`](../qa/use-cases/followup-capture.md) - both
  writers, the reschedule verb, the reflection close backstop,
  dedup.
- [`followup-semantic-recall`](../qa/use-cases/followup-semantic-recall.md)
  - the recipe scenario. Its baseline arm runs against PRE-feature
  code and reproduces the hallucination; execute it before merging
  so the post-feature run has its comparison point.
- [`followup-date-due`](../qa/use-cases/followup-date-due.md) - the
  off-topic due ask, the cooldown, expiry.
- [`followup-inspector`](../qa/use-cases/followup-inspector.md) -
  the always-present seedling pill and the follow-ups section of
  the shared inspector modal.

## Interactions

- **Context recall** ([`context-recall.md`](./context-recall.md)) -
  the fourth gather arm, the smoothing rules, the umbrella tool's
  fourth array. Surfacing inherits context recall's triggers, cache,
  and feature gate.
- **Memory** ([`memory.md`](./memory.md)) - reflection is the
  subconscious writer for both stores and the guaranteed
  outcome-memory path. Follow-ups never write memory state.
- **Tools** ([`tools.md`](./tools.md)) - the gated `followups`
  write box + always-on `followup_list`; the toggle mirror
  discipline applies.
- **Embeddings** ([`embeddings.md`](./embeddings.md)) - one more
  `EMBED_SOURCES` entry + claim/save RPC pair.
- **Wiki / records / samskara** ([`wiki.md`](./wiki.md),
  [`samskara.md`](./samskara.md)) - NO direct coupling in either
  direction; outcomes reach these layers only through settled
  transcripts.
