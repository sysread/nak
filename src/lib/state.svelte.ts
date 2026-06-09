/**
 * Central reactive app state. Single source of truth that every
 * screen reads from - the `$state` rune makes updates here propagate
 * automatically to any component that touches `app.*`.
 *
 * Phase state machine (driven by App.svelte's boot flow):
 *
 *   loading --> setup     (no stored config found in localStorage)
 *           \-> unlocked  (stored config loaded; activate() instantiates
 *                          services and seeds defaults)
 *
 * The setup / unlocked branches are decided by `hasStoredConfig()` in
 * App.svelte. There is no `locked` phase: localStorage holds only the
 * Supabase URL + publishable key, both RLS-safe by design, so the
 * config blob carries no secrets worth gating behind a password
 * ceremony. The Supabase auth session is what makes a session
 * meaningful; sign-out tears that down via `resetForSignOut()` +
 * `supabase.signOut()`, and `Chat.svelte` re-shows the `<Auth />`
 * screen until the next sign-in.
 *
 * Why a single $state object instead of per-concern stores: every
 * screen needs phase + config + the service instances, so a single
 * rune is easier to read than a constellation of stores with the
 * same lifetime.
 */
import type { AppConfig } from './config';
import {
  SupabaseService,
  type SystemPrompt,
  type UserSettings,
} from './supabase';
import { VeniceClient } from './venice';
import { resetUsage } from './usage-store.svelte';
import { resetCatalog } from './models-catalog.svelte';
import { detectTimezone } from './timezone';
import {
  DEFAULT_REASONING_EFFORT,
  DEFAULT_TIER,
  DEFAULT_VERBOSITY,
  type ModelTier,
  type ReasoningEffort,
  type TierModels,
  type Verbosity,
} from './models';
import {
  DEFAULT_MODE,
  DEFAULT_ACCENT,
  applyTheme,
  cacheTheme,
  readCachedTheme,
  type Accent,
  type ColorMode,
} from './theme';
import { DEFAULT_LOG_LEVEL, type LogLevel } from './logger.svelte';

/**
 * Lazy reference to a worker manager. Each manager module is
 * imported on the first `start()` call, which lets Vite code-split
 * the manager class + its worker bundle out of the main chunk - the
 * managers don't run until activate() fires anyway, so paying the
 * import cost on unlock instead of at first paint is a clean win.
 *
 * The captured Promise is what makes the pattern safe: stop() can
 * fire before the dynamic import resolves (e.g. the user signs out
 * faster than the network delivers the chunk), and `.then()` will
 * still run the teardown whenever the module finally lands.
 *
 * `whenLoaded(fn)` is the escape hatch for live-update calls (e.g.
 * the wiki worker's `setProfile` / `setTimezone`). It's a no-op
 * if start() never fired - a manager whose worker hasn't spawned
 * has nothing to push the update at.
 */
function lazyManager<
  M extends { start: (opts: never) => unknown; stop: () => void },
>(
  load: () => Promise<M>
): {
  start(opts: Parameters<M['start']>[0]): void;
  stop(): void;
  whenLoaded(fn: (m: M) => void): void;
} {
  let promise: Promise<M> | null = null;
  return {
    start(opts) {
      if (!promise) promise = load();
      void promise.then((m) => void m.start(opts as never));
    },
    stop() {
      if (!promise) return;
      void promise.then((m) => m.stop());
    },
    whenLoaded(fn) {
      if (!promise) return;
      void promise.then(fn);
    },
  };
}

// One lazy handle per worker manager. The static imports moved here
// so Vite code-splits each manager + its worker bundle out of the
// main chunk - they only land when activate() kicks off the
// background-worker startup. The shared deps (BaseWorkerManager,
// SupabaseService, LeaseCoordinator, the logger, holder) all ride
// the SAME dynamic-import graph, so Vite parks them in a chunk that
// every manager chunk pulls from rather than duplicating them.
//
// Order doesn't matter; each handle is independent.
//
// Embedding backfill is no longer a worker here: it runs server-side on a
// pg_cron schedule against the venice edge function (see
// docs/dev/embeddings.md). Search-query embeds go through the function too
// (SupabaseService.embed), so nothing in the browser holds a Venice key for
// the embeddings path.
// Six formerly-standalone workers (auto_title, summary, reflection,
// topics, memory_topics, recipe_topics) are
// consolidated under one supervisor worker. The supervisor owns one
// lease, one heartbeat, one Supabase client, and one auth setup -
// see src/lib/agents/supervisor/loop.ts for the rationale and which
// workers stayed standalone.
const supervisor = lazyManager(() =>
  import('./agents/supervisor/manager').then((m) => m.supervisorManager)
);
const samskara = lazyManager(() =>
  import('./agents/samskara/manager').then((m) => m.samskaraManager)
);
const bias = lazyManager(() =>
  import('./agents/bias/manager').then((m) => m.biasManager)
);
// The wiki agents are no longer workers here: both the autonomous
// per-conversation agent and the librarian run server-side on
// pg_cron schedules against the venice edge function (/wiki-sweep,
// /wiki-librarian-sweep; see docs/dev/wiki.md).
// Memory librarian workers. Two agents (deep-sleep and rem) share
// the 'memory-librarian' lease partition so only one can run at a
// time per user across devices; their cadence gates (deep_sleep_last_
// run_at, rem_last_run_at) are independent so they run on naturally
// staggered schedules. Toggled together by app.memoryLibrarianEnabled.
const deepSleep = lazyManager(() =>
  import('./agents/deep-sleep/manager').then((m) => m.deepSleepManager)
);
const rem = lazyManager(() =>
  import('./agents/rem/manager').then((m) => m.remManager)
);

