import type { AppConfig } from './config';
import { SupabaseService } from './supabase';
import { VeniceClient } from './venice';
import { saveSession, clearSession } from './session';
import { DEFAULT_TIER, type ModelTier } from './models';

export type AppPhase = 'loading' | 'setup' | 'locked' | 'unlocked';

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
  error: string | null;
}

export const app = $state<AppState>({
  phase: 'loading',
  config: null,
  supabase: null,
  venice: null,
  defaultModel: DEFAULT_TIER,
  error: null,
});

export function setDefaultModel(tier: ModelTier): void {
  app.defaultModel = tier;
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
  app.phase = 'unlocked';
  app.error = null;
  if (opts.persist !== false) saveSession(config);
}

export function lock(): void {
  app.config = null;
  app.supabase = null;
  app.venice = null;
  app.defaultModel = DEFAULT_TIER;
  app.phase = 'locked';
  clearSession();
}
