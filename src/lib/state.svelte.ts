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
import { SupabaseService, type SystemPrompt } from './supabase';
import { VeniceClient } from './venice';
import { saveSession, clearSession } from './session';
import { embeddingManager } from './embeddings/manager';
import { reflectionManager } from './agents/reflection/manager';
import { summaryManager } from './agents/summary/manager';
import { attachmentExpiryManager } from './agents/attachment_expiry/manager';
import { samskaraManager } from './agents/samskara/manager';
import { startUsagePolling, stopUsagePolling } from './usage-store.svelte';
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
 * Update color mode / accent in memory, apply to the DOM, and cache the
 * choice so the boot script can restore it instantly next load. Does NOT
 * write to Supabase — callers that want server-side persistence should
 * call app.supabase.updateSettings separately (typically in Settings.svelte).
 */
export function setTheme(mode: ColorMode, accent: Accent): void {
  app.colorMode = mode;
  app.accent = accent;
  applyTheme(mode, accent);
  cacheTheme(mode, accent);
}

/**
 * Transition to the unlocked state. By default, also persists the config
 * into sessionStorage so a subsequent refresh within the inactivity TTL
 * can skip the master-password prompt. Pass `{ persist: false }` to skip
 * that (e.g. when we're restoring from an existing session).
 */
export function activate(config: AppConfig, opts: { persist?: boolean } = {}): void {
  app.config = config;
  app.supabase = new SupabaseService(config);
  app.venice = new VeniceClient({ apiKey: config.veniceApiKey });
  // Reset to a seed value; Chat.svelte will overwrite after Supabase settles.
  app.defaultModel = DEFAULT_TIER;
  app.defaultReasoningEffort = DEFAULT_REASONING_EFFORT;
  app.defaultVerbosity = DEFAULT_VERBOSITY;
  app.defaultLogLevel = DEFAULT_LOG_LEVEL;
  app.emphasisMarkdown = false;
  app.notifyOnComplete = false;
  app.phase = 'unlocked';
  app.error = null;
  if (opts.persist !== false) saveSession(config);
  // Fire-and-forget: each manager acquires a cross-tab lock before
  // spawning its worker, so another tab holding the lock will make
  // this call hang — never await it. If there's no Supabase session
  // yet the worker exits cleanly and state.svelte.ts doesn't need to
  // retry; the next unlock / sign-in will call activate() again.
  //
  // The workers run concurrently: they partition the shared
  // `worker_leases` table on `worker_kind` ('embedding' / 'reflection'
  // / 'summary' / 'attachment_expiry' / 'samskara') so one device can
  // hold every lease simultaneously without contention. The summary
  // worker feeds the drawer's search feature — it writes
  // `threads.summary`, which the embeddings worker then picks up to
  // build the searchable vector. The attachment-expiry worker
  // reclaims binaries from attachments on threads quieter than 30
  // days. The samskara worker forms the chat model's progressively-
  // built predictive model of the user; see docs/dev/samskara.md.
  void embeddingManager.start({ supabase: app.supabase, config });
  void reflectionManager.start({ supabase: app.supabase, config });
  void summaryManager.start({ supabase: app.supabase, config });
  void attachmentExpiryManager.start({ supabase: app.supabase, config });
  void samskaraManager.start({ supabase: app.supabase, config });
  // Warm the Usage pane cache in the background so Settings -> Usage
  // opens instantly when the user goes looking. The poller fires once
  // immediately and re-fires hourly; Settings still forces a refresh
  // on open if the cached data is older than USAGE_STALE_MS.
  startUsagePolling(app.venice);
}

export function lock(): void {
  // Tear all workers down before clearing services — each manager
  // releases its Web Lock here so a queued tab can take over as soon
  // as we're gone. Order doesn't matter; the locks are independent.
  embeddingManager.stop();
  reflectionManager.stop();
  summaryManager.stop();
  attachmentExpiryManager.stop();
  samskaraManager.stop();
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