export type AppPhase = 'loading' | 'setup' | 'unlocked';

interface AppState {
  phase: AppPhase;
  config: AppConfig | null;
  supabase: SupabaseService | null;
  venice: VeniceClient | null;
  /**
   * User-level default model tier. Seeded to DEFAULT_TIER on activate(),
   * then updated from Supabase `profiles.settings` once the user signs
   * in. Written back via setDefaultModel() from Settings.
   */
  defaultModel: ModelTier;
  /**
   * Per-tier model + reasoning overrides from
   * `profiles.settings.tierModels`. Empty object on activate() (no
   * overrides = built-in tier defaults); overwritten from Supabase on
   * unlock. Read at chat send time via `effectiveTierSpec(tier,
   * app.tierModels)` so a configured tier resolves to the user's model
   * and reasoning level. Each entry is a capability snapshot, so chat
   * resolution never has to wait on the lazily-fetched catalog.
   */
  tierModels: TierModels;
  /**
   * User-level default reasoning-effort. Seeded to
   * DEFAULT_REASONING_EFFORT on activate(), then overwritten from
   * Supabase `profiles.settings.defaultReasoningEffort` on unlock.
   * Only consulted on reasoning-capable models.
   */
  defaultReasoningEffort: ReasoningEffort;
  /**
   * User-level default text.verbosity. Seeded to DEFAULT_VERBOSITY on
   * activate(), then overwritten from Supabase
   * `profiles.settings.defaultVerbosity` on unlock. Sent on every chat
   * request (per-thread override wins if set) — providers that don't
   * honor the field silently ignore it.
   */
  defaultVerbosity: Verbosity;
  /** UI theme — seeded from localStorage cache, then from Supabase. */
  colorMode: ColorMode;
  accent: Accent;
  /**
   * Default minimum level for the in-app Logs drawer. Seeded to
   * {@link DEFAULT_LOG_LEVEL} on activate(), then overwritten from
   * Supabase `profiles.settings.defaultLogLevel` on unlock. LogsDrawer
   * reads this at open time; the user can still raise or lower the
   * threshold within a session via the drawer's own dropdown.
   */
  defaultLogLevel: LogLevel;
  /**
   * System-prompt library, loaded from Supabase `profiles.settings`. A
   * prompt's `enabledByDefault` flag seeds the per-thread active set in
   * Chat.svelte; the active set itself is not stored here because it's
   * conversation-scoped.
   */
  systemPrompts: SystemPrompt[];
  /**
   * When true, the chat loop appends a short instruction block to the
   * per-turn system-prompt appendix asking the model to use light
   * Markdown emphasis for semantic save-points (bold terms, italic
   * phrases). Opt-in; seeded from Supabase on unlock. See
   * chat-loop.ts for the exact blurb.
   */
  emphasisMarkdown: boolean;
  /**
   * When true, completions that land in a thread other than the one the
   * user is currently viewing fire either an OS notification (document
   * hidden, permission granted) or an in-app unread dot on the sidebar
   * entry. Opt-in because the OS path needs Notification permission, and
   * asking on first load would be presumptuous. Seeded from Supabase on
   * unlock; see src/lib/notifications.svelte.ts for the delivery policy.
   */
  notifyOnComplete: boolean;
  /**
   * User wiki feature: the server-side wiki sweep processes this
   * user's threads unless this is explicitly false (the cron sweep's
   * claim predicate reads the persisted form per candidate thread).
   * Seeded to true on activate() so a brand-new account gets wiki
   * entries out of the box; overwritten from Supabase
   * `profiles.settings.wikiAutomaticEnabled` on unlock.
   */
  wikiAutomaticEnabled: boolean;
  /**
   * Wiki librarian: when true, the periodic librarian agent runs in
   * the background (12h minimum interval, atomically gated across
   * devices). Independent of `wikiAutomaticEnabled` so the two wiki
   * agents can be toggled separately. Default true; overwritten from
   * Supabase `profiles.settings.wikiLibrarianEnabled` on unlock.
   */
  wikiLibrarianEnabled: boolean;
  /**
   * Memory librarian: when true, the deep-sleep and rem background
   * agents run on their staggered 12h cadences. Default true;
   * overwritten from Supabase `profiles.settings.memoryLibrarianEnabled`
   * on unlock. The two agents start and stop together - they share
   * the same cross-device lease partition and their work is
   * complementary.
   */
  memoryLibrarianEnabled: boolean;
  /**
   * IANA timezone the model sees when reasoning about "what time is
   * it for the user" in the per-turn metadata system message; the
   * persisted form is also what the server-side day-gated agents
   * (reflection, wiki) bucket eligibility against. Seeded from the
   * browser's detected zone on activate() so a first-time user lands
   * on sensible defaults; overwritten from Supabase
   * `profiles.settings.displayTimezone` on unlock.
   */
  displayTimezone: string;
  /**
   * Free-form display name the user entered in Settings -> AI ->
   * About you. Empty string means "not set"; chat-loop reads both
   * profile fields per-turn and only emits the User profile block
   * when at least one of them is non-empty. Seeded blank on
   * activate(), overwritten from Supabase
   * `profiles.settings.userName` on unlock.
   */
  userName: string;
  /**
   * Free-form location the user entered in Settings -> AI -> About
   * you. Same opt-in semantics as userName. Used so the model can
   * answer location-grounded questions (weather, local time,
   * regional context) without guessing or asking back. Seeded blank
   * on activate(), overwritten from Supabase
   * `profiles.settings.userLocation` on unlock.
   */
  userLocation: string;
  error: string | null;
}

