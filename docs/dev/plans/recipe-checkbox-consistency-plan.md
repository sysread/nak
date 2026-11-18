# Recipe checkbox consistency plan (grocery bridge + cooking mode)

Status: SHIPPED 2026-11-18 (M1-M4 all landed on the branch; QA
baseline + post-change rows logged in
`docs/qa/use-cases/cookbook-cooking-mode.md`). Two deltas from the
text below, found in QA: (1) Add-all's ordering flipped from
"drain, then register" to "register synchronously in the click's
own tick, THEN drain" - the QA probe's same-tick dispatch sailed
past a registration that was deferred behind a microtask and
double-created the product; the tap guard now reads the same
reactive `pendingNames` set the batch registers into (one source of
truth; the per-name controller shape was deleted). (2) The
pending-lifecycle and switch-clear behaviors are component wiring
covered by the QA use-case rather than extracted-primitive tests;
the tested primitives are the generation-guard factory, the
register/without set transforms, the optimistic-mark sync, and the
session-map queue.

Read [`../cookbook.md`](../cookbook.md) (Cooking mode, Records) and
[`../grocery-list.md`](../grocery-list.md) (The recipe bridge, the
store refresh model) first; this plan assumes their vocabulary.

## SYNOPSIS

Make both ingredient-checkbox flows on the recipe detail pane safe
under rapid and overlapping taps. Five changes: (1) a write queue in
the shared session-map mutator so cooking-mode marks (and the
shopping-trip toggle) apply strictly in order, each bounded by the
existing 15s abort timeout, (2) an optimistic cooking used-mark with
latest-tap-wins settle semantics and rollback, (3) a generation
guard plus keep-prior-data on the recipe's grocery-items reload
with an explicit recipe-identity reset, (4) per-name pending guards
on the bridge taps (spinner in the check slot, mid-save re-taps
ignored, emit on success only), and (5) the "Add all to grocery
list" batch writer brought under the same discipline.

## PURPOSE

Both checkbox flows lose state under concurrency - the same failure
class the at-store check-off rebuild killed on the grocery side
(commit 1613cd87), reported by the user on 2026-11-17 for both
recipe flows. Four concrete races:

1. **Cooking-mode marks stomp each other.** Every mark does a fresh
   read of `profiles.settings`, mutates the `activeSessions` map,
   and writes the whole map back via the merge RPC
   (`src/lib/supabase/settings.ts:332-338`). The merge RPC is
   atomic per top-level settings key
   (`src/lib/supabase/settings.ts:104-114`), but `activeSessions`
   IS one top-level key, so two marks whose reads both precede the
   other's write converge to last-write-wins: the first mark
   vanishes. The mark handler never sets the busy flag it checks
   (`src/screens/Cookbook.svelte:1402`; only `toggleCooking` at
   `:1371` sets it), so same-tab rapid taps are not serialized
   either. After each write the UI re-derives from what landed
   (`:1412`), so the lost mark visibly unchecks - the stomp the
   user sees while cooking.
2. **Bridge reloads race and revert checkboxes.** The reload fired
   from the toggle's `finally` and the one fired by the
   grocery-change subscription (which both the Groceries tab event
   and the realtime echo feed,
   `src/screens/Cookbook.svelte:1079-1092`, `:1094-1099`,
   `:1283-1288`) run unserialized with no generation guard. A
   stale snapshot landing last wins and the sync
   effect (`:1145-1171`) reverts the just-tapped checkbox - the
   exact race the shopping-trip rebuild fixed in `loadGroceries`.
3. **One failed reload unchecks every box.** A failed reload
   assigns `[]` (`src/screens/Cookbook.svelte:1088-1091`), wiping
   all checkbox state from a transient network error instead of
   keeping the prior data.
4. **Racing creates duplicate products.** The bridge handler reads
   component state to decide revive-vs-create
   (`src/screens/Cookbook.svelte:1253`); a fast double-tap on the
   same ingredient reads pre-write state twice, and product
   creation is a bare insert
   (`src/lib/supabase/grocery.ts:396-437`) - the "(recipe, name) is
   unique" rule is only the client-side name probe. Two racing taps
   can spawn two products, each with its own open entry.

## DESCRIPTION

### How the two flows behave today

Default mode: tap -> read `recipeGroceryItems` state -> revive /
create / remove via one awaited RPC -> refetch + emit in `finally`
(`src/screens/Cookbook.svelte:1238-1290`). The sync effect derives
checked state from the refetched items; checkbox state is never
held locally, so reload ordering is the state machine.

