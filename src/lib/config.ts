/**
 * Persistent configuration blob for the keys the app needs to talk to
 * its external services. Stored as PLAINTEXT JSON in localStorage.
 *
 * Why plaintext: the remaining values (supabaseUrl + supabasePublishableKey)
 * are not secrets by design. Per Supabase nomenclature, the
 * publishable key IS meant to ship in client bundles - security comes
 * from RLS on the tables plus the email/password auth flow, not from
 * the key's confidentiality. The streaming-root migration dropped the
 * per-user Venice API key (every Venice consumer routes through an
 * edge function reading a shared key from `app_config` server-side),
 * which was the last value that materially benefited from at-rest
 * encryption. With that gone, the master-password ceremony was paying
 * a UX cost (every fresh session = an Unlock screen, occasional
 * cross-browser foot-shooting on password changes) for essentially
 * zero security gain. Hard-reset migration: legacy v1 entries are
 * orphaned on first load (validateConfig fails on the encrypted
 * string, hasStoredConfig returns false, the user goes through
 * setup again).
 *
 * What's persisted to disk is the *only* thing we persist locally for
 * config. Per-user preferences (default model tier, theme) live in
 * Supabase `profiles.settings` once the user signs in - see
 * `./supabase.ts`. In-memory app state, including the active config,
 * is owned by `./state.svelte.ts`.
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

// `nak:config:v2` is the post-master-password key. The legacy
// `nak:config:v1` entry held an AES-GCM ciphertext keyed by the user's
// master password; that key is orphaned by saveConfig() / cleared by
// clearStoredConfig() and never read again. Bumping to v2 also means a
// browser that updates from a legacy build naturally goes through
// setup again instead of crashing on a parse of the old ciphertext.
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
  // Drop any unknown fields silently. The legacy `defaultModel` (before
  // settings moved to Supabase) and `veniceApiKey` (before the
  // streaming-root migration retired the per-user key) are the two
  // expected stragglers; anything else newer builds carry forward into
  // their own column.
  return { supabaseUrl: url, supabasePublishableKey: pub };
}

/**
 * Read the persisted config from localStorage. Returns null on any
 * problem (no entry, not valid JSON - which is the legacy encrypted
 * blob case, validateConfig rejection). The legacy v1 entry stays
 * untouched here; saveConfig / clearStoredConfig is responsible for
 * the lazy cleanup.
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
 * Persist the config to localStorage as plaintext JSON. Overwrites any
 * existing entry. Also drops the legacy encrypted entry so it doesn't
 * accumulate after a successful migration through Setup.
 */
export function saveConfig(config: AppConfig): void {
  const clean = validateConfig(config);
  getStorage().setItem(STORAGE_KEY, JSON.stringify(clean));
  dropLegacyEntry();
}

// ---------------------------------------------------------------------------
// Export / import of the local config. Used so users can move credentials to
// a new browser without re-typing. Same shape as before the master-password
// rip - the export was always plaintext, no migration needed for users who
// kept an exported file around.
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
