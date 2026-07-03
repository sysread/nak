/**
 * Settings layer over the app-state root: the in-memory setters, the
 * transactional persist-with-rollback wrappers, and the server-blob
 * hydration. Splits the "how a setting changes" policy off the reactive
 * `app` root in `./root.svelte.ts`.
 *
 * Two write paths, deliberately separate:
 *   - `set*` (private) - in-memory only. Used by `applyServerSettings`
 *     (the value just came from Supabase, re-persisting would be a
 *     redundant round-trip) and by the `persist*` wrappers for their
 *     optimistic apply + rollback.
 *   - `persist*` (exported) - the only surface outside callers touch.
 *     Optimistic in-memory apply, Supabase write, rollback on error,
 *     throw on failure so a caller's single try/catch can drive the
 *     success / error UI. Field-level validation (length caps) lives
 *     here because it's intrinsic to the data, not the form.
 */
import { app } from './root.svelte';
import type { SystemPrompt, UserSettings } from '../supabase';
import { seedModelProfiles, type ModelProfile } from '../models';
import type { ModelPriceCaps } from '../models/price-caps';
import type { LogLevel } from '../logger.svelte';
import { applyTheme, cacheTheme, type Accent, type ColorMode } from '../theme';

// `set*` helpers are in-memory only: `applyServerSettings` calls them on
// the load path, and each `persist*` wrapper calls them for its
// optimistic apply + rollback. They stay named functions rather than
// inline assignments so the load-side and the persist-side share one
// entry point per field, and a few carry a doc comment explaining the
// "in-memory, does not persist" contract. NOT exported: outside callers
// route through the `persist*` wrappers, never writing `app.*` directly.
function setModelProfiles(profiles: ModelProfile[]): void {
  app.modelProfiles = profiles;
}

// Empty string / undefined is "not set" - the server falls back to
// VENICE_DEFAULT_IMAGE_MODEL. Stored as undefined locally so the picker's
// effective-selection fallback is a single `?? default`.
function setImageModel(modelId: string | undefined): void {
  app.imageModel = modelId && modelId.length > 0 ? modelId : undefined;
}

/**
 * Apply the project-global price caps in memory. Exported (unlike the
 * other `set*` helpers) because there is no `persist*` counterpart: the
 * browser never writes the caps - they live on app_config and are written
 * only by `mise run setup` - so Chat's refreshSettings calls this directly
 * with whatever `getPriceCaps()` returned, rather than routing through a
 * persist wrapper.
 */
