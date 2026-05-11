/**
 * Persistent configuration blob for the three keys the app needs to talk
 * to its external services. Encrypted with the user's master password
 * (via `./crypto`) and kept in localStorage.
 *
 * The three keys here are the *only* things we persist to disk in
 * encrypted form. Per-user preferences (default model tier, theme) live
 * in Supabase `profiles.settings` once the user signs in — see
 * `./supabase.ts`. In-memory app state, including the decrypted config
 * while the app is unlocked, is owned by `./state.svelte.ts`.
 *
 * Also defines the plaintext export/import format (kind="nak-config",
 * version=1) used by the Setup → Import flow and the Settings → Export
 * panel. Export is plaintext by design — users should store the file
 * like any other secret (password manager, etc.).
 */
import { encrypt, decrypt } from './crypto';

export interface AppConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  veniceApiKey: string;
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
  const anon = c.supabaseAnonKey;
  const venice = c.veniceApiKey;
  if (typeof url !== 'string' || typeof anon !== 'string' || typeof venice !== 'string') {
    throw new ConfigError('Stored config is missing required fields.');
  }
  if (!/^https?:\/\//.test(url)) {
    throw new ConfigError('supabaseUrl must start with http(s)://');
  }
  // Any unknown fields (including the legacy `defaultModel` from before
  // settings moved to Supabase) are dropped silently on read.
  return { supabaseUrl: url, supabaseAnonKey: anon, veniceApiKey: venice };
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
const EXPORT_VERSION = 1;

export interface ExportedConfig {
  kind: typeof EXPORT_KIND;
  version: typeof EXPORT_VERSION;
  supabaseUrl: string;
  supabaseAnonKey: string;
  veniceApiKey: string;
}

export function toExportedConfig(config: AppConfig): ExportedConfig {
  return {
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey,
    veniceApiKey: config.veniceApiKey,
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
  if (r.version !== EXPORT_VERSION) {
    throw new ConfigError(
      `Unsupported config file version: ${String(r.version)}. Expected ${EXPORT_VERSION}.`
    );
  }
  const supabaseUrl = typeof r.supabaseUrl === 'string' ? r.supabaseUrl.trim() : '';
  const supabaseAnonKey = typeof r.supabaseAnonKey === 'string' ? r.supabaseAnonKey.trim() : '';
  const veniceApiKey = typeof r.veniceApiKey === 'string' ? r.veniceApiKey.trim() : '';
  if (!/^https?:\/\//.test(supabaseUrl)) {
    throw new ConfigError('Missing or invalid supabaseUrl.');
  }
  if (!supabaseAnonKey) throw new ConfigError('Missing supabaseAnonKey.');
  if (!veniceApiKey) throw new ConfigError('Missing veniceApiKey.');
  return { supabaseUrl, supabaseAnonKey, veniceApiKey };
}