const cachedTheme = readCachedTheme();

export const app = $state<AppState>({
  phase: 'loading',
  config: null,
  supabase: null,
  venice: null,
  defaultModel: DEFAULT_TIER,
  tierModels: {},
  defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
  defaultVerbosity: DEFAULT_VERBOSITY,
  colorMode: cachedTheme?.mode ?? DEFAULT_MODE,
  accent: cachedTheme?.accent ?? DEFAULT_ACCENT,
  defaultLogLevel: DEFAULT_LOG_LEVEL,
  systemPrompts: [],
  emphasisMarkdown: false,
  notifyOnComplete: false,
  wikiAutomaticEnabled: true,
  wikiLibrarianEnabled: true,
  memoryLibrarianEnabled: true,
  displayTimezone: detectTimezone(),
  userName: '',
  userLocation: '',
  error: null,
});

// `set*` helpers below are only called by `applyServerSettings` in
// this same file. They stay as named functions (instead of inlined
// assignments) because some forward to background workers via
// `manager.whenLoaded(...)` and re-using the named entry-point keeps
// the load-side and the live-update side textually adjacent. They
// are intentionally NOT exported: outside callers should never reach
// past the persist-and-update wrappers (persistDefaultModel etc.)
// and write app.* directly. Add a comment above any new setter
// describing why it has to do more than a plain assignment.
function setDefaultModel(tier: ModelTier): void {
  app.defaultModel = tier;
}

function setTierModels(tierModels: TierModels): void {
  app.tierModels = tierModels;
}

function setDefaultReasoningEffort(effort: ReasoningEffort): void {
  app.defaultReasoningEffort = effort;
}

function setDefaultVerbosity(verbosity: Verbosity): void {
  app.defaultVerbosity = verbosity;
}

function setSystemPrompts(prompts: SystemPrompt[]): void {
  app.systemPrompts = prompts;
}

function setDefaultLogLevel(level: LogLevel): void {
  app.defaultLogLevel = level;
}

function setEmphasisMarkdown(enabled: boolean): void {
  app.emphasisMarkdown = enabled;
}

function setNotifyOnComplete(enabled: boolean): void {
  app.notifyOnComplete = enabled;
}

/**
 * Apply the display name in memory. Empty string is "not set" - the
 * chat-loop's per-turn metadata builder treats it the same as absent.
 * No worker push remains: every prompt that renders an "About the
 * user" block (the wiki agent, the librarian) reads
 * profiles.settings.userName server-side per run.
 *
 * Does NOT persist. The settings-load path uses this directly (the
 * value just came back from Supabase, so persisting it again would
 * be redundant). User-driven changes from Settings.svelte route
 * through `persistUserName` instead.
 */
function setUserName(name: string): void {
  app.userName = name;
}

/**
 * Apply the user's location in memory. Empty string is "not set".
 * Does NOT persist - same split as `setUserName`: the settings-load
 * path uses this directly, user-driven changes route through
 * `persistUserLocation`.
 */
function setUserLocation(location: string): void {
  app.userLocation = location;
}

/**
 * Apply the display timezone in memory. Does NOT persist; user-driven
 * changes route through `persistDisplayTimezone`. Caller is
 * responsible for normalizing user-supplied input to a valid IANA
 * name first.
 *
 * No live worker push remains: both day-gated agents (reflection,
 * wiki) read profiles.settings.displayTimezone server-side, so the
 * persisted setting is the only consumer.
 */