Cooking mode: tap -> `updateActiveSessions` (fresh read -> mutate
the used list -> merge-RPC write of the whole map) -> re-derive
`usedRows` from the post-write settings
(`src/screens/Cookbook.svelte:1399-1423`). Every mark pays two
round trips and interleaves freely with every other mark.

The fresh-read discipline itself is documented intent for
cross-FEATURE safety ("a session another surface added in between",
`src/lib/supabase/settings.ts:318-327`); nothing in history scopes
it to mark-vs-mark, and the merge RPC's comment names only
tierModels / systemPrompts as the intended atomic snapshots. The
queue below strengthens the existing contract; it does not invent
one.

### Change 1: serialize the session-map write path

`updateActiveSessions` (`src/lib/supabase/settings.ts:332-338`)
chains all callers through a promise queue keyed per client
(WeakMap on the client instance, so a new client - sign-in, test
harness - starts a fresh chain and no test or sign-out bleeds into
another chain): each mutation's fresh read + merge write runs
strictly after the prior queued mutation completes, and its mutate
closure therefore sees every earlier write. Same-client marks can
no longer clobber each other; ordering matches tap order.

Every mutation's read and write is bounded by the shared 15s
abort-timeout idiom the check-off rebuild established
(`REQUEST_TIMEOUT_MS`, today exported at
`src/lib/grocery-store.svelte.ts:52`). The bound moves to a
rune-free module (the data layer must not import a UI rune store),
and the grocery store imports it from there. The queue applies the
bound as a Promise.race-style rejection wrapper with an injectable
bound value (default: the shared constant), not by threading
AbortSignals through the settings slice - supabase-js sets no
fetch timeout, and a never-settling request would otherwise stall
the chain: every future session-map write (cooking marks,
`toggleCooking`, the shopping-trip toggle at
`Groceries.svelte:158`) queues behind it. A timeout surfaces as
an ordinary rejection.

Errors propagate to the caller as today; the queue never swallows
a rejection - the chain advances on the next enqueued mutation
regardless. All existing callers serialize automatically; no
caller changes.

### Change 2: optimistic used-mark in cooking mode

The mark handler flips `usedRows` locally at tap time (instant
strikethrough feedback) and enqueues the write. Settle semantics
are per-recipe latest-tap-wins, enforced by a monotonic local tap
counter:

- On settle, the handler applies `applyCookingSessions` from the
  returned (success) or freshly re-fetched (failure) settings ONLY
  if no newer tap for this recipe is still outstanding. A newer
  tap's own settle applies the union; the older tap never flips the
  row back - the transient wrong state a naive re-derive-on-success
  produces (tap mark, tap unmark, first write lands, row flips back
  until the second write lands) cannot happen.
- Failure keeps the existing rollback discipline: fresh
  `getSettings`, re-derive (`src/screens/Cookbook.svelte:1414-1421`).
- A write that landed as a no-op rolls back through the same path:
  the used-array mutator returns the map unchanged when the session
  entry is gone (`src/lib/ui/active-sessions.ts:158-160` - session
  ended, expired, or stop queued ahead), the returned settings lack
  the key, and the latest-tap apply re-derives the row as unchecked.
- The session-load effect (`:1346-1361`) gets the same generation
  guard, and its apply is gated against settled session-map writes:
  without it, a switch A->B->A lets recipe A's stale switch-back
  fetch overwrite a mark that settled in between. The generation
  guard alone is not enough there - the switch-back fetch IS the
  latest run and A IS current - so the fetch records the queue's
  settled-write count at start and skips the apply if any
  session-map write settled while it was in flight. A double
  failure (write fails AND its rollback refetch fails) strands the
  optimistic flip until the next successful write; the handler
  comment names that case.

Rapid taps on the same row (mark then unmark) queue in order and
converge correctly. `cookingBusy` keeps guarding only start/stop.
`applyCookingSessions` gains an apply-time currency check
(`id === activeId`) at all call sites so a write resolving after a
recipe switch cannot stamp recipe A's marks onto recipe B's pane -
pre-existing, but Change 2 rewrites this handler.

### Change 3: generation guard + keep-prior + recipe identity

`loadRecipeGroceryItems` takes the start-order generation counter
pattern from the shopping-trip rebuild (`loadGroceries`,
`src/lib/grocery-store.svelte.ts:140-217` - capture at start, gate
every state write including the loading clear on still-current).
As an extraction into `src/lib/ui/cookbook-screen.ts` it is a
factory returning a guard closure (a bare counter cannot be shared
as a plain function); both existing instances are inline, this
would be the first extracted one.

