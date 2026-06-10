# Samskara Observability Section Plan

Status: proposal. Nothing here is built yet.

Read [`../samskara.md`](../samskara.md) first - this plan assumes its
data model, worker phases, and the opacity principle it documents.

## SYNOPSIS

A read-only **operator observability surface** for the samskara
pipeline, split into two panels: **Corpus** ("show me what it thinks" -
browse/search/filter the samskaras the model has formed) and **Health**
("is it actually working" - make silent pipeline failures visible). It
consolidates and replaces the existing `Samskara.svelte` diagnostics
modal.

## PURPOSE

Two unmet operator needs:

1. **Visibility into the corpus.** The samskaras the model forms are
   effectively a black box. The diagnostics modal shows aggregate
   counts and the compound summary, but never the individual
   predictions. There is no way to answer "what has this thing
   decided about me?" short of a manual Supabase query.
2. **Silent-failure detection.** The formation pipeline is a chain of
   background phases (assimilate, embed, fire, reaction-classify,
   decay, dedup, tier-1/tier-2 mint, compound-regen) running across
   workers. When a link stalls - a dead worker, an embedding backlog,
   fires aging out unresolved, a mistuned tier-2 cosine band - nothing
   surfaces it. The system degrades invisibly. There is no health
   readout anywhere.

## Opacity reconciliation - why this does NOT violate the design

`samskara.md` is emphatic that samskara is "almost-opaque to the user"
and that "no prediction text leaks." This section surfaces every
prediction, so the tension must be named and resolved, not ignored.

The principle protects the **conversation** and guards against the
**model gaming its own bias**. Re-read its targets: "showing it would
invite *the user* to reason about their own bias model" (a chat-subject
concern - prediction text inline, mid-conversation) and "keeps *the
model* from reasoning about its own bias as a thing it can game" (no
samskara tool). nak is a single-user PWA; the person who opens this
section is the **operator**, not a conversational subject, and the
surface is one they deliberately open - the same category as the Logs
drawer and the existing diagnostics modal, both of which already render
prediction text.

So the line this plan draws, and writes into `samskara.md`:

- **The conversation stays opaque.** The in-chat surface is unchanged -
  mood-pill-only, no inline predictions, no samskara tool. Nothing
  about this section touches the chat loop or `buildSystemPrompt`.
- **The operator gets observability.** A deliberately-opened, read-only
  diagnostics surface is not the leak the principle forbids. It is the
  operator reading their own system's state, like reading logs.

The section is therefore **read-only**: no delete, no edit, no pin, no
down-weight. Curation would re-open the "user gaming the bias model"
question and is explicitly out of scope (the motivation is inspect +
monitor, not control). If a samskara is wrong, the existing recourse -
a manual Supabase edit, or the Consolidate button for redundancy -
stays the answer for now.

## DESCRIPTION

### Placement and the existing modal

The current `src/screens/Samskara.svelte` is a **modal** (`route.modal
=== 'samskara'`) reached from the Logs-drawer fist-icon and the mood
pill. It renders three things: corpus counts, the compound summary, and
the mood legend. The Health panel's counts overlap it directly, so
running both would leave two confusing samskara surfaces.

**Consolidate.** Promote samskara to a first-class **drawer tab**
(sibling to chats/memories/wiki/recipes/library in the `DrawerTab`
union), built as the single samskara diagnostics home with three
sub-views: **Corpus**, **Health**, and **Summary & Mood** (the modal's
existing compound-summary + mood-legend content, moved verbatim).
Retire the modal: repoint the mood-pill click and the Logs-drawer
fist-icon to `navigate({ drawer: 'samskara' })`, delete
`route.modal === 'samskara'` handling, delete the modal shell.

Placement is first-class but **labelled as diagnostics**, not content.
The operator checks pipeline health periodically; burying that behind a
drawer defeats "failures shouldn't be invisible." The opacity line
above is what keeps a first-class diagnostics tab coherent rather than
looking like a principle violation.