function setDisplayTimezone(tz: string): void {
  app.displayTimezone = tz;
}

/**
 * Flip the in-memory "automatic wiki updates" flag. The live switch
 * is the persisted setting: the server-side wiki sweep's claim
 * predicate reads profiles.settings.wikiAutomaticEnabled per
 * candidate thread, so there is no worker to start or stop here.
 * Does NOT persist; user-driven changes from Settings.svelte route
 * through `persistWikiAutomaticEnabled`.
 */
function setWikiAutomaticEnabled(enabled: boolean): void {
  app.wikiAutomaticEnabled = enabled;
}

/**
 * Flip the in-memory wiki-librarian flag. Independent of the
 * automatic wiki agent - the user can disable autonomy on one or the
 * other without losing the other. The live switch is the persisted
 * setting: the librarian sweep's claim predicate reads
 * profiles.settings.wikiLibrarianEnabled server-side, so there is no
 * worker to start or stop here. Does NOT persist; user-driven changes
 * route through `persistWikiLibrarianEnabled`.
 */
function setWikiLibrarianEnabled(enabled: boolean): void {
  app.wikiLibrarianEnabled = enabled;
}

/**
 * Flip the memory librarian on/off. Toggles both deep-sleep and rem
 * together - they share the cross-device 'memory-librarian' lease
 * partition and their work is complementary, so the user-facing
 * concept is a single "memory librarian" switch.
 */
function setMemoryLibrarianEnabled(enabled: boolean): void {
  app.memoryLibrarianEnabled = enabled;
  if (!app.supabase || !app.config) return;
  if (enabled) {
    deepSleep.start({ supabase: app.supabase, config: app.config });
    rem.start({ supabase: app.supabase, config: app.config });
  } else {
    deepSleep.stop();
    rem.stop();
  }
}

/**
 * Update color mode / accent in memory, apply to the DOM, and cache the
 * choice so the boot script can restore it instantly next load. Does NOT
 * write to Supabase. The settings-load path in Chat.svelte uses this
 * directly (the value just came back from Supabase, no need to persist
 * it again); user-driven changes go through `persistTheme` so the
 * persist + rollback dance lives in one place.
 */
export function setTheme(mode: ColorMode, accent: Accent): void {
  app.colorMode = mode;
  app.accent = accent;
  applyTheme(mode, accent);
  cacheTheme(mode, accent);
}

// --- Transactional persist helpers --------------------------------
// Each `persistX` below pairs with a `setX` above. The `set*` functions
// are in-memory only and used by the settings-load path in Chat.svelte
// (where the value just came back from Supabase, so persisting it
// again would be a no-op round-trip). User-driven changes from
// Settings.svelte route through these `persist*` helpers, which do
// the optimistic apply, the Supabase write, and the rollback on
// error in one place. Throw on failure so callers can use a single
// try/catch around success-message + error-message UI updates rather
// than rolling back app state by hand at every site. Field-level
// validation (length caps) lives here too because it's intrinsic to
// the data, not the form.

const NOT_CONNECTED = 'Not connected to Supabase yet.';

export async function persistDefaultModel(tier: ModelTier): Promise<void> {
  if (!app.supabase) throw new Error(NOT_CONNECTED);
  const prev = app.defaultModel;
  setDefaultModel(tier);
  try {
    await app.supabase.updateSettings({ defaultModel: tier });
  } catch (err) {
    setDefaultModel(prev);
    throw err;
  }
}

/**
 * Persist the whole per-tier override map. Callers build the next map
 * (current map with one tier added, changed, or removed) and hand it in
 * whole - mirroring updateSystemPrompts' replace-wholesale contract,
 * since a tier config is a single atomic snapshot rather than a set of
 * independently-mergeable fields. Optimistic with rollback.
 */
export async function persistTierModels(tierModels: TierModels): Promise<void> {
  if (!app.supabase) throw new Error(NOT_CONNECTED);
  const prev = app.tierModels;
  setTierModels(tierModels);
  try {
    const merged = await app.supabase.updateSettings({ tierModels });
    // Adopt the coerced server shape so a snapshot the coercer scrubbed
    // (e.g. an all-empty map collapsing to absence) is reflected locally.
    setTierModels(merged.tierModels ?? {});
  } catch (err) {
    setTierModels(prev);
    throw err;
  }
}

export async function persistDefaultReasoningEffort(
  effort: ReasoningEffort
): Promise<void> {
  if (!app.supabase) throw new Error(NOT_CONNECTED);
  const prev = app.defaultReasoningEffort;
  setDefaultReasoningEffort(effort);
  try {
    await app.supabase.updateSettings({ defaultReasoningEffort: effort });
  } catch (err) {
    setDefaultReasoningEffort(prev);
    throw err;
  }
}

