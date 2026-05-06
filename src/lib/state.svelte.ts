/**
 * Central reactive app state. This is the single source of truth that
 * every screen reads from — the `$state` rune makes updates here
 * automatically propagate to any Svelte component that reads `app.*`.
 *
 * Phase state machine (driven by App.svelte's boot flow):
 *
 *   loading ──► setup          (no stored config found)
 *           └─► locked         (stored config exists, no live session)
 *               ├─► unlocked   (activate(): master password accepted)
 *               └─► edit-config (enterEditConfig(): fix mistyped keys)
 *   unlocked ──► locked        (lock(): user clicked Lock, or TTL expired)
 *
 * The setup / locked branches are decided by `hasStoredConfig()` in
 * App.svelte. The loading ──► unlocked shortcut happens when
 * `loadSession()` finds a valid sessionStorage blob from a previous
 * tab-local unlock.
 *
 * Why a single $state object instead of per-concern stores: every screen
 * needs phase + config + the service instances, so a single rune is
 * easier to read than a constellation of stores with the same lifetime.
 */
import type { AppConfig } from './config';
import { SupabaseService, type SystemPrompt, type UserSettings } from './supabase';
import { VeniceClient } from './venice';
import { saveSession, clearSession } from './session';
import { embeddingManager } from './embeddings/manager';
import { reflectionManager } from './agents/reflection/manager';
import { summaryManager } from './agents/summary/manager';
import { samskaraManager } from './agents/samskara/manager';
import { journalManager } from './agents/journal/manager';

/**
 * Lazy reference to the attachment-expiry manager. Loaded via
 * `import('./agents/attachment_expiry/manager')` from
 * `startBackgroundWorkers()`, then re-used by `lock()` for the
 * teardown side. The static import is gone so Vite code-splits the
 * manager + its worker out of the main chunk.
 *
 * Smoke-test for the dynamic-import pattern across the rest of the
 * worker family. Picked attachment_expiry first because its worker
 * has the smallest dependency footprint (no Venice client, no agent
 * class), it has no custom message handlers or live-update methods,
 * and an hour-granularity idle interval means a few hundred ms of
 * startup latency is invisible. If the pattern works here, the
 * other managers follow the same shape.
 *
 * Held as a Promise rather than a resolved value so `lock()` can
 * fire teardown before the dynamic import has settled - the
 * .then() runs whenever the module finally lands. If activate()
 * was never called the variable stays null and lock()'s teardown
 * is a no-op for this manager (correct: nothing to stop).
 */
let attachmentExpiryModulePromise:
  | Promise<typeof import('./agents/attachment_expiry/manager')>
  | null = null;
import { startUsagePolling, stopUsagePolling } from './usage-store.svelte';
import { detectTimezone } from './journal-day';
import {
  DEFAULT_REASONING_EFFORT,
  DEFAULT_TIER,
  DEFAULT_VERBOSITY,
  type ModelTier,
  type ReasoningEffort,
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

export type AppPhase = 'loading' | 'setup' | 'locked' | 'unlocked' | 'edit-config';

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
   * Journal feature: background journaling worker runs unless this
   * is explicitly false. Seeded to true on activate() so a brand-new
   * account gets journaling out of the box; overwritten from Supabase
   * `profiles.settings.journalAutomaticEnabled` on unlock.
   */
  journalAutomaticEnabled: boolean;
  /**
   * IANA timezone used by the journaling feature to bucket entries.
   * Seeded from the browser's detected zone on activate() so a
   * first-time user lands on sensible defaults; overwritten from
   * Supabase `profiles.settings.journalTimezone` on unlock. Passed
   * into the chat-loop's per-turn "today's journal" appendix
   * computation and into the journaling worker's start message.
   */
  journalTimezone: string;
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
  defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
  defaultVerbosity: DEFAULT_VERBOSITY,
  colorMode: cachedTheme?.mode ?? DEFAULT_MODE,
  accent: cachedTheme?.accent ?? DEFAULT_ACCENT,
  defaultLogLevel: DEFAULT_LOG_LEVEL,
  systemPrompts: [],
  emphasisMarkdown: false,
  notifyOnComplete: false,
  journalAutomaticEnabled: true,
  journalTimezone: detectTimezone(),
  userName: '',
  userLocation: '',
  error: null,
});