### Frontend file layout

Follows the established sibling-section split (see
`frontend-organization.md` and the memories/wiki/cookbook trio):

- `src/screens/Samskaras.svelte` - the screen (plural; leaves the
  retired `Samskara.svelte` name free to delete). Composition + glue
  only: sub-view tab state, store wiring, the three panels' markup.
  Every transform/derivation goes in the primitives module.
- `src/lib/samskara-browse-store.svelte.ts` - the `$state` store for
  the Corpus panel: `results`, `query`, `tier`, `sort`, `offset`,
  `hasMore`, `loading`, `loadingMore`, `error`, `hideSimilarThreshold`.
  Mirrors `memories-store.svelte.ts`. Owns the browse-vs-search
  dispatch and the load-more append.
- `src/components/SamskaraBrowseList.svelte` - the Corpus sidebar list
  (per-row prediction snippet + tier badge + health/confidence chips),
  mirrors `MemoryList.svelte`. Infinite-scroll sentinel.
- `src/components/SamskaraHealthPanel.svelte` - the Health panel
  (composition only; all derivations in the primitives module).
- `src/lib/ui/samskara-browse.ts` - pure primitives: `SEARCH_DEBOUNCE_MS`,
  `emptyMessage(query)`, sort-key -> order mapping, the incremental
  greedy hide-similar collapse, tier-filter label helpers,
  count-to-noun pluralization, the health-signal -> severity/label
  transforms (e.g. "queue depth N -> ok/warn/alarm"), relative-time
  formatting. Unit-tested with vitest.

### Panel A - Corpus

A list + detail surface, the read-only reframe of the original ask.

- **List row:** prediction (truncated), `T1`/`T2` badge, and compact
  health / confidence / fire-count chips. Newest or strongest first.
- **Sort:** recent (`created_at desc`), strongest (`health desc,
  confidence desc`), most-fired (`fire_count desc`), recently-fired
  (`last_fired_at desc`).
- **Tier filter:** all / T1 / T2 segmented control.
- **Search:** semantic (embed the query, cosine on
  `prediction_embedding`) hybrid with ILIKE on prediction text, capped
  ~100, mirroring `searchMemoriesSemantic`. Empty query = paginated
  browse.
- **Hide-similar slider:** the corpus analog of the cohort dropdown's
  cluster slider. Mechanics matter because clustering and infinite
  scroll are in tension (clustering needs the whole set):
  - **slider off** - infinite-scroll browse via `listSamskarasPage`.
  - **slider on** - switch to load-all + cluster: call
    `samskara_cluster_corpus(threshold, tier)`, which greedy-clusters
    the corpus by `prediction_embedding` cosine (exactly like
    `samskara_cluster_thread_fires` but corpus-scoped) and returns
    `(samskara_id, cluster_seq, cluster_size)`. The UI shows one
    representative per cluster with a "+N similar" affordance. The
    samskara corpus is small by design (dedup targets ~150 tier-1), so
    load-all is cheap - this is honest, not a scaling risk.
- **Detail view:** prediction, inner_voice, valence/confidence/health,
  tier, fire/confirm/disconfirm counts, last-fired, age, and
  **provenance**. For a **tier-2** that provenance is the child links -
  render each child's prediction (this closes the "show a compound's
  children" gap raised earlier). For a tier-1, show the
  substrate/association provenance (counts, and substrate `situation`
  text where cheap).

### Panel B - Health

Everything computed live on open from existing rows - no metrics table,
no cron (decided). Each signal maps to a concrete pathology:

- **Backlog depths** - substrate pending assimilation (`situation is
  null`), pending embedding (`situation_embedding is null and situation
  is not null`), fires pending reaction-classify (`was_confirmed is
  null` inside the 1-10min window). A growing queue = a phase isn't
  keeping up or its worker is down. The two substrate partial indexes
  already exist for these predicates.