export async function persistDefaultVerbosity(verbosity: Verbosity): Promise<void> {
  if (!app.supabase) throw new Error(NOT_CONNECTED);
  const prev = app.defaultVerbosity;
  setDefaultVerbosity(verbosity);
  try {
    await app.supabase.updateSettings({ defaultVerbosity: verbosity });
  } catch (err) {
    setDefaultVerbosity(prev);
    throw err;
  }
}

export async function persistDefaultLogLevel(level: LogLevel): Promise<void> {
  if (!app.supabase) throw new Error(NOT_CONNECTED);
  const prev = app.defaultLogLevel;
  setDefaultLogLevel(level);
  try {
    await app.supabase.updateSettings({ defaultLogLevel: level });
  } catch (err) {
    setDefaultLogLevel(prev);
    throw err;
  }
}

export async function persistEmphasisMarkdown(enabled: boolean): Promise<void> {
  if (!app.supabase) throw new Error(NOT_CONNECTED);
  const prev = app.emphasisMarkdown;
  setEmphasisMarkdown(enabled);
  try {
    await app.supabase.updateSettings({ emphasisMarkdown: enabled });
  } catch (err) {
    setEmphasisMarkdown(prev);
    throw err;
  }
}

export async function persistNotifyOnComplete(enabled: boolean): Promise<void> {
  if (!app.supabase) throw new Error(NOT_CONNECTED);
  const prev = app.notifyOnComplete;
  setNotifyOnComplete(enabled);
  try {
    await app.supabase.updateSettings({ notifyOnComplete: enabled });
  } catch (err) {
    setNotifyOnComplete(prev);
    throw err;
  }
}

/**
 * Save the user's display name. Trims surrounding whitespace and
 * caps at 200 characters. Returns the canonical (trimmed) value so
 * the caller can sync any local form-input state to it. Throws
 * `Error('Name is too long...')` for over-long input and rethrows
 * the underlying error after rolling back app state if Supabase
 * rejects the write.
 */
export async function persistUserName(next: string): Promise<string> {
  if (!app.supabase) throw new Error(NOT_CONNECTED);
  const trimmed = next.trim();
  if (trimmed.length > 200) {
    throw new Error('Name is too long (max 200 characters).');
  }
  const prev = app.userName;
  setUserName(trimmed);
  try {
    await app.supabase.updateSettings({ userName: trimmed });
    return trimmed;
  } catch (err) {
    setUserName(prev);
    throw err;
  }
}

/**
 * Save the user's location string. Same trim + 200-char cap +
 * canonical-return semantics as `persistUserName`.
 */
export async function persistUserLocation(next: string): Promise<string> {
  if (!app.supabase) throw new Error(NOT_CONNECTED);
  const trimmed = next.trim();
  if (trimmed.length > 200) {
    throw new Error('Location is too long (max 200 characters).');
  }
  const prev = app.userLocation;
  setUserLocation(trimmed);
  try {
    await app.supabase.updateSettings({ userLocation: trimmed });
    return trimmed;
  } catch (err) {
    setUserLocation(prev);
    throw err;
  }
}

export async function persistWikiAutomaticEnabled(enabled: boolean): Promise<void> {
  if (!app.supabase) throw new Error(NOT_CONNECTED);
  const prev = app.wikiAutomaticEnabled;
  setWikiAutomaticEnabled(enabled);
  try {
    await app.supabase.updateSettings({ wikiAutomaticEnabled: enabled });
  } catch (err) {
    setWikiAutomaticEnabled(prev);
    throw err;
  }
}

export async function persistWikiLibrarianEnabled(enabled: boolean): Promise<void> {
  if (!app.supabase) throw new Error(NOT_CONNECTED);
  const prev = app.wikiLibrarianEnabled;
  setWikiLibrarianEnabled(enabled);
  try {
    await app.supabase.updateSettings({ wikiLibrarianEnabled: enabled });
  } catch (err) {
    setWikiLibrarianEnabled(prev);
    throw err;
  }
}

export async function persistMemoryLibrarianEnabled(enabled: boolean): Promise<void> {
  if (!app.supabase) throw new Error(NOT_CONNECTED);
  const prev = app.memoryLibrarianEnabled;
  setMemoryLibrarianEnabled(enabled);
  try {
    await app.supabase.updateSettings({ memoryLibrarianEnabled: enabled });
  } catch (err) {
    setMemoryLibrarianEnabled(prev);
    throw err;
  }
}

/**
 * Save the display timezone. Caller is responsible for normalizing
 * user input to a valid IANA name before calling - the helper trusts
 * what it's given so the error surface stays focused on the persist
 * path, not input parsing.
 */
export async function persistDisplayTimezone(tz: string): Promise<void> {
  if (!app.supabase) throw new Error(NOT_CONNECTED);
  const prev = app.displayTimezone;
  setDisplayTimezone(tz);
  try {
    await app.supabase.updateSettings({ displayTimezone: tz });
  } catch (err) {
    setDisplayTimezone(prev);
    throw err;
  }
}