export function setDefaultModel(tier: ModelTier): void {
  app.defaultModel = tier;
}

export function setDefaultReasoningEffort(effort: ReasoningEffort): void {
  app.defaultReasoningEffort = effort;
}

export function setDefaultVerbosity(verbosity: Verbosity): void {
  app.defaultVerbosity = verbosity;
}

export function setSystemPrompts(prompts: SystemPrompt[]): void {
  app.systemPrompts = prompts;
}

export function setDefaultLogLevel(level: LogLevel): void {
  app.defaultLogLevel = level;
}

export function setEmphasisMarkdown(enabled: boolean): void {
  app.emphasisMarkdown = enabled;
}

export function setNotifyOnComplete(enabled: boolean): void {
  app.notifyOnComplete = enabled;
}

/**
 * Apply the display name in memory and live-update the journal
 * worker so the next background entry uses the new name without a
 * worker restart. Empty string is "not set" - the chat-loop's
 * per-turn appendix builder treats it the same as absent. The
 * worker's prompt builder injects an "About the user" block when
 * at least one field is set; setting either side here is what
 * makes new automatic entries refer to the user by name rather
 * than as the generic "User".
 *
 * Does NOT persist. The settings-load path in Chat.svelte uses
 * this directly (the value just came back from Supabase, so
 * persisting it again would be redundant). User-driven changes
 * from Settings.svelte route through `persistUserName` instead.
 */
export function setUserName(name: string): void {
  app.userName = name;
  journalManager.setProfile(name, app.userLocation);
}

/**
 * Apply the user's location in memory and live-update the journal
 * worker. Empty string is "not set". Does NOT persist - same split
 * as `setUserName`: the settings-load path uses this directly,
 * user-driven changes route through `persistUserLocation`.
 */
export function setUserLocation(location: string): void {
  app.userLocation = location;
  journalManager.setProfile(app.userName, location);
}

/**
 * Flip the background journaling worker on/off in the current session.
 * Starts or stops the journal manager to match - the toggle is the
 * live switch, not a passive preference. Does NOT persist; the
 * settings-load path in Chat.svelte uses this directly, user-driven
 * changes from Settings.svelte route through
 * `persistJournalAutomaticEnabled` so the choice survives reloads.
 */
export function setJournalAutomaticEnabled(enabled: boolean): void {
  app.journalAutomaticEnabled = enabled;
  if (!app.supabase || !app.config) return;
  if (enabled) {
    void journalManager.start({
      supabase: app.supabase,
      config: app.config,
      timezone: app.journalTimezone || null,
      userName: app.userName,
      userLocation: app.userLocation,
    });
  } else {
    journalManager.stop();
  }
}

/**
 * Apply the journal timezone in memory and push the new zone to the
 * journaling worker so it starts bucketing entries into the right
 * days immediately. Does NOT persist; user-driven changes route
 * through `persistJournalTimezone`. Caller is responsible for
 * normalizing user-supplied input to a valid IANA name first.
 */