- **Lost signal** - fires aged out unresolved (`was_confirmed is null`
  and older than the 10-min window): turns the assistant was shaped by
  but never learned from. A high count = reaction-classify is starving.
- **Worker liveness** - read `worker_leases` (self-selectable RLS) for
  `worker_kind in ('samskara','embedding')`: holder id + `expires_at`
  vs now. Lease lapsed = no live worker = formation silently dead.
- **Staleness** - compound-summary `last_regen_at` vs the 6h/event
  regen threshold (overdue?); oldest pending-substrate `created_at`
  (how long the backlog has waited); tier-2 count plus "is a candidate
  currently available" (call `samskara_tier2_candidate`; a non-empty
  return with zero/few tier-2s hints the cosine band is mistuned).
- **Inconsistencies** - orphaned fires (`samskara_id` with no live
  samskara, via left join), claims stuck past TTL
  (`assimilate_claim_expires < now()` with a holder still set - a
  worker that died mid-claim).
- **Rates (windowed aggregate, not stored history)** - mints/day
  (`samskaras.created_at`), fires/day (`samskara_fires.fired_at`),
  reaction-resolution % (`count(was_confirmed not null) / count(*)`)
  over the last N days. Answers "is it alive and converging" without a
  time-series table.

Each signal renders with a severity (ok / warn / alarm) derived in the
primitives module from thresholds, so the panel reads at a glance.

### New reads / RPCs

All additive, read-only, `security invoker`, `auth.uid()`-scoped.

- `listSamskarasPage({ offset, pageSize, tier?, sort })` - client
  method, plain select from `samskaras` (no embedding column - too
  fat), `{rows, hasMore}`. Mirrors `listMemoriesPage`.
- `samskara_search_by_prediction(p_query_embedding, p_k_max, p_tier)`
  RPC - nearest by cosine on `prediction_embedding`, optional tier
  filter. Distinct from `samskara_fire_top_k` (which multiplies in
  health/confidence/sample-size for *firing*); browse search wants
  plain semantic similarity. Wrapped as `searchSamskarasSemantic` with
  an ILIKE hybrid, like memories.
- `samskara_cluster_corpus(p_threshold, p_tier)` RPC - greedy cosine
  cluster of the corpus, returns `(samskara_id, cluster_seq,
  cluster_size)`. Lift the algorithm from
  `samskara_cluster_thread_fires`; drop the thread scoping.
- `samskara_provenance_detail(p_samskara_id)` RPC - returns the
  provenance rows joined to their targets: for `kind='samskara'`
  (tier-2 children) the child `prediction`; for `kind='substrate'` the
  `situation`. RLS-scoped.
- `samskara_health_snapshot()` RPC - one row of the Panel B aggregates
  that want SQL (orphan-fire count, stuck-claim count, backlog depths,
  aged-out count). One round trip instead of N head-counts.
- `samskara_rates(p_days)` RPC - mints/day, fires/day, resolution % over
  the window.
- Worker liveness + compound staleness reuse a `worker_leases` select
  and the existing `samskaraGetCompoundSummary`.

### Routing / nav wiring

- Add `'samskara'` to the `DrawerTab` union and `DRAWER_VALUES`
  (`routing.svelte.ts`); add a `route.samskara_id` selection field +
  its parse/serialize + the `__test` reset.
- Add the nav button + lazy-mount in `Chat.svelte`, following the
  memories/wiki tab pattern, with a diagnostics-flavoured icon (reuse
  the pulse/fist motif so it reads as "system state," not "content").
- Repoint the mood-pill click and Logs-drawer fist-icon from
  `navigate({ modal: 'samskara' })` to `navigate({ drawer: 'samskara'
  })`; delete the `modal: 'samskara'` route value and the modal mount.

## Interactions with other features

- **Samskara (chat-loop / formation)** - read-only consumer of its
  tables; writes nothing, touches no phase. The in-chat surface is
  untouched - this is the whole point of the opacity reconciliation.
- **Routing / Chat shell** - new drawer tab + retired modal; same
  mechanism every other section uses.
