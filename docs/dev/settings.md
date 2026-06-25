# Settings

The settings modal plus everything it persists: the panes (About,
Appearance, Memory, Wiki, AI, Custom prompts, Usage, Security, API
keys), the `profiles.settings` JSONB blob they read from and write to,
and the theme system that lives alongside.

## Role in the app

Settings is the user-visible control surface for every
preference the app holds. Each pane targets a different persistence
destination. Panes are ordered in the nav by nearness of subject to
the user - the app itself first, then the user's own presentation
and personal data, then the assistant, then the
account/infrastructure tail furthest from day-to-day use. The modal
opens on the first tab in `GROUPS`, so the nav order and the default
landing tab move together.

- **About** — build fingerprint (commit SHA + build time) and the
  "Check for updates" / "Reload to update" action. Read-only; the
  values come from `$lib/update.svelte` which Vite populates at
  build time via `define`. See `./build-deploy.md` for the
  version-detection pipeline.
- **Appearance** — color mode + accent, plus the default log
  level for the Logs drawer. Theme controls live-apply on click
  (no Save button); they mirror to `profiles.settings` (and
  localStorage for the boot script).
- **Memory** - the memory-librarian toggle. Enables the autonomous
  agent that consolidates, fills relations, and soft-deletes
  contradictions in the memory store. Persists to
  `profiles.settings.memoryLibrarianEnabled`. There is no Memories
  browser here - memories live behind the **Memories** drawer tab
  next to Chats / Recipes / Journal, which is its own prominent
  affordance and doesn't need a redundant pointer in Settings.
- **Wiki** - two independent toggles plus a destructive reset.
  **Automatic wiki** gates the autonomous article-writing agent;
  **Librarian** gates the periodic reorganization pass
  (deduplication, fact-checking, boundary tightening). Both persist
  to `profiles.settings` (`wikiAutomaticEnabled` /
  `wikiLibrarianEnabled`). **Reset** is a confirmed-irreversible
  wipe of every wiki article plus the per-thread wiki pipeline
  state.
