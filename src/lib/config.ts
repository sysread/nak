/**
 * Persistent configuration blob for the keys the app needs to talk to
 * its external services. Encrypted with the user's master password (via
 * `./crypto`) and kept in localStorage.
 *
 * What's persisted to disk is the *only* thing we persist in encrypted
 * form. Per-user preferences (default model tier, theme) live in
 * Supabase `profiles.settings` once the user signs in - see
 * `./supabase.ts`. In-memory app state, including the decrypted config
 * while the app is unlocked, is owned by `./state.svelte.ts`.
 *
 * The streaming-root migration dropped the per-user Venice API key:
 * every Venice consumer in the browser now routes through an edge
 * function that reads the shared key from `app_config` server-side.
 * Older saved configs still carry a `veniceApiKey` field; the
 * validator silently drops it on read so existing users keep working
 * without re-entering anything. Same for imported config files.
 *
 * Export/import format: kind="nak-config", version=2. v2 renamed the
 * client-key field supabaseAnonKey -> supabasePublishableKey to match
 * Supabase's modern API-key nomenclature; both the import parser and
 * the stored-blob validator still read the legacy field, so older
 * exported files and saved configs keep working. Export is plaintext
 * by design - users should store the file like any other secret.
 */
import { encrypt, decrypt } from './crypto';

export interface AppConfig {
  supabaseUrl: string;
  supabasePublishableKey: string;
}

// The `:v1` suffix is a migration escape hatch: if we ever change the
// on-disk shape in a non-backward-compatible way, a new `nak:config:v2`
// key lets old and new clients coexist on the same origin long enough
// to migrate.
const STORAGE_KEY = 'nak:config:v1';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function getStorage(): Storage {
  if (typeof localStorage === 'undefined') {
    throw new ConfigError('localStorage is not available in this environment.');
  }
  return localStorage;
}

export function hasStoredConfig(): boolean {
  try {
    return getStorage().getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function clearStoredConfig(): void {
  getStorage().removeItem(STORAGE_KEY);
}

/**
 * Defense-in-depth validator run on every load. If an older build wrote
 * extra fields, or a malicious script managed to tamper with the JSON
 * after decrypt, we drop unknown keys and reject anything that doesn't
 * look like the three required strings. The HTTPS check is a sanity
 * guard rather than a security boundary — the real URL is ultimately
 * whatever the user typed into Setup.
 */
function validateConfig(candidate: unknown): AppConfig {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new ConfigError('Stored config is not an object.');
  }
  const c = candidate as Record<string, unknown>;
  const url = c.supabaseUrl;
  // Blobs saved before the anon->publishable rename stored the client key
  // under `supabaseAnonKey`. Read the new field, fall back to the legacy
  // one, so an older saved config still loads; the next saveConfig rewrites
  // it under the new name. The value is the Supabase client key either way
  // (a publishable key now, a legacy anon JWT on older/local projects).
  const pub = c.supabasePublishableKey ?? c.supabaseAnonKey;
  if (typeof url !== 'string' || typeof pub !== 'string') {
    throw new ConfigError('Stored config is missing required fields.');
  }
  if (!/^https?:\/\//.test(url)) {
    throw new ConfigError('supabaseUrl must start with http(s)://');
  }
  // Any unknown fields (including the legacy `defaultModel` from before
  // settings moved to Supabase, and the legacy `veniceApiKey` from before
  // the streaming-root migration moved every Venice consumer behind an
  // edge function) are dropped silently on read.
  return { supabaseUrl: url, supabasePublishableKey: pub };
}

/**
 * Decrypts the stored config using the password. Returns null when no config
 * is stored. Throws ConfigError on wrong password or corrupted data.
 */
export async function loadConfig(password: string): Promise<AppConfig | null> {
  const blob = getStorage().getItem(STORAGE_KEY);
  if (blob === null) return null;
  let json: string;
  try {
    json = await decrypt(blob, password);
  } catch (err) {
    throw new ConfigError(
      err instanceof Error ? err.message : 'Failed to decrypt stored config.'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ConfigError('Decrypted config is not valid JSON.');
  }
  return validateConfig(parsed);
}

/**
 * Encrypts the config with the given password and persists it. Overwrites
 * any existing blob.
 */
export async function saveConfig(config: AppConfig, password: string): Promise<void> {
  const clean = validateConfig(config);
  const payload = JSON.stringify(clean);
  const blob = await encrypt(payload, password);
  getStorage().setItem(STORAGE_KEY, blob);
}

/**
 * Re-encrypts the stored config under a new password. Requires the old
 * password to decrypt first, so callers prove knowledge of the secret.
 */
export async function changePassword(
  oldPassword: string,
  newPassword: string
): Promise<void> {
  const existing = await loadConfig(oldPassword);
  if (existing === null) throw new ConfigError('No stored config to re-encrypt.');
  if (newPassword.length < 8) {
    throw new ConfigError('New password must be at least 8 characters.');
  }
  await saveConfig(existing, newPassword);
}

// ---------------------------------------------------------------------------
// Export / import of the PLAINTEXT local config — the three keys only.
// Used so users can move credentials to a new browser without re-typing.
// The produced file contains secrets; callers should warn the user.
// ---------------------------------------------------------------------------

const EXPORT_KIND = 'nak-config';
// v2 renamed supabaseAnonKey -> supabasePublishableKey. We write v2; the
// parser still accepts v1 (legacy field) so old exported files import.
const EXPORT_VERSION = 2;

export interface ExportedConfig {
  kind: typeof EXPORT_KIND;
  version: typeof EXPORT_VERSION;
  supabaseUrl: string;
  supabasePublishableKey: string;
}

export function toExportedConfig(config: AppConfig): ExportedConfig {
  return {
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    supabaseUrl: config.supabaseUrl,
    supabasePublishableKey: config.supabasePublishableKey,
  };
}

export function parseExportedConfig(raw: string): AppConfig {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new ConfigError('File is not valid JSON.');
  }
  if (typeof obj !== 'object' || obj === null) {
    throw new ConfigError('File is not a JSON object.');
  }
  const r = obj as Record<string, unknown>;
  if (r.kind !== EXPORT_KIND) {
    throw new ConfigError('Not a Nak config file (wrong `kind`).');
  }
  // Accept v1 (legacy `supabaseAnonKey`) and v2 (`supabasePublishableKey`).
  if (r.version !== 1 && r.version !== 2) {
    throw new ConfigError(
      `Unsupported config file version: ${String(r.version)}. Expected 1 or 2.`
    );
  }
  const supabaseUrl = typeof r.supabaseUrl === 'string' ? r.supabaseUrl.trim() : '';
  // New field first, legacy `supabaseAnonKey` as the v1 fallback.
  const rawPub = r.supabasePublishableKey ?? r.supabaseAnonKey;
  const supabasePublishableKey = typeof rawPub === 'string' ? rawPub.trim() : '';
  if (!/^https?:\/\//.test(supabaseUrl)) {
    throw new ConfigError('Missing or invalid supabaseUrl.');
  }
  if (!supabasePublishableKey) throw new ConfigError('Missing Supabase publishable key.');
  // Older exported files included a `veniceApiKey` field; that's
  // dropped silently here - the streaming-root migration moved every
  // Venice consumer behind an edge function that reads a shared key
  // from app_config, so the per-user key is no longer needed.
  return { supabaseUrl, supabasePublishableKey };
}