export async function persistTheme(mode: ColorMode, accent: Accent): Promise<void> {
  if (!app.supabase) throw new Error(NOT_CONNECTED);
  const prevMode = app.colorMode;
  const prevAccent = app.accent;
  setTheme(mode, accent);
  try {
    await app.supabase.updateSettings({ colorMode: mode, accent });
  } catch (err) {
    setTheme(prevMode, prevAccent);
    throw err;
  }
}

/**
 * Save the system-prompts library. The server may normalize the
 * incoming list (e.g. trimming, deduping); we sync the in-memory
 * state to whatever comes back rather than to the input we sent,
 * so the UI reflects the canonical shape.
 */
export async function persistSystemPrompts(prompts: SystemPrompt[]): Promise<void> {
  if (!app.supabase) throw new Error(NOT_CONNECTED);
  const prev = app.systemPrompts;
  // Apply optimistically with the input. If Supabase returns a
  // different shape (after normalization), overwrite with that.
  setSystemPrompts(prompts);
  try {
    const merged = await app.supabase.updateSettings({ systemPrompts: prompts });
    setSystemPrompts(merged.systemPrompts ?? []);
  } catch (err) {
    setSystemPrompts(prev);
    throw err;
  }
}

/**
 * Apply a UserSettings blob to app state via the in-memory `setX`
 * functions. Absent keys fall through to the current seed values
 * (set by `activate()` before this is called) - explicit absence
 * in the blob means "setting never set" rather than "clear the
 * field," which matches the supabase coercer's serialise behaviour
 * (it omits keys equal to defaults so the blob stays compact).
 *
 * Used by `activate()` on the initial unlock and by Chat.svelte's
 * `refreshSettings` on cross-tab auth changes. Single source of
 * truth for the settings-load mapping so the two callers can't
 * drift on which fields they handle.
 */
export function applyServerSettings(s: UserSettings): void {
  if (s.defaultModel) setDefaultModel(s.defaultModel);
  // Always assign so a tier the user cleared on another tab (absent from
  // the blob) drops the stale local override rather than ghosting it.
  setTierModels(s.tierModels ?? {});
  if (s.defaultReasoningEffort) setDefaultReasoningEffort(s.defaultReasoningEffort);
  if (s.defaultVerbosity) setDefaultVerbosity(s.defaultVerbosity);
  if (s.defaultLogLevel) setDefaultLogLevel(s.defaultLogLevel);
  // Boolean toggles default to false in the seed; `?? false` makes
  // an absent key explicitly false rather than passing `undefined`
  // through to the setter.
  setEmphasisMarkdown(s.emphasisMarkdown ?? false);
  setNotifyOnComplete(s.notifyOnComplete ?? false);
  // Wiki opt-in defaults to true for new accounts. Explicit false in
  // the blob disables; absent key falls through to the seed (also
  // true).
  setWikiAutomaticEnabled(s.wikiAutomaticEnabled ?? true);
  setWikiLibrarianEnabled(s.wikiLibrarianEnabled ?? true);
  setMemoryLibrarianEnabled(s.memoryLibrarianEnabled ?? true);
  if (s.displayTimezone) setDisplayTimezone(s.displayTimezone);
  // Profile: empty string is the "not set" sentinel; always
  // assign so explicit absence in the blob clears any value
  // carried over from a prior unlock or another tab.
  setUserName(s.userName ?? '');
  setUserLocation(s.userLocation ?? '');
  if (s.colorMode || s.accent) {
    setTheme(s.colorMode ?? app.colorMode, s.accent ?? app.accent);
  }
  setSystemPrompts(s.systemPrompts ?? []);
}

// One-way latch flipped by `haltBackgroundWork()` when a newer build is
// detected. Module-scoped (not on the reactive `app` object) because it
// must survive a lock/unlock cycle - if the user signs out and back in
// after the update banner appears, we still don't want to fire fresh
// workers against soon-to-be-stale code. The page reload through
// `applyUpdate()` is the only thing that clears it.
let workersHalted = false;

