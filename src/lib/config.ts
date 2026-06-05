/**
 * Persistent configuration blob for the values the browser needs to
 * reach the user's Supabase project. Stored as PLAINTEXT JSON in
 * localStorage under `nak:config:v2`.
 *
 * Two fields: `supabaseUrl` and `supabasePublishableKey`. Neither is
 * a secret in the RLS-key sense - the publishable key is meant to
 * ship in client bundles and every table policy is
 * `auth.uid() = user_id`, so an attacker with the key still has to
 * sign in through Supabase auth to read any row. The Venice API key
 * is held server-side in the project's `app_config` table; browsers
 * never see it.
 *
 * Per-user preferences (default model tier, theme, system prompts,
 * profile) live in Supabase `profiles.settings` once the user signs
 * in - see `./supabase.ts`. In-memory app state, including the
 * active config, is owned by `./state.svelte.ts`.
 *
 * Older browsers may carry a stale `nak:config:v1` entry that held an
 * AES-GCM ciphertext keyed by a per-device master password; that
 * envelope is no longer read by any path. `loadConfig` ignores it and
 * `saveConfig` / `clearStoredConfig` remove it on the next write so
 * the dead bytes don't accumulate.
 *
 * Export/import format: kind="nak-config", version=2. v2 renamed the
 * client-key field supabaseAnonKey -> supabasePublishableKey to match
 * Supabase's modern API-key nomenclature; both the import parser and
 * the stored-blob validator still read the legacy field, so older
 * exported files keep working.
 */

export interface AppConfig {
  supabaseUrl: string;
  supabasePublishableKey: string;
}

// `nak:config:v2` is the plaintext key. The legacy `nak:config:v1`
// entry held an AES-GCM ciphertext keyed by a per-device master
// password; no path reads it any more. saveConfig() and
// clearStoredConfig() remove it on touch so a browser carrying the
// stale entry doesn't keep it around indefinitely.
const STORAGE_KEY = 'nak:config:v2';
const LEGACY_STORAGE_KEY = 'nak:config:v1';

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

function dropLegacyEntry(): void {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Storage unavailable / tabs racing on quota. Worst case the
    // legacy entry stays around forever - it's just dead bytes, no
    // path reads it.
  }
}

export function hasStoredConfig(): boolean {
  return loadConfig() !== null;
}

export function clearStoredConfig(): void {
  getStorage().removeItem(STORAGE_KEY);
  dropLegacyEntry();
}

/**
 * Defense-in-depth validator run on every load. Drops unknown fields
 * and rejects anything that doesn't carry the two required strings.
 * Reads both the new and legacy publishable-key field names so an
 * older v1-shaped JSON paste still imports.
 */
function validateConfig(candidate: unknown): AppConfig {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new ConfigError('Stored config is not an object.');
  }
  const c = candidate as Record<string, unknown>;
  const url = c.supabaseUrl;
  const pub = c.supabasePublishableKey ?? c.supabaseAnonKey;
  if (typeof url !== 'string' || typeof pub !== 'string') {
    throw new ConfigError('Stored config is missing required fields.');
  }
  if (!/^https?:\/\//.test(url)) {
    throw new ConfigError('supabaseUrl must start with http(s)://');
  }
  // Drop any unknown fields silently. Older blobs may carry leftover
  // keys (`defaultModel`, `veniceApiKey`); only the two strings the
  // current shape declares survive the projection.
  return { supabaseUrl: url, supabasePublishableKey: pub };
}

/**
 * Read the persisted config from localStorage. Returns null on any
 * problem (no entry, not valid JSON, validateConfig rejection). The
 * legacy v1 entry stays untouched on read; saveConfig and
 * clearStoredConfig are responsible for the lazy cleanup.
 */
export function loadConfig(): AppConfig | null {
  let raw: string | null;
  try {
    raw = getStorage().getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  try {
    return validateConfig(parsed);
  } catch {
    return null;
  }
}

/**
 * Persist the config to localStorage as plaintext JSON. Overwrites
 * any existing entry. Also drops the legacy encrypted entry so a
 * browser carrying a stale v1 blob doesn't keep it around forever.
 */
export function saveConfig(config: AppConfig): void {
  const clean = validateConfig(config);
  getStorage().setItem(STORAGE_KEY, JSON.stringify(clean));
  dropLegacyEntry();
}

// ---------------------------------------------------------------------------
// Export / import of the local config. Lets the user move credentials to
// a new browser without re-typing them. The export is plaintext JSON -
// none of the values are secrets in the RLS-key sense.
// ---------------------------------------------------------------------------

const EXPORT_KIND = 'nak-config';
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
  if (r.version !== 1 && r.version !== 2) {
    throw new ConfigError(
      `Unsupported config file version: ${String(r.version)}. Expected 1 or 2.`
    );
  }
  const supabaseUrl = typeof r.supabaseUrl === 'string' ? r.supabaseUrl.trim() : '';
  const rawPub = r.supabasePublishableKey ?? r.supabaseAnonKey;
  const supabasePublishableKey = typeof rawPub === 'string' ? rawPub.trim() : '';
  if (!/^https?:\/\//.test(supabaseUrl)) {
    throw new ConfigError('Missing or invalid supabaseUrl.');
  }
  if (!supabasePublishableKey) throw new ConfigError('Missing Supabase publishable key.');
  return { supabaseUrl, supabasePublishableKey };
}