export function setPriceCaps(caps: ModelPriceCaps): void {
  app.priceCaps = caps;
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
 * Flip the in-memory intents flag. Like the wiki/memory toggles the
 * live switch is the persisted setting: the minting + evaluation sweeps
 * and applyIntentPriming all read profiles.settings.intentsEnabled
 * server-side, so there is no worker to start or stop here. Does NOT
 * persist; user-driven changes route through `persistIntentsEnabled`.
 */
function setIntentsEnabled(enabled: boolean): void {
  app.intentsEnabled = enabled;
}

/**
 * Flip the in-memory wiki-record-extraction flag. Independent of the
 * automatic wiki agent - a user can keep article maintenance on while
 * turning extraction off (manual records still work). The live switch
 * is the persisted setting: the extraction sweep's claim predicate
 * reads profiles.settings.wikiRecordExtractionEnabled server-side, so
 * there is no worker to start or stop here. Does NOT persist;
 * user-driven changes route through `persistWikiRecordExtractionEnabled`.
 */
function setWikiRecordExtractionEnabled(enabled: boolean): void {
  app.wikiRecordExtractionEnabled = enabled;
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
 * Flip the in-memory memory-librarian flag. One switch for both
 * passes (deep-sleep and rem) - their work is complementary and they
 * share the server-side in-flight guard, so the user-facing concept
 * is a single "memory librarian". The live switch is the persisted
 * setting: both sweeps' claim predicates read
 * profiles.settings.memoryLibrarianEnabled server-side, so there is
 * no worker to start or stop here. Does NOT persist; user-driven
 * changes route through `persistMemoryLibrarianEnabled`.
 */
function setMemoryLibrarianEnabled(enabled: boolean): void {
  app.memoryLibrarianEnabled = enabled;
}

/**
 * Update color mode / accent in memory, apply to the DOM, and cache the
 * choice so the boot script can restore it instantly next load. Does NOT
 * write to Supabase. The settings-load path uses this directly (the
 * value just came back from Supabase, no need to persist it again);
 * user-driven changes go through `persistTheme` so the persist +
 * rollback dance lives in one place.
 */
export function setTheme(mode: ColorMode, accent: Accent): void {
  app.colorMode = mode;
  app.accent = accent;
  applyTheme(mode, accent);
  cacheTheme(mode, accent);
}

// --- Transactional persist helpers --------------------------------
// Each `persistX` below pairs with a `setX` above. The `set*` functions
// are in-memory only and used by the settings-load path
// (`applyServerSettings`), where the value just came back from Supabase
// so persisting it again would be a no-op round-trip. User-driven
// changes from Settings.svelte route through these `persist*` helpers,
// which do the optimistic apply, the Supabase write, and the rollback on
// error in one place. Throw on failure so callers can use a single
// try/catch around success-message + error-message UI updates rather
// than rolling back app state by hand at every site. Field-level
// validation (length caps) lives here too because it's intrinsic to
// the data, not the form.

const NOT_CONNECTED = 'Not connected to Supabase yet.';

/**
 * Persist the whole model-profile list. Callers build the next list
 * (current list with a profile added, edited, removed, reordered, or
 * re-defaulted) and hand it in whole - mirroring updateSystemPrompts'
 * replace-wholesale contract, since the list's order and its exactly-
 * one-default invariant only make sense as a unit. Optimistic with
 * rollback; adopts the coerced server shape on success so a list the
 * coercer normalized (dropped entry, re-flagged default) is reflected
 * locally. An emptied list comes back as absence from the server - the
 * seed substitutes so the app never runs with zero profiles.
 */
export async function persistModelProfiles(profiles: ModelProfile[]): Promise<void> {
  if (!app.supabase) throw new Error(NOT_CONNECTED);
  const prev = app.modelProfiles;
  setModelProfiles(profiles);
  try {
    const merged = await app.supabase.updateSettings({ modelProfiles: profiles });
    setModelProfiles(merged.modelProfiles ?? seedModelProfiles());
  } catch (err) {
    setModelProfiles(prev);
    throw err;
  }
}

/**
 * Persist the image-generation model id. A bare string (or undefined to
 * clear), since the server-side generate_image tool needs only the id.
 * Optimistic with rollback, like the other persist* wrappers.
 */
export async function persistImageModel(modelId: string | undefined): Promise<void> {
  if (!app.supabase) throw new Error(NOT_CONNECTED);
  const prev = app.imageModel;
  setImageModel(modelId);
  try {
    await app.supabase.updateSettings({ imageModel: modelId });
  } catch (err) {
    setImageModel(prev);
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

export async function persistIntentsEnabled(enabled: boolean): Promise<void> {
  if (!app.supabase) throw new Error(NOT_CONNECTED);
  const prev = app.intentsEnabled;
  setIntentsEnabled(enabled);
  try {
    await app.supabase.updateSettings({ intentsEnabled: enabled });
  } catch (err) {
    setIntentsEnabled(prev);
    throw err;
  }
}

export async function persistWikiRecordExtractionEnabled(enabled: boolean): Promise<void> {
  if (!app.supabase) throw new Error(NOT_CONNECTED);
  const prev = app.wikiRecordExtractionEnabled;
  setWikiRecordExtractionEnabled(enabled);
  try {
    await app.supabase.updateSettings({ wikiRecordExtractionEnabled: enabled });
  } catch (err) {
    setWikiRecordExtractionEnabled(prev);
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
    app.displayTimezonePersisted = true;
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
  // Always assign; a blob with no stored profiles (new account, or one
  // predating the profile system) substitutes the seed so the composer
  // and send path always have a working default profile. The seed is
  // NOT written back - it materializes in the blob only when the user
  // first edits profiles in Settings.
  setModelProfiles(s.modelProfiles ?? seedModelProfiles());
  // Always assign so clearing the override on another tab drops it here too.
  setImageModel(s.imageModel);
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
  // Intents opt-in: default OFF. Only an explicit true in the blob
  // turns the self-developing pipeline on.
  setIntentsEnabled(s.intentsEnabled ?? false);
  setWikiRecordExtractionEnabled(s.wikiRecordExtractionEnabled ?? true);
  setWikiLibrarianEnabled(s.wikiLibrarianEnabled ?? true);
  setMemoryLibrarianEnabled(s.memoryLibrarianEnabled ?? true);
  if (s.displayTimezone) setDisplayTimezone(s.displayTimezone);
  // Track whether the profile actually carries a saved zone (vs. the
  // activate()-seeded browser default), so Settings can distinguish saved
  // from suggested and the server day-gates' UTC fallback is visible.
  app.displayTimezonePersisted = !!s.displayTimezone;
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