function startBackgroundWorkers(config: AppConfig): void {
  if (!app.supabase) return;
  // A newer build was announced (see `haltBackgroundWork()` below) -
  // don't fire workers that we'd just tear down. This covers the race
  // where `onNeedRefresh` lands between `activate()` and the settings
  // fetch that gates worker startup.
  if (workersHalted) return;
  // Each manager acquires a cross-tab lock before spawning its
  // worker, so another tab holding the lock will make these calls
  // hang internally - they're fire-and-forget by design, never
  // await them. If there's no Supabase session yet the worker exits
  // cleanly and state.svelte.ts doesn't need to retry; the next
  // unlock / sign-in will call `activate()` again.
  //
  // The workers run concurrently and partition the shared
  // `worker_leases` table on `worker_kind` ('summary' / 'topics' /
  // 'memory-topics' / 'recipe-topics' / 'auto_title' / 'samskara')
  // so one device can hold every lease simultaneously without
  // contention. The summary worker feeds
  // the drawer's search feature - it writes `threads.summary`, which the
  // server-side cron backfill then picks up to build the searchable
  // vector (see docs/dev/embeddings.md).
  // The topics worker writes `threads.topics` which the drawer reads
  // to populate the topic-filter dropdown; see docs/dev/topics.md.
  // The memory-topics and recipe-topics workers are siblings that
  // tag `memories.topics` and `recipes.topics` for the Memories and
  // Recipes tabs' own topic filters. The attachment-expiry worker
  // reclaims binaries from attachments on threads quieter than 30
  // days. The auto-title worker fills in titles for threads still
  // on the 'New conversation' placeholder; see docs/dev/auto-title.md.
  // The samskara worker forms the chat model's progressively-built
  // predictive model of the user; see docs/dev/samskara.md.
  supervisor.start({
    supabase: app.supabase,
    config,
  });
  samskara.start({ supabase: app.supabase, config });
  // Bias-observer worker silently analyzes processed conversations
  // for cognitive-bias / System-1-heuristic evidence; the aggregated
  // posterior feeds the system-prompt "User profile - observed
  // patterns" block when biases clear a tier. See
  // docs/dev/bias-profile.md.
  bias.start({ supabase: app.supabase, config });
  // The wiki agents have no browser workers to start: the server-side
  // cron sweeps read the persisted toggles
  // (profiles.settings.wikiAutomaticEnabled / wikiLibrarianEnabled)
  // per claim, so the Settings switches gate them without any wiring
  // here.
  if (app.memoryLibrarianEnabled) {
    deepSleep.start({ supabase: app.supabase, config });
    rem.start({ supabase: app.supabase, config });
  }
}

/**
 * Transition to the unlocked state. News up `SupabaseService` and
 * `VeniceClient` against the supplied config, seeds default user
 * preferences synchronously so any reader of `app.*` before the
 * settings fetch resolves sees sane values, then kicks the
 * settings-fetch-then-workers chain.
 *
 * Workers don't start until the settings fetch has either succeeded
 * or failed. This closes a race where a worker would briefly run on
 * seed values (browser timezone, generic profile, default-on
 * toggles) and could write a wiki article with the wrong values
 * during the few hundred ms before the user's real settings landed.
 * On settings-fetch failure the workers still start with the seeds,
 * so a degraded Supabase doesn't gate the entire bootstrap.
 */
export function activate(config: AppConfig): void {
  app.config = config;
  app.supabase = new SupabaseService(config);
  // Streaming-root path: the venice client routes streamChat through
  // the /stream edge function + Realtime Broadcast subscription, which
  // requires the supabase client to mint the function call and the
  // channel. The per-user Venice API key has been retired - the
  // function reads the shared key from app_config server-side - so
  // construct without an apiKey here and pass the supabase client
  // immediately. Tests still pass an apiKey when they want to drive
  // the direct-Venice path.
  app.venice = new VeniceClient({ supabase: app.supabase.client });
  // Seed defaults synchronously so any code reading `app.*` before the
  // settings fetch resolves sees sane values. `applyServerSettings`
  // overwrites these from the blob if the fetch succeeds.
  app.defaultModel = DEFAULT_TIER;
  app.tierModels = {};
  app.defaultReasoningEffort = DEFAULT_REASONING_EFFORT;
  app.defaultVerbosity = DEFAULT_VERBOSITY;
  app.defaultLogLevel = DEFAULT_LOG_LEVEL;
  app.emphasisMarkdown = false;
  app.notifyOnComplete = false;
  app.wikiAutomaticEnabled = true;
  app.wikiLibrarianEnabled = true;
  app.memoryLibrarianEnabled = true;
  app.displayTimezone = detectTimezone();
  app.userName = '';
  app.userLocation = '';
  app.phase = 'unlocked';
  app.error = null;
  // Fire-and-forget settings-then-workers chain. Workers don't start
  // until settings have either loaded successfully or failed, which
  // closes the race where a worker would briefly run on seeds before
  // the user's actual config arrived. The race that was open before
  // the fix landed: workers were started immediately with seed
  // values (browser timezone, generic profile, default-on toggle),
  // and could write an article with the wrong values during the few
  // hundred ms before Chat.svelte's settings fetch corrected them.
  void loadSettingsThenStartWorkers(config);
}

async function loadSettingsThenStartWorkers(config: AppConfig): Promise<void> {
  if (app.supabase) {
    try {
      const settings = await app.supabase.getSettings();
      applyServerSettings(settings);
    } catch {
      // Best-effort: keep the seeds set in `activate()`. Workers will
      // boot with default values in this branch - same as the legacy
      // behaviour pre-race-fix, so a Supabase outage doesn't gate the
      // entire bootstrap.
    }
  }
  startBackgroundWorkers(config);
}

