import type { AppConfig } from './config';
import { SupabaseService } from './supabase';
import { VeniceClient } from './venice';

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

export function activate(config: AppConfig): void {
  app.config = config;
  app.supabase = new SupabaseService(config);
  app.venice = new VeniceClient({ apiKey: config.veniceApiKey });
  app.phase = 'unlocked';
  app.error = null;
}

export function lock(): void {
  app.config = null;
  app.supabase = null;
  app.venice = null;
  app.phase = 'locked';
}
