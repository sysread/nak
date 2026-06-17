/**
 * DEV-only convenience seam for local development and headless QA.
 *
 * `mise run dev-start` writes a gitignored `.env.local` carrying the
 * local Supabase URL/key and the seeded dev-user credentials as
 * `VITE_NAK_DEV_*` vars (see scripts/dev-local.mjs). This module reads
 * them so a fresh browser - or a Playwright/QA agent driving one - lands
 * straight in Chat without the Setup -> Import JSON -> sign-in dance.
 *
 * Safety posture:
 * - Every entry point is gated by the caller on `import.meta.env.DEV`,
 *   so the production bundle dead-code-eliminates these calls. The vars
 *   are also simply absent in any non-dev-start session (dev-frontend
 *   against cloud never writes them; dev-start removes them on
 *   teardown), so the seam is inert by default even in a dev build.
 * - Config is only seeded when NO config is already stored, so a
 *   developer pointing the dev server at their cloud project is never
 *   clobbered.
 * - Auto-login no-ops when a valid session already exists and swallows
 *   failures - a bad/absent dev credential just leaves the normal Auth
 *   screen up.
 *
 * None of these values are secrets: the publishable key ships in the
 * client bundle and the dev creds only authenticate against a loopback
 * stack.
 */
import type { AppConfig } from './config';
import type { SupabaseService } from './supabase';
import { createLogger } from './logger.svelte';

const log = createLogger('dev');

/**
 * The local Supabase config from `.env.local`, or null when the
 * `VITE_NAK_DEV_*` vars are absent (any session not started by
 * dev-start). Shape matches what `saveConfig` / `activate` expect.
 */
export function devConfigFromEnv(): AppConfig | null {
  const url = import.meta.env.VITE_NAK_DEV_SUPABASE_URL;
  const key = import.meta.env.VITE_NAK_DEV_SUPABASE_KEY;
  if (typeof url !== 'string' || typeof key !== 'string') return null;
  if (url.length === 0 || key.length === 0) return null;
  return { supabaseUrl: url, supabasePublishableKey: key };
}

/**
 * The seeded dev-user credentials from `.env.local`, or null when
 * absent. Used only by devAutoLogin below.
 */
function devCredsFromEnv(): { email: string; password: string } | null {
  const email = import.meta.env.VITE_NAK_DEV_EMAIL;
  const password = import.meta.env.VITE_NAK_DEV_PASSWORD;
  if (typeof email !== 'string' || typeof password !== 'string') return null;
  if (email.length === 0 || password.length === 0) return null;
  return { email, password };
}

/**
 * Sign in the seeded dev user if credentials are present and no session
 * is live yet. Best-effort: the app's onAuthStateChange listener picks
 * up the resulting session and renders Chat exactly as a manual sign-in
 * would. Safe to call once after activate().
 */
export async function devAutoLogin(supabase: SupabaseService): Promise<void> {
  const creds = devCredsFromEnv();
  if (!creds) return;
  try {
    // A persisted session is still valid - skip the round-trip rather
    // than re-authenticating on every reload.
    const existing = await supabase.getSession();
    if (existing) return;
    await supabase.signIn(creds.email, creds.password);
    log.info('dev auto-login: signed in seeded dev user');
  } catch (err) {
    // Leave the normal Auth screen up; the developer signs in by hand.
    log.warn('dev auto-login failed; falling back to the sign-in screen', err);
  }
}