/**
 * Tear down every background worker and wipe the usage cache. Each
 * manager handle's stop() is a no-op when start() never fired (module
 * never loaded) and dispatches through the captured import Promise
 * otherwise - so a teardown that races a still-loading manager chunk
 * still runs when the chunk lands. Order doesn't matter; the locks are
 * independent.
 *
 * Used by `resetForSignOut()` (sign-out releases each Web Lock so a
 * queued tab can take over) and by `haltBackgroundWork()` (a newer
 * build is waiting and processing must stop on stale code until the
 * user reloads). The `resetUsage()` / `resetCatalog()` calls keep
 * billing rows and the model catalog from leaking across a sign-out /
 * sign-in-as-someone-else into the Settings panes' caches.
 */
function stopBackgroundWorkers(): void {
  supervisor.stop();
  samskara.stop();
  bias.stop();
  deepSleep.stop();
  rem.stop();
  resetUsage();
  resetCatalog();
}

/**
 * Halt all background work because a newer build is waiting. Called
 * from `update.svelte.ts::onNeedRefresh` once the SW reports a waiting
 * version. Latches the `workersHalted` flag so that a subsequent
 * sign-out + sign-in inside the same page session cannot accidentally
 * fire workers back up on stale code - the only way out of the halted
 * state is the page reload that `applyUpdate()` performs.
 *
 * The update poller itself lives in update.svelte.ts and is not in the
 * worker list - it's what's announcing the new build, so it has to
 * keep running. Same for the in-flight chat loop: it's user-initiated,
 * not background, and the user gets to finish their turn before the
 * update banner asks them to reload.
 */
export function haltBackgroundWork(): void {
  if (workersHalted) return;
  workersHalted = true;
  stopBackgroundWorkers();
}

/**
 * Forward the set of "currently open" conversation ids to the
 * bias-observer worker so it skips analyzing threads the user
 * might still be typing in. Called from Chat.svelte whenever
 * the active thread changes (opens, closes, or switches). Safe
 * to call before the worker is loaded; the manager caches the
 * value and folds it into the next start payload.
 */
export function notifyBiasActiveConvIds(ids: readonly string[]): void {
  bias.whenLoaded((m) => m.setActiveConvIds(ids));
}

/**
 * Drop services + in-memory config and flip the phase back to
 * `setup`. Called from the Auth screen's "Edit Supabase config"
 * affordance, which is the escape hatch for "I pasted the wrong
 * Supabase URL / publishable key and now sign-in 401s because the
 * REST gateway rejects the apikey header." Setup pre-fills from the
 * still-present localStorage entry so the fix is a single-field edit
 * rather than retyping both values.
 *
 * Background workers are stopped because the services they were
 * pinned to are about to be torn down. Profile defaults are NOT
 * reset (unlike `resetForSignOut`) since the user is going to
 * re-activate against the same account once they fix the config -
 * keeping the seeds avoids a visible flash of generic timezone +
 * empty profile while settings re-load.
 */
export function enterSetup(): void {
  stopBackgroundWorkers();
  app.supabase = null;
  app.venice = null;
  app.config = null;
  app.phase = 'setup';
  app.error = null;
}

/**
 * Stop every background worker and reset the in-memory user state.
 * Called by the Sign-out path in Settings - sign-out is the only
 * "tear everything down" affordance the app has for an authenticated
 * session (see the phase-state-machine docblock at the top of this
 * file). The stored config in localStorage stays untouched; a
 * subsequent sign-in re-uses it without going through Setup. Use
 * `clearStoredConfig()` (config.ts) for the heavier "this device
 * should forget the project entirely" affordance, or `enterSetup()`
 * above for the "fix mistyped Supabase keys" affordance.
 */
export function resetForSignOut(): void {
  stopBackgroundWorkers();
  app.defaultModel = DEFAULT_TIER;
  app.tierModels = {};
  app.defaultReasoningEffort = DEFAULT_REASONING_EFFORT;
  app.defaultVerbosity = DEFAULT_VERBOSITY;
  app.defaultLogLevel = DEFAULT_LOG_LEVEL;
  app.emphasisMarkdown = false;
  app.notifyOnComplete = false;
  // Wiki + display TZ: reset so a subsequent sign-in re-seeds them
  // from the new account's Supabase settings rather than inheriting
  // the previous account's choices.
  app.wikiAutomaticEnabled = true;
  app.wikiLibrarianEnabled = true;
  app.memoryLibrarianEnabled = true;
  app.displayTimezone = detectTimezone();
  // Profile: same rationale - never leak the previous account's
  // name/location across a sign-out / sign-in-as-someone-else flow.
  app.userName = '';
  app.userLocation = '';
  app.systemPrompts = [];
}
