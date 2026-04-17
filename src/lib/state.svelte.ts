import type { AppConfig } from './config';
import { SupabaseService } from './supabase';
import { VeniceClient } from './venice';
import { saveSession, clearSession } from './session';

export type AppPhase = 'loading' | 'setup' | 'locked' | 'unlocked';

interface AppState {
  phase: AppPhase;
  config: AppConfig | null;
  supabase: SupabaseService | null;
  venice: VeniceClient | null;
  error: string | null;
}

export const app = $state<AppState>({
  phase: 'loading',
  config: null,
  supabase: null,
  venice: null,
  error: null,
});

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
  app.phase = 'unlocked';
  app.error = null;
  if (opts.persist !== false) saveSession(config);
}

export function lock(): void {
  app.config = null;
  app.supabase = null;
  app.venice = null;
  app.phase = 'locked';
  clearSession();
}
