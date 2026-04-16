import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveConfig,
  loadConfig,
  hasStoredConfig,
  clearStoredConfig,
  changePassword,
  ConfigError,
} from '../src/lib/config';

const VALID = {
  supabaseUrl: 'https://example.supabase.co',
  supabaseAnonKey: 'anon-xxx',
  veniceApiKey: 'venice-yyy',
};

describe('config', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reports no stored config on a fresh browser', () => {
    expect(hasStoredConfig()).toBe(false);
  });

  it('persists and decrypts a config', async () => {
    await saveConfig(VALID, 'supersecret');
    expect(hasStoredConfig()).toBe(true);
    const loaded = await loadConfig('supersecret');
    expect(loaded).toEqual(VALID);
  });

  it('returns null when nothing stored', async () => {
    expect(await loadConfig('x')).toBeNull();
  });

  it('rejects wrong password with ConfigError', async () => {
    await saveConfig(VALID, 'right');
    await expect(loadConfig('wrong')).rejects.toBeInstanceOf(ConfigError);
  });

  it('rejects invalid URL on save', async () => {
    await expect(
      saveConfig({ ...VALID, supabaseUrl: 'not-a-url' }, 'pw')
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('clearStoredConfig removes the blob', async () => {
    await saveConfig(VALID, 'pw');
    clearStoredConfig();
    expect(hasStoredConfig()).toBe(false);
  });

  it('changePassword requires old password and re-encrypts', async () => {
    await saveConfig(VALID, 'old-pw-123');
    await changePassword('old-pw-123', 'new-pw-456');
    await expect(loadConfig('old-pw-123')).rejects.toThrow();
    expect(await loadConfig('new-pw-456')).toEqual(VALID);
  });

  it('changePassword rejects short new password', async () => {
    await saveConfig(VALID, 'old-pw-123');
    await expect(changePassword('old-pw-123', 'short')).rejects.toThrow(/8 characters/);
  });

  it('does NOT store plaintext secrets', async () => {
    await saveConfig(VALID, 'pw');
    const blob = localStorage.getItem('byo-chat:config:v1') ?? '';
    expect(blob).not.toContain(VALID.supabaseAnonKey);
    expect(blob).not.toContain(VALID.veniceApiKey);
    expect(blob).not.toContain('supabase.co');
  });
});