- **AI** — per-tier model + reasoning configuration, default reasoning
  effort, default
  verbosity, the "Emphasis markdown" opt-in (a bionic-style scan
  aid - when on, chat-loop folds a short formatting blurb into
  the per-turn system-prompt appendix so the model bolds terms
  and italicises phrases), reply notifications (an opt-in
  completion notification persisted on
  `profiles.settings.notifyOnComplete`; enabling prompts for the
  browser's Notification permission), the **About you** profile
  fields (`userName` / `userLocation`, free-form strings injected
  into the per-turn appendix's "User profile" block - opt-in, both
  blank skips the block), and the **Working intentions** opt-in
  (`profiles.settings.intentsEnabled`, default OFF - gates the whole
  intents pipeline: minting sweep, efficacy evaluation, and the
  `applyIntentPriming` system-prompt block; see
  [`in-progress/intents.md`](./in-progress/intents.md)). All preferences
  persist to `profiles.settings`. The system-prompt library used to live
  here too but moved to its own **Custom prompts** pane (below) - the
  prompt cards are tall and pushed the Models layout below the fold.

  The **Models** subsection is the per-tier configuration UI: each of
  Smart/Balanced/Fast gets a fuzzy-search model combobox
  (`ModelCombobox`, populated from the live Venice catalog via
  `models-catalog.svelte.ts`, with per-row capability/context/price
  columns), a reasoning-effort dropdown, a default-tier radio, and a
  capability/context/price strip on the row itself.
  Picking a model or reasoning level writes a `TierModelConfig` snapshot
  into `profiles.settings.tierModels[tier]` (via `persistTierModels`);
  the chat send path reads it back through `effectiveTierSpec(tier,
  app.tierModels)`. The snapshot carries the chosen model's capabilities
  so resolution stays synchronous - the catalog is only needed while the
  pane is open, fetched lazily on first AI-pane visit with the same
  staleness/error-guard shape as the Usage pane. See
  [Models & tiers in Chat](./chat.md) for the resolution cascade and the
  `TierModelConfig` snapshot rationale.
- **Custom prompts** — the named system-prompt library
  (`profiles.settings.systemPrompts`, a `SystemPrompt[]`). Each card is a
  name + "Default" checkbox + delete + body textarea; the list autosaves
  (debounced 500ms) on add / edit / delete / reorder, pushing the whole
  array through `persistSystemPrompts` -> `updateSystemPrompts` (wholesale
  replace, not per-prompt). Cards reorder by **drag** - a grip handle
  carries `draggable=true` (so dragging from inside the name input or body
  textarea still selects text) and the cards are the drop targets; native
  HTML5 DnD, so it is pointer-only (no keyboard / touch reorder). The pure
  list transforms (add / update / delete / reorder / the resync equality
  check) live in `src/lib/ui/prompts.ts`. The order in the array is the
  order shown in the chat composer's prompt toggles.
- **Usage** — a date-ranged snapshot of per-model token spend
  against the Venice API key. Read-only: it calls Venice's beta
  `/billing/usage` endpoint and aggregates the rows client-side.
  The default rolling-7-day window is cached in
  `usage-store.svelte.ts` and fetched lazily the first time the
  user lands on this pane in the session; opens within
  `USAGE_STALE_MS` reuse the cache, opens after it re-fetch.
  Custom date ranges bypass the cache and fetch on-demand. Nothing
  persists to disk — the cache is in-memory only and gets wiped on
  sign-out (`resetForSignOut`). While paging through
  a wider window, `fetchUsage`'s `onProgress` callback feeds a
  `pagesLoaded`/`pagesTotal` pair into both the shared store and
  the pane's custom-range state. The pane renders a thin progress
  bar between the controls and the totals strip the moment loading
  starts: an indeterminate marching variant while `pagesTotal`
  is still 0 (the wait on Venice's first-page response, which is
  the slowest step), then a determinate fill once the count is
  known, with the **Refresh** button label adding `Loading… N/M`
  in the determinate phase. The totals strip itself pairs each
  currency's total spend pill with an avg-per-day pill that
  divides the total by the inclusive day count of the picked range.
- **Security** - rotates the Supabase account (login) password. It
  re-verifies the current password by re-signing in, then calls
  Supabase `updateUser` to set the new one. There is no master
  password any more - the local config is plaintext - so this is
  the only password the pane touches.
- **API keys** — the Supabase URL + publishable key the browser
  uses to reach the project. Saving rewrites the plaintext
  `nak:config:v2` localStorage entry and re-activates the in-memory
  services with the new values. The Venice key is not here - it
  lives server-side in `app_config`, read by the edge function. An
  **Export** subsection downloads those two values as a plaintext
  JSON file for re-import on another browser - read-only, no
  persistence change.

Theme is tightly coupled to Settings (the Appearance pane drives
every update) so it's covered here rather than in its own file.

## Files

- `src/screens/Settings.svelte` — the modal; the pane nav +
  backdrop dismiss + Escape handling. `GROUPS` defines the tab
  order; the leading comment documents the ordering principle.
- `src/lib/update.svelte.ts` — reactive build fingerprint +
  service-worker update registration. Backs the About pane and the
  top-right `UpdateBanner`. Reads the Vite-`define`'d globals
  `__APP_COMMIT__` / `__APP_BUILD_TIME__` (see `./build-deploy.md`).
- `src/components/UpdateBanner.svelte` — fixed top-right "new
  version available" pill, driven by `updateState.available`.
  Mounted once in `App.svelte` so it appears across every phase.
- `src/lib/state.svelte.ts` — setters that Settings calls
  (`setDefaultModel`, `persistTierModels`, `setDefaultReasoningEffort`,
  `setDefaultVerbosity`, `setEmphasisMarkdown`,
  `setSystemPrompts`, `setTheme`, `setWebSearchEnabled`).
- `src/lib/models/catalog.ts` — `CatalogModel` type + `coerceCatalog`,
  the defensive flatten of Venice's `GET /models` response. Pure,
  unit-tested offline.
- `src/lib/models-catalog.svelte.ts` — reactive cache for the live
  model catalog backing the AI pane's tier dropdowns. Same shape as
  `usage-store.svelte.ts` (lazy-on-open, 15-min staleness, lock-reset);
  exposes `catalog`, `refreshCatalog`, `resetCatalog`,
  `shouldAutoRefreshCatalog`, `isCatalogStale`, `CATALOG_STALE_MS`.
- `src/lib/ui/prompts.ts` — pure list transforms for the Custom prompts
  pane: `createPrompt`, `addPrompt`, `updatePrompt`, `deletePrompt`,
  `reorderPrompts` (the drag-reorder array move), and `promptsMatch` (the
  by-value equality that backs the resync-from-Supabase guard). Unit-tested
  in `tests/prompts.test.ts`.
- `src/lib/ui/model-picker.ts` — pure UI primitives for the picker:
  `tierRowView` (row view-model), `buildModelOptions`, `capabilityChips`,
  `formatContextWindow`, `formatPricing`, `tierConfigFromCatalog`,
  `tierConfigFromSpec`, plus the combobox's `fuzzyMatch` /
  `filterModelOptions`.
- `src/components/ModelCombobox.svelte` — the fuzzy-search model picker
  (subgrid-aligned rows; combobox/listbox a11y). See `./components.md`.
- `src/lib/models/index.ts` — `TierModelConfig` / `TierModels`,
  `coerceTierModels`, and `effectiveTierSpec` (folds a user override over
  the built-in TierSpec).
- `src/lib/supabase.ts` — `getSettings`, `updateSettings`,
  `updateSystemPrompts`. `updateSettings` validates the patch
  then writes atomically via the `merge_profile_settings` RPC
  (`supabase/schema.sql`); `getSettings` reads the
  `profiles.settings` JSONB column.
- `src/lib/venice.ts` — `VeniceClient.fetchUsage` + `UsageRow` /
  `UsageCurrency` types. Backs the Usage pane; pages through
  `/billing/usage` transparently up to `USAGE_MAX_PAGES`
  (20 × 500 rows = 10k rows) and coerces each row defensively
  before returning.
- `src/lib/usage-store.svelte.ts` — reactive cache for the Usage
  pane's default rolling-7-day window. Nothing runs at boot; the
  Settings pane drives the first fetch via `refreshUsage`. Wiped
  by `state.svelte.ts::resetForSignOut()` via `resetUsage` so rows
  tied to the prior Venice key don't leak into the next sign-in.
  Exposes
  `usage` (the `$state` rune), `refreshUsage`, `resetUsage`,
  `isUsageStale`, plus the `USAGE_STALE_MS` constant.
- `src/lib/config.ts` — `saveConfig` (keys pane). The Security
  pane's password rotation lives in `supabase.ts`
  (`changeAuthPassword`), not here.
- `src/lib/theme.ts` — `ColorMode`, `Accent`, `applyTheme`,
  `cacheTheme`, `readCachedTheme`, `effectiveMode`.
- `index.html` — the inline boot script that applies cached
  theme attributes before first paint.

## Entry points

- **Gear button in `Chat.svelte`** — flips `showSettings` to
  true. `Chat.svelte` renders `<Settings onClose={() =>
  navigate({ modal: null })} />` as a mutually-exclusive phase
  branch.
- **Backdrop click / Escape** — both dismiss. Backdrop
  discriminates by `e.target === e.currentTarget` so clicks
  inside the shell don't trigger close.
- **AI pane save** — per-pane form submission. Each pane
  calls its own Supabase writer via `app.supabase.updateSettings`.
- **Appearance live-apply** — `onPickMode` /
  `onPickAccent` call `setTheme(mode, accent)` from the state
  store, which updates DOM attributes + cache + reactive
  state synchronously, then fires
  `app.supabase.updateSettings` fire-and-forget for server
  persistence.
- **Usage pane on-open fetch** — nothing runs at boot. An
  `$effect` in `Settings.svelte` watches `group`: when the user
  lands on the Usage tab AND the cached data is null OR older
  than `USAGE_STALE_MS` (15 minutes), it calls `refreshUsage`
  from `$lib/usage-store.svelte`. The pane reads from the
  reactive `usage` store, so a re-open within the staleness
  window shows the cached numbers without a loading flash; an
  open after the window re-fetches automatically. User-picked
  custom date ranges bypass the store entirely — a second
  `usageSource = 'custom'` branch fetches into component-local
  state so a non-default fetch doesn't evict the cached default
  view. The Refresh button routes through whichever source
  matches the current date pickers. The cache is in-memory only
  and is wiped on sign-out (`resetForSignOut`) so rows billed
  against the previous Venice key don't leak into the next
  sign-in.
- **Security pane submit** — `changeAuthPassword(current, new)` in
  supabase.ts (rotates the Supabase login). Settings catches errors
  and displays them inline.

## Data model

- **`profiles.settings`** — JSONB column. No per-field schema.
  Known keys today:
  - `defaultModel`: `ModelTier`
  - `tierModels`: `Partial<Record<ModelTier, TierModelConfig>>` — per-tier
    model + reasoning overrides. Each `TierModelConfig` is a capability
    snapshot (`modelId`, `thinking`, `contextWindow`, `supportsReasoning`,
    `supportsVision`, `supportsResponseFormat`, `label`) so the chat send
    path resolves a configured tier without the async catalog. Absent
    tiers fall back to the built-in `TierSpec`. Validated by
    `coerceTierModels` on read; a malformed entry degrades to the
    built-in default rather than poisoning resolution.
  - `defaultReasoningEffort`: `ReasoningEffort`
  - `defaultVerbosity`: `Verbosity` (`'low' | 'medium' | 'high'`);
    absent falls back to `DEFAULT_VERBOSITY` (`medium`)
  - `colorMode`: `ColorMode`
  - `accent`: `Accent`
  - `systemPrompts`: `SystemPrompt[]` with `{id, name, body,
    enabledByDefault}`
  - `userName`: free-form string (1..200 chars). Absent / empty =
    "not set" - chat-loop omits the User profile block, and the
    journal agent's "About the user" block is suppressed too.
  - `userLocation`: free-form string (1..200 chars). Same opt-in
    semantics as `userName`. Both fields are passed verbatim into
    the per-turn appendix; the 200-char ceiling lives in
    `USER_PROFILE_FIELD_MAX` in `supabase.ts`. The journaling
    worker also receives them through its StartMessage and a
    `setProfile()` live-update path so background entries refer to
    the user by name rather than as the generic "User".

  Removed 2026-04: `webSearchEnabled` and `webCitationsEnabled`
  moved to the `web_search` tool (see `./tools.md`). The main
  chat loop no longer sets `venice_parameters.enable_web_search`
  on any request, so a per-user toggle has nothing to gate. The
  `threads.web_citations_enabled` column dropped at the same
  time (see `supabase/schema.sql`).

  `coerceSettings` in `supabase.ts` validates on read, dropping
  unknown / mistyped fields.
- **`localStorage['nak:theme:v1']`** — `<mode>|<accent>`.
  Non-secret cache used by the inline boot script in
  `index.html` to avoid flash-of-wrong-theme on first paint.
- **`localStorage['nak:config:v2']`** — plaintext JSON holding the
  Supabase URL + publishable key (neither is a secret). The Keys
  pane overwrites it on save. See `./auth-session.md`.
- **Reactive state** — `app.defaultModel`, `app.tierModels`,
  `app.defaultReasoningEffort`, `app.defaultVerbosity`,
  `app.colorMode`, `app.accent`, `app.systemPrompts`. Seeded
  to defaults on `activate()` (`tierModels` to `{}`); overwritten from
  `profiles.settings` by Chat's `refreshSettings` right after
  the Supabase session lands.

## Contracts

- `getSettings(): Promise<UserSettings>` — reads the JSONB blob
  and coerces. Missing row returns an empty object; unknown
  keys are dropped.
- `updateSettings(patch: Partial<UserSettings>):
  Promise<UserSettings>` — scrubs unknown keys and validates each
  known field, then applies the patch atomically via the
  `merge_profile_settings` RPC (one server-side UPDATE, no
  read-then-write). A `patch[field] === undefined` (or an empty
  profile string) deletes that field; a present-but-invalid value
  is ignored so it neither writes garbage nor clears the existing
  value. Returns the coerced post-merge blob.
- `updateSystemPrompts(prompts: SystemPrompt[]): Promise<void>`
  — replaces the `systemPrompts` array wholesale (system-prompt
  editing is a full-form save, not per-prompt). Array order is
  significant - it is the order the Custom prompts pane and the chat
  composer's prompt toggles render in, so a drag-reorder is just another
  wholesale write of the reordered array.
- `setTheme(mode, accent)` — applies to DOM, caches locally,
  writes reactive state. Does NOT persist to Supabase; callers
  that want server persistence must also call
  `updateSettings`.
- `changeAuthPassword(current, new)` (supabase.ts) — re-verifies
  the current password by re-signing in, then rotates the Supabase
  login via `updateUser`. This is the only password rotation left;
  the local config has none.
- `applyTheme(mode, accent)` — writes two data attributes
  (`data-theme`, `data-accent`) to `<html>`. CSS reacts via
  attribute selectors.
- `effectiveMode(mode)` — collapses `'system'` to `'light'` or
  `'dark'` via `matchMedia('(prefers-color-scheme: dark)')`.

## Theme lifecycle

1. **Pre-paint boot** — the inline script in `index.html` reads
   `nak:theme:v1`, parses it, and writes `data-theme` +
   `data-accent` to `<html>` before any CSS loads. This
   prevents flash-of-wrong-theme on refresh.
2. **Reactive seed** — `state.svelte.ts` reads the same cache
   via `readCachedTheme()` into `app.colorMode` / `app.accent`.
3. **Supabase override** — `Chat.svelte`'s `refreshSettings`
   pulls the server version after session lands and calls
   `setTheme(settings.colorMode, settings.accent)` if
   different. If the user changed theme on another device,
   this is where the update propagates in.
4. **User picks a new mode/accent** — `setTheme` updates DOM +
   cache + reactive state synchronously; Settings also fires
   `updateSettings` for server persistence.
5. **System-mode listener** — if `colorMode === 'system'`, an
   `App.svelte` `matchMedia` listener re-applies the theme
   when the OS preference flips (without changing the stored
   `colorMode` value, which stays `'system'`).

## Interactions with other features

- **Auth-session** — the Keys pane overwrites the plaintext
  config via `saveConfig` (local only); the Security pane rotates
  the Supabase login via `changeAuthPassword` (Supabase only). See
  `./auth-session.md`.
- **Chat** — chat reads every AI-pane setting
  (`defaultModel`, `defaultReasoningEffort`, `defaultVerbosity`,
  `systemPrompts`) from the state store. Settings writes those
  values. See `./chat.md`.
- **Architecture** — the reactive state store
  (`state.svelte.ts`) is the bridge: Settings writes setters,
  other features read the corresponding `app.*` field. See
  `./architecture.md`.
- **Build & deploy** — the About pane surfaces the commit SHA +
  build time that `vite.config.ts` inlines via `define`, and
  drives the same `applyUpdate()` that UpdateBanner calls. See
  `./build-deploy.md` for how the SW update-prompt pipeline is
  wired.

## Conventions

- **Auto-apply, no Save buttons.** AI, Journal, and Appearance
  pane controls write through the moment the user touches them.
  Each handler does an optimistic in-memory flip via a
  `state.svelte.ts` setter, then `app.supabase.updateSettings({
  ... })`, then rolls the in-memory state back on throw. Radios
  and selects fire on `change`; checkboxes on `change`; free-form
  text inputs on the input's `change` event (blur or Enter, only
  when the value differs) so a half-typed value doesn't fire a
  roundtrip per keystroke. The convention exists because it's
  what the user expects from a settings surface where every
  control is one decision wide; a Save button between the click
  and the effect just adds a step the user always wants to
  complete anyway. If you're tempted to add a Save button to a
  preference, the answer is almost always auto-apply with
  rollback. The known exceptions:
  - **Keys** and **Security** panes need an explicit Save - the
    Keys pane re-activates the in-memory services against a new
    endpoint and the Security pane rotates the Supabase login, so a
    typo auto-applied on either could lock the user out.
  - **Journal -> Day boundary** has a Save button because the
    IANA-zone validation in `normalizeTimezone()` needs a commit
    gesture. Auto-applying on every keystroke would surface an
    error mid-typing for partially-formed zones like
    `America/`. That's the only "validation gate forces a button"
    case in the modal; copy the rationale into a comment if a
    new field needs the same treatment.

