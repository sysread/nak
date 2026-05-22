# Settings

The settings modal plus everything it persists: the seven panes
(Keys, AI, Appearance, Usage, Export, Security, About), the
`profiles.settings` JSONB blob they read from and write to, and the
theme system that lives alongside.

## Role in the app

Settings is the user-visible control surface for every
preference the app holds. Each pane targets a different persistence
destination:

- **Keys** — the three API keys. Re-encrypts the config blob on
  save.
- **AI** — default model tier, default reasoning effort, default
  verbosity, the "Emphasis markdown" opt-in (a bionic-style scan
  aid - when on, chat-loop folds a short formatting blurb into
  the per-turn system-prompt appendix so the model bolds terms
  and italicises phrases), the **About you** profile fields
  (`userName` / `userLocation`, free-form strings injected into
  the per-turn appendix's "User profile" block - opt-in, both
  blank skips the block), system-prompt library, and web-search
  toggle. All preferences persist to `profiles.settings`. There
  is no Memories pane here - memories live behind the **Memories**
  drawer tab next to Chats / Recipes / Journal, which is its own
  prominent affordance and doesn't need a redundant pointer in
  Settings.
- **Appearance** — color mode + accent. Live-applies on click
  (no Save button); mirrors to `profiles.settings` (and
  localStorage for the boot script).
- **Usage** — a date-ranged snapshot of per-model token spend
  against the Venice API key. Read-only: it calls Venice's beta
  `/billing/usage` endpoint and aggregates the rows client-side.
  The default rolling-7-day window is cached in
  `usage-store.svelte.ts` and fetched lazily the first time the
  user lands on this pane in the session; opens within
  `USAGE_STALE_MS` reuse the cache, opens after it re-fetch.
  Custom date ranges bypass the cache and fetch on-demand. Nothing
  persists to disk — the cache is in-memory only and gets wiped on
  `lock()`. While paging through
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
- **Export** — downloads the three keys as a plaintext JSON
  file. No persistence change.
- **Security** — rotates the master password. Re-encrypts the
  config blob; doesn't touch Supabase.
- **About** — build fingerprint (commit SHA + build time) and the
  "Check for updates" / "Reload to update" action. Read-only; the
  values come from `$lib/update.svelte` which Vite populates at
  build time via `define`. See `./build-deploy.md` for the
  version-detection pipeline.

Theme is tightly coupled to Settings (the Appearance pane drives
every update) so it's covered here rather than in its own file.

## Files

- `src/screens/Settings.svelte` — the modal; seven panes + nav +
  backdrop dismiss + Escape handling.
- `src/lib/update.svelte.ts` — reactive build fingerprint +
  service-worker update registration. Backs the About pane and the
  top-right `UpdateBanner`. Reads the Vite-`define`'d globals
  `__APP_COMMIT__` / `__APP_BUILD_TIME__` (see `./build-deploy.md`).
- `src/components/UpdateBanner.svelte` — fixed top-right "new
  version available" pill, driven by `updateState.available`.
  Mounted once in `App.svelte` so it appears across every phase.
- `src/lib/state.svelte.ts` — setters that Settings calls
  (`setDefaultModel`, `setDefaultReasoningEffort`,
  `setDefaultVerbosity`, `setEmphasisMarkdown`,
  `setSystemPrompts`, `setTheme`, `setWebSearchEnabled`).
- `src/lib/supabase.ts` — `getSettings`, `updateSettings`,
  `updateSystemPrompts`. Read-then-write against the
  `profiles.settings` JSONB column.
- `src/lib/venice.ts` — `VeniceClient.fetchUsage` + `UsageRow` /
  `UsageCurrency` types. Backs the Usage pane; pages through
  `/billing/usage` transparently up to `USAGE_MAX_PAGES`
  (20 × 500 rows = 10k rows) and coerces each row defensively
  before returning.
