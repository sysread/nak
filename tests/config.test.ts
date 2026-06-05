import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveConfig,
  loadConfig,
  hasStoredConfig,
  clearStoredConfig,
  ConfigError,
  toExportedConfig,
  parseExportedConfig,
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

  it('persists and reads back a config', () => {
    saveConfig(VALID);
    expect(hasStoredConfig()).toBe(true);
    expect(loadConfig()).toEqual(VALID);
  });

  it('returns null when nothing stored', () => {
    expect(loadConfig()).toBeNull();
  });

  it('rejects invalid URL on save', () => {
    expect(() =>
      saveConfig({ ...VALID, supabaseUrl: 'not-a-url' })
    ).toThrow(ConfigError);
  });

  it('clearStoredConfig removes the blob', () => {
    saveConfig(VALID);
    clearStoredConfig();
    expect(hasStoredConfig()).toBe(false);
  });

  it('stores plaintext JSON (no encryption)', () => {
    saveConfig(VALID);
    const blob = localStorage.getItem('nak:config:v2') ?? '';
    expect(blob).toContain(VALID.supabasePublishableKey);
    expect(blob).toContain('supabase.co');
    expect(() => JSON.parse(blob)).not.toThrow();
  });

  it('treats a legacy v1 ciphertext entry as no-config', () => {
    // Older builds wrote AES-GCM ciphertext under `nak:config:v1`. After
    // the master-password rip the new code reads under `:v2` only; the
    // legacy entry stays untouched until the next saveConfig clears it.
    // hasStoredConfig must report false so the App.svelte phase routing
    // forwards a fresh-browser-feeling user through Setup.
    localStorage.setItem('nak:config:v1', 'base64-looking-ciphertext-blob');
    expect(hasStoredConfig()).toBe(false);
    expect(loadConfig()).toBeNull();
  });

  it('saveConfig drops the legacy v1 entry on the way in', () => {
    localStorage.setItem('nak:config:v1', 'orphaned-ciphertext');
    saveConfig(VALID);
    expect(localStorage.getItem('nak:config:v1')).toBeNull();
  });

  it('clearStoredConfig drops the legacy v1 entry too', () => {
    localStorage.setItem('nak:config:v1', 'orphaned-ciphertext');
    saveConfig(VALID);
    clearStoredConfig();
    expect(localStorage.getItem('nak:config:v1')).toBeNull();
    expect(localStorage.getItem('nak:config:v2')).toBeNull();
  });

  it('returns null when the stored JSON is malformed', () => {
    localStorage.setItem('nak:config:v2', '{not valid');
    expect(loadConfig()).toBeNull();
  });

  it('returns null when the stored shape is missing required fields', () => {
    localStorage.setItem('nak:config:v2', JSON.stringify({ supabaseUrl: 'https://x' }));
    expect(loadConfig()).toBeNull();
  });

  it('round-trips via toExportedConfig / parseExportedConfig', () => {
    const exported = toExportedConfig(VALID);
    const json = JSON.stringify(exported);
    expect(parseExportedConfig(json)).toEqual(VALID);
  });

  it('parseExportedConfig accepts a legacy v1 file (supabaseAnonKey)', () => {
    // Files exported before the anon->publishable rename are v1 and carry the
    // key under `supabaseAnonKey`. They must still import, mapped onto the
    // current `supabasePublishableKey` field. The legacy `veniceApiKey`
    // field on the file is dropped silently - the streaming-root
    // migration retired the per-user key.
    const legacy = JSON.stringify({
      kind: 'nak-config',
      version: 1,
      supabaseUrl: VALID.supabaseUrl,
      supabaseAnonKey: VALID.supabasePublishableKey,
      veniceApiKey: LEGACY_VENICE_KEY,
    });
    expect(parseExportedConfig(legacy)).toEqual(VALID);
  });

  it('parseExportedConfig rejects a file missing the kind marker', () => {
    const bad = JSON.stringify({ version: 1, ...VALID });
    expect(() => parseExportedConfig(bad)).toThrow(/Nak config/i);
  });

  it('parseExportedConfig rejects a future version', () => {
    const bad = JSON.stringify({ kind: 'nak-config', version: 9999, ...VALID });
    expect(() => parseExportedConfig(bad)).toThrow(/version/i);
  });

  it('parseExportedConfig rejects malformed JSON', () => {
    expect(() => parseExportedConfig('{ not json')).toThrow(/JSON/i);
  });

  it('parseExportedConfig rejects a missing supabaseUrl', () => {
    const bad = JSON.stringify({ kind: 'nak-config', version: 1, supabaseAnonKey: 'a' });
    expect(() => parseExportedConfig(bad)).toThrow(/supabaseUrl/i);
  });

  it('ignores unknown fields in the stored blob on read', () => {
    saveConfig(
      { ...VALID, defaultModel: 'smart' } as unknown as typeof VALID,
    );
    const loaded = loadConfig();
    expect(loaded).toEqual(VALID);
    expect(loaded as unknown as Record<string, unknown>).not.toHaveProperty('defaultModel');
  });
});