## Gotchas

- **Settings writes are atomic, not read-then-write.**
  `updateSettings` validates the patch client-side, then hands a
  `set`/`remove` pair to the `merge_profile_settings` RPC
  (`supabase/schema.sql`), which merges into the live row in one
  UPDATE. This is deliberate: the old read-then-write shape (fetch
  blob, merge in JS, write back) dropped a field whenever two
  writes overlapped - both read the pre-write blob and the second
  clobbered the first. That bit single-tab too (two adjacent
  toggles flipped in quick succession, or a fire-and-forget theme
  write racing a toggle), surfacing as a setting that reverted
  intermittently with no repeatable pattern. The merge is a
  top-level shallow merge (`||`), so nested values (`tierModels`,
  `systemPrompts`) replace wholesale - correct, since the app
  treats them as atomic snapshots. Don't reintroduce a
  client-side blob read before the write.
- **`setTheme` does not persist.** It writes local state +
  DOM + cache; server persistence is the caller's job. This
  is on purpose — the Appearance pane calls both; any
  future consumer that wants only the live-apply part (e.g.
  a theme preview that reverts on cancel) can use `setTheme`
  without dragging in a server round-trip.
- **Empty `profiles.settings`.** A brand-new account has
  `settings = '{}'`. `coerceSettings` returns every field
  undefined; the state store falls back to its seed values
  (`DEFAULT_TIER`, `DEFAULT_REASONING_EFFORT`, cached theme,
  empty prompt list). Any pane that assumes a particular field
  exists has a bug.
- **Inline boot script in `index.html` is ES5.** Vite doesn't
  transform inline scripts. Keep the theme-cache read logic
  there simple; use `var`, avoid template literals and arrow
  functions, don't import anything.
- **Account-password rotation re-signs the current tab in.**
  `changeAuthPassword` re-signs in with the current password to
  verify it (Supabase `updateUser` doesn't ask for the old one),
  which issues a fresh session for the same user, then sets the new
  password. The tab that did the rotation stays signed in on the
  fresh session rather than being kicked to the Auth screen - the
  right behavior, but it surprises people reviewing the flow.

## Where to go next

- `./auth-session.md` — the local-config and session side of
  the Keys and Security panes.
- `./chat.md` — the consumer of every AI-pane setting.
- `./architecture.md` — where the reactive state store sits
  in the boot flow.
