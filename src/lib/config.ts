import { encrypt, decrypt } from './crypto';

export interface AppConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  veniceApiKey: string;
}

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

export const __storage = {
  STORAGE_KEY,
};