export function setJournalTimezone(tz: string): void {
  app.journalTimezone = tz;
  journalManager.setTimezone(tz || null);
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

export async function persistJournalAutomaticEnabled(enabled: boolean): Promise<void> {
  if (!app.supabase) throw new Error(NOT_CONNECTED);
  const prev = app.journalAutomaticEnabled;
  setJournalAutomaticEnabled(enabled);
  try {
    await app.supabase.updateSettings({ journalAutomaticEnabled: enabled });
  } catch (err) {
    setJournalAutomaticEnabled(prev);
    throw err;
  }
}

/**
 * Save the journal-day timezone. Caller is responsible for
 * normalizing user input to a valid IANA name before calling -
 * the helper trusts what it's given so the error surface stays
 * focused on the persist path, not input parsing.
 */
export async function persistJournalTimezone(tz: string): Promise<void> {
  if (!app.supabase) throw new Error(NOT_CONNECTED);
  const prev = app.journalTimezone;
  setJournalTimezone(tz);
  try {
    await app.supabase.updateSettings({ journalTimezone: tz });
  } catch (err) {
    setJournalTimezone(prev);
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
  if (s.defaultReasoningEffort) setDefaultReasoningEffort(s.defaultReasoningEffort);
  if (s.defaultVerbosity) setDefaultVerbosity(s.defaultVerbosity);
  if (s.defaultLogLevel) setDefaultLogLevel(s.defaultLogLevel);
  // Boolean toggles default to false in the seed; `?? false` makes
  // an absent key explicitly false rather than passing `undefined`
  // through to the setter.
  setEmphasisMarkdown(s.emphasisMarkdown ?? false);
  setNotifyOnComplete(s.notifyOnComplete ?? false);
  // Journal opt-in defaults to true for new accounts. Explicit
  // false in the blob disables; absent key falls through to the
  // seed (also true).
  setJournalAutomaticEnabled(s.journalAutomaticEnabled ?? true);
  if (s.journalTimezone) setJournalTimezone(s.journalTimezone);
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

function startBackgroundWorkers(config: AppConfig): void {
  if (!app.supabase) return;
  // Each manager acquires a cross-tab lock before spawning its
  // worker, so another tab holding the lock will make these calls
  // hang internally - they're fire-and-forget by design, never
  // await them. If there's no Supabase session yet the worker exits
  // cleanly and state.svelte.ts doesn't need to retry; the next
  // unlock / sign-in will call `activate()` again.
  //
  // The workers run concurrently and partition the shared
  // `worker_leases` table on `worker_kind` ('embedding' /
  // 'reflection' / 'summary' / 'attachment_expiry' / 'samskara' /
  // 'journal') so one device can hold every lease simultaneously
  // without contention. The summary worker feeds the drawer's
  // search feature - it writes `threads.summary`, which the
  // embeddings worker then picks up to build the searchable
  // vector. The attachment-expiry worker reclaims binaries from
  // attachments on threads quieter than 30 days. The samskara
  // worker forms the chat model's progressively-built predictive
  // model of the user; see docs/dev/samskara.md.
  void embeddingManager.start({ supabase: app.supabase, config });
  void reflectionManager.start({ supabase: app.supabase, config });
  void summaryManager.start({ supabase: app.supabase, config });
  // Dynamic import: see the comment on `attachmentExpiryModulePromise`
  // above. Captured into the module-level variable so lock() can
  // tear down whatever this resolves to, even if the user signs
  // out before the chunk has finished loading.
  attachmentExpiryModulePromise = import('./agents/attachment_expiry/manager');
  void attachmentExpiryModulePromise.then((m) => {
    if (!app.supabase) return;
    void m.attachmentExpiryManager.start({ supabase: app.supabase, config });
  });
  void samskaraManager.start({ supabase: app.supabase, config });
  if (app.journalAutomaticEnabled) {
    void journalManager.start({
      supabase: app.supabase,
      config,
      timezone: app.journalTimezone || null,
      userName: app.userName,
      userLocation: app.userLocation,
    });
  }
}

/**
 * Transition to the unlocked state. By default, also persists the config
 * into sessionStorage so a subsequent refresh within the inactivity TTL
 * can skip the master-password prompt. Pass `{ persist: false }` to skip
 * that (e.g. when we're restoring from an existing session).
 *
 * Settings load + worker startup happen in a fire-and-forget chain after
 * activate returns: settings fetch first, then workers boot with those
 * values applied. On settings-fetch failure the workers still start, just
 * with the seed values set synchronously below - same posture as before
 * this race fix landed, so a degraded Supabase doesn't gate worker boot.
 * The race that was open before: workers were started immediately with
 * seed values (browser timezone, generic profile, default-on journal
 * toggle), and could write a journal entry with the wrong values during
 * the few hundred ms before Chat.svelte's settings fetch corrected them.
 */
export function activate(config: AppConfig, opts: { persist?: boolean } = {}): void {
  app.config = config;
  app.supabase = new SupabaseService(config);
  app.venice = new VeniceClient({ apiKey: config.veniceApiKey });
  // Seed defaults synchronously so any code reading `app.*` before the
  // settings fetch resolves sees sane values. `applyServerSettings`
  // overwrites these from the blob if the fetch succeeds.
  app.defaultModel = DEFAULT_TIER;
  app.defaultReasoningEffort = DEFAULT_REASONING_EFFORT;
  app.defaultVerbosity = DEFAULT_VERBOSITY;
  app.defaultLogLevel = DEFAULT_LOG_LEVEL;
  app.emphasisMarkdown = false;
  app.notifyOnComplete = false;
  app.journalAutomaticEnabled = true;
  app.journalTimezone = detectTimezone();
  app.userName = '';
  app.userLocation = '';
  app.phase = 'unlocked';
  app.error = null;
  if (opts.persist !== false) saveSession(config);
  // Fire-and-forget settings-then-workers chain. Workers don't start
  // until settings have either loaded successfully or failed, which
  // closes the race where a worker would briefly run on seeds before
  // the user's actual config arrived.
  void loadSettingsThenStartWorkers(config);
  // Usage polling has no settings dependency, so it can start
  // immediately. The poller fires once now and re-fires hourly;
  // Settings still forces a refresh on open if the cached data is
  // older than USAGE_STALE_MS.
  startUsagePolling(app.venice);
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

export function lock(): void {
  // Tear all workers down before clearing services — each manager
  // releases its Web Lock here so a queued tab can take over as soon
  // as we're gone. Order doesn't matter; the locks are independent.
  embeddingManager.stop();
  reflectionManager.stop();
  summaryManager.stop();
  // attachment-expiry is dynamically imported. If activate() never
  // ran (no module promise) there's nothing to stop. If the import
  // is mid-flight, `.then()` schedules the stop after the chunk
  // lands so we don't drop the cleanup.
  if (attachmentExpiryModulePromise) {
    void attachmentExpiryModulePromise.then((m) => m.attachmentExpiryManager.stop());
  }
  samskaraManager.stop();
  journalManager.stop();
  // Tear down the usage poller and wipe the cache so rows billed
  // against the previous API key don't leak into a subsequent
  // unlock-with-different-config.
  stopUsagePolling();
  app.config = null;
  app.supabase = null;
  app.venice = null;
  app.defaultModel = DEFAULT_TIER;
  app.defaultReasoningEffort = DEFAULT_REASONING_EFFORT;
  app.defaultVerbosity = DEFAULT_VERBOSITY;
  app.defaultLogLevel = DEFAULT_LOG_LEVEL;
  app.emphasisMarkdown = false;
  app.notifyOnComplete = false;
  // Journal: reset both fields so a subsequent unlock re-seeds
  // them from the new account's Supabase settings rather than
  // inheriting the previous account's choices.
  app.journalAutomaticEnabled = true;
  app.journalTimezone = detectTimezone();
  // Profile: same rationale - never leak the previous account's
  // name/location across a lock-then-unlock-as-someone-else flow.
  app.userName = '';
  app.userLocation = '';
  app.systemPrompts = [];
  app.phase = 'locked';
  clearSession();
}

/**
 * Enter the "edit keys" flow with a decrypted config. Used by the Unlock
 * screen when the user wants to fix a mistyped key without first having to
 * get past the chat auth flow. The config is held in app.config but no
 * Supabase / Venice service is instantiated yet — those spin up via
 * activate() once the user commits.
 */
export function enterEditConfig(config: AppConfig): void {
  app.config = config;
  app.supabase = null;
  app.venice = null;
  app.phase = 'edit-config';
  app.error = null;
}
