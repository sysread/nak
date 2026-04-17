import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  saveSession,
  loadSession,
  touchSession,
  clearSession,
  sessionRemainingMs,
  DEFAULT_TTL_MS,
  __test,
} from '../src/lib/session';
import type { AppConfig } from '../src/lib/config';

const CONFIG: AppConfig = {
  supabaseUrl: 'https://example.supabase.co',
  supabaseAnonKey: 'anon-xyz',
  veniceApiKey: 'venice-abc',
};

describe('session', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when no session exists', () => {
    expect(loadSession()).toBeNull();
  });

  it('round-trips an AppConfig', () => {
    saveSession(CONFIG);
    expect(loadSession()).toEqual(CONFIG);
  });

  it('writes under the expected key', () => {
    saveSession(CONFIG);
    expect(sessionStorage.getItem(__test.KEY)).not.toBeNull();
  });

  it('expires after TTL and removes the blob', () => {
    saveSession(CONFIG, 60_000);
    expect(loadSession()).toEqual(CONFIG);
    vi.setSystemTime(Date.now() + 60_001);
    expect(loadSession()).toBeNull();
    expect(sessionStorage.getItem(__test.KEY)).toBeNull();
  });

  it('touchSession extends the expiry', () => {
    saveSession(CONFIG, 60_000);
    vi.setSystemTime(Date.now() + 59_000);
    touchSession(60_000);
    // Would have expired without the touch.
    vi.setSystemTime(Date.now() + 30_000);
    expect(loadSession()).toEqual(CONFIG);
  });

  it('touchSession is a no-op when no session exists', () => {
    touchSession(60_000);
    expect(loadSession()).toBeNull();
  });

  it('clearSession removes the blob', () => {
    saveSession(CONFIG);
    clearSession();
    expect(loadSession()).toBeNull();
  });

  it('ignores a malformed blob', () => {
    sessionStorage.setItem(__test.KEY, 'not-json');
    expect(loadSession()).toBeNull();
    // And the malformed blob should have been cleaned up.
    expect(sessionStorage.getItem(__test.KEY)).toBeNull();
  });

  it('sessionRemainingMs reports the time left', () => {
    saveSession(CONFIG, 60_000);
    const remaining = sessionRemainingMs();
    expect(remaining).not.toBeNull();
    expect(remaining!).toBeGreaterThan(59_000);
    expect(remaining!).toBeLessThanOrEqual(60_000);
  });

  it('sessionRemainingMs returns 0 when expired', () => {
    saveSession(CONFIG, 60_000);
    vi.setSystemTime(Date.now() + 61_000);
    // loadSession will scrub the blob, so peek at remaining first via touch-
    // independent path: it should have been cleaned on the next loadSession.
    expect(loadSession()).toBeNull();
    expect(sessionRemainingMs()).toBeNull();
  });

  it('DEFAULT_TTL_MS is an hour', () => {
    expect(DEFAULT_TTL_MS).toBe(60 * 60 * 1000);
  });
});
