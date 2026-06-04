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
  supabasePublishableKey: 'sb_publishable_xxx',
};

// Legacy field name retained in some tests to exercise the
// backward-compatible read path (the streaming-root migration retired
// the per-user Venice API key, but older saved blobs and exported files
// still carry it). validateConfig + parseExportedConfig drop it
// silently; consumers see the trimmed AppConfig shape.
const LEGACY_VENICE_KEY = 'venice-yyy';

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
    const blob = localStorage.getItem('nak:config:v1') ?? '';
    expect(blob).not.toContain(VALID.supabasePublishableKey);
    expect(blob).not.toContain('supabase.co');
  });

  it('round-trips via toExportedConfig / parseExportedConfig', async () => {
    const { toExportedConfig, parseExportedConfig } = await import('../src/lib/config');
    const exported = toExportedConfig(VALID);
    const json = JSON.stringify(exported);
    expect(parseExportedConfig(json)).toEqual(VALID);
  });

  it('parseExportedConfig accepts a legacy v1 file (supabaseAnonKey)', async () => {
    // Files exported before the anon->publishable rename are v1 and carry the
    // key under `supabaseAnonKey`. They must still import, mapped onto the
    // current `supabasePublishableKey` field. The legacy `veniceApiKey`
    // field on the file is dropped silently - the streaming-root
    // migration retired the per-user key.
    const { parseExportedConfig } = await import('../src/lib/config');
    const legacy = JSON.stringify({
      kind: 'nak-config',
      version: 1,
      supabaseUrl: VALID.supabaseUrl,
      supabaseAnonKey: VALID.supabasePublishableKey,
      veniceApiKey: LEGACY_VENICE_KEY,
    });
    expect(parseExportedConfig(legacy)).toEqual(VALID);
  });

  it('parseExportedConfig rejects a file missing the kind marker', async () => {
    const { parseExportedConfig } = await import('../src/lib/config');
    const bad = JSON.stringify({ version: 1, ...VALID });
    expect(() => parseExportedConfig(bad)).toThrow(/Nak config/i);
  });

  it('parseExportedConfig rejects a future version', async () => {
    const { parseExportedConfig } = await import('../src/lib/config');
    const bad = JSON.stringify({ kind: 'nak-config', version: 9999, ...VALID });
    expect(() => parseExportedConfig(bad)).toThrow(/version/i);
  });

  it('parseExportedConfig rejects malformed JSON', async () => {
    const { parseExportedConfig } = await import('../src/lib/config');
    expect(() => parseExportedConfig('{ not json')).toThrow(/JSON/i);
  });

  it('parseExportedConfig rejects a missing supabaseUrl', async () => {
    const { parseExportedConfig } = await import('../src/lib/config');
    const bad = JSON.stringify({ kind: 'nak-config', version: 1, supabaseAnonKey: 'a' });
    expect(() => parseExportedConfig(bad)).toThrow(/supabaseUrl/i);
  });

  it('ignores unknown fields in a legacy blob on read', async () => {
    // Simulate a blob written by an earlier build that carried a
    // `defaultModel` field. The current validator should drop it and still
    // decrypt cleanly.
    await saveConfig(
      { ...VALID, defaultModel: 'smart' } as unknown as typeof VALID,
      'pw'
    );
    const loaded = await loadConfig('pw');
    expect(loaded).toEqual(VALID);
    expect(loaded as unknown as Record<string, unknown>).not.toHaveProperty('defaultModel');
  });
});