- `src/lib/usage-store.svelte.ts` — reactive cache for the Usage
  pane's default rolling-7-day window. Nothing runs at boot; the
  Settings pane drives the first fetch via `refreshUsage`. Wiped
  by `state.svelte.ts::lock()` via `resetUsage` so rows tied to
  the prior API key don't leak into a subsequent unlock. Exposes
  `usage` (the `$state` rune), `refreshUsage`, `resetUsage`,
  `isUsageStale`, plus the `USAGE_STALE_MS` constant.
- `src/lib/config.ts` — `saveConfig` (keys pane) and
  `changePassword` (security pane).
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
  and is wiped on `lock()` so rows billed against the previous
  API key don't leak into a subsequent unlock with a different
  config.
- **Security pane submit** — `changePassword(old, new)` in
  config.ts. Settings catches errors and displays them inline.

## Data model

- **`profiles.settings`** — JSONB column. No per-field schema.
  Known keys today:
  - `defaultModel`: `ModelTier`
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
- **`localStorage['nak:config:v1']`** — encrypted config blob;
  the Keys pane overwrites it on save. See
  `./auth-session.md`.
- **Reactive state** — `app.defaultModel`,
  `app.defaultReasoningEffort`, `app.defaultVerbosity`,
  `app.colorMode`, `app.accent`, `app.systemPrompts`. Seeded
  to defaults on `activate()`; overwritten from
  `profiles.settings` by Chat's `refreshSettings` right after
  the Supabase session lands.

## Contracts

- `getSettings(): Promise<UserSettings>` — reads the JSONB blob
  and coerces. Missing row returns an empty object; unknown
  keys are dropped.
- `updateSettings(patch: Partial<UserSettings>):
  Promise<UserSettings>` — merges a patch with the current row
  via read-then-write. Scrubs unknown keys and validates each
  known field; a `patch[field] === undefined` deletes that
  field from the stored object.
- `updateSystemPrompts(prompts: SystemPrompt[]): Promise<void>`
  — replaces the `systemPrompts` array wholesale (system-prompt
  editing is a full-form save, not per-prompt).
- `setTheme(mode, accent)` — applies to DOM, caches locally,
  writes reactive state. Does NOT persist to Supabase; callers
  that want server persistence must also call
  `updateSettings`.
- `changePassword(old, new)` — decrypts with old, re-encrypts
  under new. Doesn't touch Supabase.
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

- **Auth-session** — the Keys pane overwrites the encrypted
  config blob via `saveConfig`; the Security pane re-encrypts
  via `changePassword`. Neither touches Supabase. See
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
  - **Keys** and **Security** panes need an explicit Save - they
    re-encrypt the config blob, and a typo on auto-apply could
    lock the user out.
  - **Journal -> Day boundary** has a Save button because the
    IANA-zone validation in `normalizeTimezone()` needs a commit
    gesture. Auto-applying on every keystroke would surface an
    error mid-typing for partially-formed zones like
    `America/`. That's the only "validation gate forces a button"
    case in the modal; copy the rationale into a comment if a
    new field needs the same treatment.

## Gotchas

- **Read-then-write on `profiles.settings`.** Not safe under
  concurrent writes from multiple tabs. If two tabs both
  flip theme at the same moment, one write wins and the
  other's change is lost. Acceptable for a single-user
  single-device app; if multi-tab concurrency becomes a real
  concern, move to a Postgres `jsonb_set` so each field
  updates atomically.
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
- **Password rotation doesn't invalidate sessions.** The
  encrypted blob re-encrypts; the sessionStorage session
  blob keeps its plaintext copy, so an open tab stays
  unlocked. This is the right behavior (rotating a password
  shouldn't force a re-unlock in the tab doing the rotation)
  but surprises people reviewing the flow.

## Where to go next

- `./auth-session.md` — the master-password and keys side
  of the Keys and Security panes.
- `./chat.md` — the consumer of every AI-pane setting.
- `./architecture.md` — where the reactive state store sits
  in the boot flow.
