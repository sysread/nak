/**
 * App lifecycle transitions over the state root: news up the services
 * on unlock, tears them down on sign-out / setup, and resets the
 * per-session caches. The phase-state-machine docblock lives in
 * `./root.svelte.ts`; this file is the code that drives those
 * transitions.
 *
 * No background Web Workers remain. The whole fleet runs server-side
 * in the venice edge function (supabase/functions/venice/agents/),
 * driven by chat-turn tails and pg_cron sweeps: embeddings, the five
 * curation units, reflection, the wiki agents, the memory librarians,
 * the bias pipeline, and - last to move - the samskara formation
 * loop. Their output (titles, summaries, tags, memories, articles,
 * bias_summary rows, samskaras) lands in the same tables the UI
 * reads, and the UI learns about it through user-scoped realtime
 * relays wired in Chat.svelte. The Settings toggles that used to gate
 * workers are plain settings writes the server-side claim RPCs read.
 */
import type { AppConfig } from '../config';
import { SupabaseService } from '../supabase';
import { VeniceClient } from '../venice';
import { resetUsage } from '../usage-store.svelte';
import { resetCatalog } from '../models-catalog.svelte';
import { resetImageCatalog } from '../image-models-catalog.svelte';
import { detectTimezone } from '../timezone';
import { seedModelProfiles } from '../models';
import { DEFAULT_LOG_LEVEL } from '../logger.svelte';
import { app } from './root.svelte';
import { applyServerSettings } from './settings';

// One-way latch flipped by `haltBackgroundWork()` when a newer build
// is detected. Module-scoped (not on the reactive `app` object)
// because it must survive a lock/unlock cycle. With the worker fleet
// fully server-side this only gates the cache resets below; it stays
// because update.svelte.ts still calls the halt on a pending build.
let workersHalted = false;

/**
 * Reset the user-preference fields to their seeded defaults. Shared by
 * `activate()` (so a reader of `app.*` before the settings fetch lands
 * sees sane values) and `resetForSignOut()` (so the next sign-in re-
 * seeds from the new account rather than inheriting the prior one's
 * choices). Covers only the profile/preference fields the two paths
 * have in common - phase/error/services and `systemPrompts` are reset
 * by the individual callers as their semantics differ.
 */
function seedProfileDefaults(): void {
  app.modelProfiles = seedModelProfiles();
  app.defaultLogLevel = DEFAULT_LOG_LEVEL;
  app.emphasisMarkdown = false;
  app.notifyOnComplete = false;
  app.wikiAutomaticEnabled = true;
  app.intentsEnabled = false;
  app.wikiLibrarianEnabled = true;
  app.memoryLibrarianEnabled = true;
  app.displayTimezone = detectTimezone();
  app.displayTimezonePersisted = false;
  app.userName = '';
  app.userLocation = '';
}

/**
 * Transition to the unlocked state. News up `SupabaseService` and
 * `VeniceClient` against the supplied config, seeds default user
 * preferences synchronously so any reader of `app.*` before the
 * settings fetch resolves sees sane values, then kicks the
 * settings fetch.
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
  seedProfileDefaults();
  app.phase = 'unlocked';
  app.error = null;
  // Fire-and-forget settings fetch; `applyServerSettings` overwrites
  // the seeds above when it lands. Best-effort - a degraded Supabase
  // doesn't gate the bootstrap.
  void loadSettings();
}

async function loadSettings(): Promise<void> {
  if (!app.supabase) return;
  try {
    const settings = await app.supabase.getSettings();
    applyServerSettings(settings);
  } catch {
    // Best-effort: keep the seeds set in `activate()`. A Supabase
    // outage doesn't gate the entire bootstrap.
  }
}

/**
 * Wipe the per-session caches. The `resetUsage()` / `resetCatalog()` /
 * `resetImageCatalog()` calls keep billing rows and the model catalogs
 * from leaking across a sign-out / sign-in-as-someone-else into the
 * Settings panes' caches.
 */
function resetSessionCaches(): void {
  resetUsage();
  resetCatalog();
  resetImageCatalog();
}

/**
 * Halt background processing because a newer build is waiting. Called
 * from `update.svelte.ts::onNeedRefresh` once the SW reports a waiting
 * version; the page reload through `applyUpdate()` is the only way out
 * of the halted state. With the worker fleet fully server-side this
 * has shrunk to the cache resets - it survives as the update flow's
 * hook point until the lease apparatus teardown decides its fate.
 */
export function haltBackgroundWork(): void {
  if (workersHalted) return;
  workersHalted = true;
  resetSessionCaches();
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
 * Session caches are reset because the services they were pinned to
 * are about to be torn down. Profile defaults are NOT reset (unlike
 * `resetForSignOut`) since the user is going to re-activate against
 * the same account once they fix the config - keeping the seeds
 * avoids a visible flash of generic timezone + empty profile while
 * settings re-load.
 */
export function enterSetup(): void {
  resetSessionCaches();
  app.supabase = null;
  app.venice = null;
  app.config = null;
  app.phase = 'setup';
  app.error = null;
}

/**
 * Reset the in-memory user state and session caches. Called by the
 * Sign-out path in Settings - sign-out is the only "tear everything
 * down" affordance the app has for an authenticated session (see the
 * phase-state-machine docblock in `./root.svelte.ts`). The stored
 * config in localStorage stays untouched; a subsequent sign-in
 * re-uses it without going through Setup. Use `clearStoredConfig()`
 * (config.ts) for the heavier "this device should forget the project
 * entirely" affordance, or `enterSetup()` above for the "fix
 * mistyped Supabase keys" affordance.
 */
export function resetForSignOut(): void {
  resetSessionCaches();
  seedProfileDefaults();
  // systemPrompts is reset here but not in activate(): sign-out must
  // never leak the previous account's prompt library across a
  // sign-in-as-someone-else, whereas activate() leaves it for the
  // settings fetch to overwrite.
  app.systemPrompts = [];
}