Recipe identity: the switch effect (`:1094-1099`) clears
`recipeGroceryItems` synchronously on `activeId` change, restoring
an explicit wipe for the switch case. Keep-prior then applies ONLY
to a failed fetch for the still-current recipe - the accidental
wipe-to-`[]` today is what currently prevents a failed post-switch
fetch from rendering recipe A's items under recipe B, and this
makes that guard explicit instead of load-bearing-by-accident. The
pending and classifying name sets clear on the same switch (they
are component-level today; a slow write for recipe A's "garlic"
must not spin or block recipe B's).

Bridge writes and reloads ride the shared 15s bound as Change 1 -
the CONSTANT is shared, the mechanism is per-site (Change 1's
queue uses the race wrapper; the bridge uses `AbortSignal.timeout`
where the call accepts a signal and the race wrapper where the
slice function takes none, which may touch
`src/lib/supabase/grocery.ts` signatures): a hung fetch cannot
leave a row's spinner stuck forever - the failure mode the
check-off rebuild called out and paired with its spinner pattern.

### Change 4: per-name pending guards on bridge taps

Mirror the existing `classifyingNames` spinner set
(`src/screens/Cookbook.svelte:1106`): a `pendingNames` set keyed
by normalized ingredient name. Lifecycle per tap: the name enters
the set; the write runs; the reload settles (success or
keep-prior); only then the name leaves the set. Consequences that
are load-bearing, not incidental:

- The guard holds through the whole flight: a mid-save re-tap is
  ignored and cannot double-create.
- The name leaves on settle, success OR failure - a failed write
  must not strand the row's spinner.
- The name leaves only after the reload settles, so the sync
  effect does not re-run that name's reconciliation on the stale
  pre-write snapshot and revert the box. (Multi-name concurrency
  keeps one transient window: a name whose own finally-reload was
  generation-discarded reconciles against a newer snapshot that
  may predate its just-committed write - one echo-round-trip flash
  until the echo reload lands, strictly better than today's
  permanent revert. Accepted.)
- While pending, the checkbox renders the spinner: the sync effect
  treats a name as busy when `pendingNames OR classifyingNames`
  contains it (union, reusing the `.cook-buy-busy` CSS path). For
  busy names the effect assigns checked state from neither set's
  data and disables the input - the busy class and disabled
  attribute still apply (that is the spinner and the dead tap);
  only the checked-state reconciliation is skipped so a reload
  landing mid-write cannot flicker the row.
- The classifier's registration and cleanup re-check recipe
  currency (`id === activeId`): without it, a create write settling
  after a switch re-adds recipe A's name to the component-level
  set and recipe B's same-named row spins and dies.
- The refetch stays in the handler's `finally` - on failure too -
  which is the mechanism that restores the natively-toggled input
  to server truth; only `emitGroceryChange` moves to the success
  path (a failed write produces no server change, so there is
  nothing for the nudge to accelerate; the classifier path already
  emits conditionally, `:1130`).

### Change 5: "Add all to grocery list" under the same discipline

The batch button is a sibling writer of the same products
(`onAddAllIngredients`, writes in a loop, emits in `finally`). The
race runs in BOTH directions: racing an in-flight single-tap
create, its probe reads pre-write state and double-creates; a
single tap starting mid-batch probes the same pre-write state and
misses the product the batch is creating - a window N sequential
RPCs wide, wider than the single-tap race. Both directions close
with the same set, in this exact order: Add-all first waits for
the names pending BEFORE it started (awaiting a set that already
contains its own names would deadlock on itself), then
synchronously - with no await between - registers each batch
name in `pendingNames` and runs its probe; the single-tap guard
then ignores those names until the batch settles. Its emit
stays in `finally`: a partial batch failure HAS landed server
changes, so the nudge is correct there - the emit-on-success rule
is a single-write rule.

### State and transition matrix

Per-checkbox input state (one input, `data-ing` name, `data-row`
ordinal). Cooking mode branches the semantics; the sync effect owns
every assignment (the render is `{@html}` markup).

| State | Meaning | Entered when | Exits when | Tap allowed? |
| --- | --- | --- | --- | --- |
| `unchecked` | Bridge: no matched product or it is off-list. Cooking: row not in `usedRows`. | Initial render; server truth says unchecked; failed write rolled back; recipe switch cleared. | Tap; server-side list change via reload. | yes |
| `checked` | Bridge: matched product `on_list`. Cooking: row in `usedRows`. | Initial render; optimistic mark; reload lands on-list. | Tap; server truth changes via reload; optimistic rollback (failure or no-op). | yes |
| `pending` | This name's write is in flight; spinner in the check slot (`cook-buy-busy`). | Bridge tap accepted (new, per-name). | Reload after the write settles (success or failure) -> name leaves `pendingNames`. | ignored (input disabled via the busy union; handler guard backstops) |
| `classifying` | Section classifier in flight for this name. | After a successful create enqueues `classifyRecipeProducts`. | Classifier settles -> name leaves `classifyingNames`. | disabled (existing behavior) |

Precedence rules when two transitions compete:

- Busy rendering: `pendingNames` union `classifyingNames` decides
  the spinner/disabled state; they are sequential in practice
  (classify enqueues only after the create succeeds) but the sync
  effect ORs them explicitly.
- Server-truth application (reload landing) wins over the local
  state change ONLY on a failed-write or no-op rollback - the
  "local state change" being the optimistic `usedRows` flip in
  cooking mode, the native DOM toggle of the checkbox in bridge
  mode; while pending, the sync effect skips only checked-state
  reconciliation, so a reload landing mid-write cannot flicker
  the row.
- Cooking-mode marks settle latest-tap-wins (Change 2); an older
  tap's settle never overwrites a newer tap's optimistic flip.
- Mode precedence: `cookingActive` true routes taps to the used-
  mark handler and the bridge writes never run (existing branch,
  `src/screens/Cookbook.svelte:1242-1245`).
- Recipe currency: applies of grocery items or cooking-session
  state check `id === activeId` at apply time (Changes 2-3); a
  resolution after a switch never stamps across recipes.

Session-level state: cooking session `inactive -> active` via
`toggleCooking` (busy-guarded, queued write), `active -> inactive`
the same way; shopping trip and other recipes' sessions live
beside it in the same map and survive every mark write (the
queue's mutate closures add/remove only their own key's data).
The apply-time currency guard is the one session-path behavior
this plan adds.

Failure surfaces: bridge failed writes keep prior checkbox state
and stay silent - the silence matches today (no bridge error line
exists; the keep-prior recovery is the new part) - a deliberate
divergence from the check-off rebuild's one-line error, accepted
here because the detail pane has no error slot and the
checkbox reverts on the next good reload. Cooking failed marks
roll back and surface via the existing `cookingError` line.

### Tests

- Write-queue serialization (new file
  `tests/supabase-settings.test.ts` - NOT `tests/settings.test.ts`,
  which tests the Settings-modal copy helpers): two concurrent
  `updateActiveSessions` calls against a stubbed client produce
  sequential read->write->read->write and the second mutate sees
  the first's write; a failed first mutation does not block the
  second; a hung (never-settling) mutation times out at an
  injected bound (the production default is the shared constant;
  tests inject a short one - `AbortSignal.timeout` is not
  clock-interceptable) and the chain advances. Stub patterns to
  copy: the deferred-
  promise client in `tests/grocery-store.test.ts:22-36,84-133` and
  the stubbed-`SupabaseClient` shape in
  `tests/skills-slice.test.ts:85-96`. The per-client chain gives
  per-test isolation (each test news its own client); drain the
  chain at teardown anyway.
- Generation-guard factory: late-resolving older fetch loses,
  newer snapshot wins, failed fetch keeps prior items, switch
  clears (`tests/cookbook-screen.test.ts`, pure functions, node
  environment - no `environmentMatchGlobs` change needed).
- Pending-name guard primitive: re-tap ignored while pending, name
  leaves on settle (success and failure), name leaves only after
  the reload settles.
- Optimistic mark primitive (fetch/write functions injected):
  tap flips locally, latest tap wins the settle, failure and no-op
  rollbacks re-derive from fetched truth; the settled-write gate
  skips the session-load apply when a write settled mid-fetch.
- Add-all drain primitive: drains only the names pending before it
  started (no self-deadlock), registers its own names
  synchronously, single-tap during the batch is ignored.
- Primitives and their tests land with or before the handler
  rewiring in M2/M3 - the component wiring itself stays covered by
  the QA use-case (the established bar: no screen in this repo has
  a mounted-component test).

### QA use-case

`docs/qa/use-cases/cookbook-cooking-mode.md` gains rapid-tap steps
(tap N marks in quick succession; all N survive, none uncheck) and
the bridge races (double-tap one ingredient; single product, no
duplicate; single-tap then Add-all and Add-all then single-tap in
both orders; network death mid-mark and mid-bridge-write; recipe
switch with a write, reload, classification, and the session-load
fetch each in flight). Per the QA rules, execute the existing
steps as the baseline BEFORE the code change, then re-execute and
log both runs.

### Docs

- `docs/dev/cookbook.md` Cooking mode: the write queue (per-client
  chain), the timeout bound, the optimistic mark with
  latest-tap-wins + rollback, the apply-time currency guard, and
  the cross-device note extended: no realtime relay covers
  `profiles.settings`, so a mark lost to another tab's write shows
  optimistically checked in that tab until its next settings read
  - accepted last-write-wins, documented
  (`docs/dev/cookbook.md:474-476`) still holds.
- `docs/dev/cookbook.md` + `docs/dev/grocery-list.md` recipe
  bridge: the generation guard, keep-prior + switch-clear, the
  pending-name lifecycle (settle-based exit, emit-on-success,
  reload-in-finally as the un-flip mechanism), and the Add-all
  drain.
- `docs/user/cookbook.md` documents both checkbox flows
  (`:217-225`, `:315-316`); the spinner-on-tap and the consistent
  rapid-tap behavior are observable changes - update those
  sections in the same PR per the user-docs rule.

## DECISIONS

- **No DB uniqueness constraint for recipe products in this
  change.** `normalizeGroceryName` is trim + lowercase
  (`src/lib/ui/grocery-list.ts:56-58`), so a partial unique index
  on `(user_id, recipe_id, lower(btrim(name)))` where
  `recipe_id is not null` would mirror it faithfully - but adding
  it requires a dedupe migration for existing duplicates and a
  conflict-handling path in every create caller (bridge, Add-all,
  chat tool, Groceries screen). The pending guard + Add-all drain
  close the observed same-tab cases; the residual cross-surface
  risk (checkbox + chat tool within one round trip) is accepted
  and revisited if dupes appear in practice.
- **Cross-device last-write-wins in the session map stays
  accepted.** The queue serializes one client; the doc's existing
  "two devices concurrently" note
  (`docs/dev/cookbook.md:474-476`) remains true and deliberate.
- **No schema changes.** All changes are browser-side; the
  server-side per-toggle merge RPC alternative was evaluated and
  rejected (schema change, bypasses the client-side shape
  scrubber, strands the expiry-prune policy, and covers only race
  1 of 4).
- **No optimistic bridge checkboxes.** The bridge's checked state
  stays derived from the refetched items (revive/create/remove
  have server-side effects the refetch must confirm); the pending
  spinner plus the generation guard deliver the consistency. Only
  cooking mode holds local state, where a mark is a pure toggle.
- **Bridge failures stay silent.** Divergence from the check-off
  rebuild's revert-plus-one-line-error, kept because the detail
  pane has no error slot; the keep-prior reload is the visible
  recovery.
- **The cookingBusy check in the mark handler stays as-is** (it
  guards against marking mid start/stop transition; making marks
  set it would re-serialize them twice - the queue already orders
  them). No comment history records why it never set the flag;
  treated as an inconsistent half-guard, harmless under the queue.

## MILESTONES

1. **M1 - session-map write queue** in
   `src/lib/supabase/settings.ts`: per-client chain, shared
   15s timeout bound extracted to one home, timeout + serialization
   tests in the new `tests/supabase-settings.test.ts`. Tests land
   with the queue. Fixes race 1's mechanism for every session-map
   writer.
2. **M2 - cooking optimistic mark**: latest-tap-wins settle, no-op
   rollback, apply-time currency guard
   (`src/screens/Cookbook.svelte`), primitive (injected
   fetch/write) + tests in `tests/cookbook-screen.test.ts` landing
   with the handler change. Instant feedback; rollback stays the
   failure path.
3. **M3 - bridge guards**: generation-guard factory +
   switch-clear + keep-prior, per-name pending lifecycle (settle-
   based exit, union spinner, reload-in-finally), emit-on-success,
   Add-all drain, shared timeout on writes and reloads
   (primitives in `src/lib/ui/cookbook-screen.ts`, tests landing
   with the rewiring). Fixes races 2-4.
4. **M4 - docs + QA**: the doc edits above; baseline + post-change
   QA runs logged in `cookbook-cooking-mode.md`.

Gate: `mise run check` green before each commit; markdownlint for
M4.