- **Embeddings** - the search path embeds the query via the same
  `venice/embed` proxy the rest of the app uses; the health panel reads
  the embedding worker's lease + the substrate embed backlog but drives
  nothing.
- **Logs drawer** - loses the fist-icon-opens-modal wiring, gains
  fist-icon-opens-tab. The worker's log breadcrumbs remain the deep
  per-cycle trace; this section is the structured snapshot on top.

## Gotchas to bake in

- **Read-only is load-bearing, not a v1 shortcut.** Adding delete/pin
  later re-opens the "operator curates the bias model" question the
  opacity reconciliation sidesteps. If curation is ever wanted, it's a
  deliberate separate decision with its own doc, not a quiet follow-up.
- **Hide-similar switches data mode.** Slider off = paginated browse;
  slider on = load-all + cluster. Don't try to cluster a partially
  scrolled infinite list - the cluster assignment would shift as you
  scroll. The bounded corpus is what makes load-all acceptable; if the
  corpus ever blows past the dedup target, revisit.
- **Browse search != fire ranking.** `samskara_search_by_prediction`
  is plain cosine; `samskara_fire_top_k` is cosine x health x
  confidence x sample-size. Using the fire ranker for browse would bury
  weak-but-relevant samskaras the operator most wants to see. Keep them
  separate; comment both.
- **No embeddings on the wire for the list.** `listSamskarasPage`
  omits `prediction_embedding` (2048 floats x hundreds of rows). The
  hide-similar cluster runs server-side and returns only assignments.
- **Health thresholds are guesses until observed.** The ok/warn/alarm
  cutoffs (queue depth, lease-age, overdue compound) start as
  reasonable defaults in the primitives module and want tuning against
  real pipeline behaviour. Keep them named constants, not inline
  magic.

## Testing

- `src/lib/ui/samskara-browse.ts` primitives - vitest: sort-key
  mapping, the greedy hide-similar collapse, health-signal severity
  classification, empty-message and pluralization helpers. Pure
  functions, no mount.
- Store - the browse-vs-search dispatch and load-more append, mirroring
  the memories-store tests if they exist.
- The new RPCs have no vitest path (no DB in the unit suite) - validate
  via `mise run sync` + a manual SQL exercise, and flag the gap in the
  PR per the cloud-agent posture.
- No automated end-to-end render coverage exists; the PR must call out
  the unverified visual/interaction layer (empty/loading/error states,
  the slider mode-switch, mobile-narrow, dark-mode) for manual sanity.

## Sequencing

1. **Schema** - the four read RPCs (`samskara_search_by_prediction`,
   `samskara_cluster_corpus`, `samskara_provenance_detail`,
   `samskara_health_snapshot`, `samskara_rates`). Apply via `mise run
   sync`; exercise by hand.
2. **supabase.ts** - the wrappers + `listSamskarasPage` + the
   `worker_leases` liveness read.
3. **Primitives + store** - `samskara-browse.ts`, the browse store.
   Unit-test.
4. **Components** - `SamskaraBrowseList.svelte`,
   `SamskaraHealthPanel.svelte`, the `Samskaras.svelte` screen with its
   three sub-views; move the modal's compound-summary + mood-legend
   markup into the Summary & Mood sub-view.
5. **Routing + nav + retire modal** - drawer tab, `route.samskara_id`,
   nav button, lazy-mount; repoint pill + Logs fist-icon; delete the
   modal and its `modal:'samskara'` route value. This is the "collapse"
   step - do it last, once the new home is wired and rendering.
6. **Docs** - rewrite `samskara.md`'s opacity Gotcha + the Settings/UI
   Interactions to document the operator-surface-vs-conversation line;
   add the section to `docs/user/` (new observable UI = user-doc
   update per the repo rule). Update the components inventory.

Bounded blast radius: the chat loop, fire path, and formation worker
are untouched. The risk is concentrated in the new screen + five read
RPCs + the modal retirement.
