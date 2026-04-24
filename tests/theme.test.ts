import { describe, it, expect, beforeEach } from 'vitest';
import {
  ACCENTS,
  MODES,
  DEFAULT_ACCENT,
  DEFAULT_MODE,
  isAccent,
  isColorMode,
  cacheTheme,
  readCachedTheme,
  __cacheKey,
} from '../src/lib/theme';

describe('theme enums', () => {
  it('ACCENTS has exactly five entries', () => {
    expect(ACCENTS.length).toBe(5);
  });
  it('MODES includes system + light + dark', () => {
    expect(new Set(MODES)).toEqual(new Set(['system', 'light', 'dark']));
  });
  it('defaults are balanced and conservative', () => {
    expect(DEFAULT_MODE).toBe('system');
    expect(DEFAULT_ACCENT).toBe('blue');
  });
});

describe('type guards', () => {
  it('isAccent accepts all known accents', () => {
    for (const a of ACCENTS) expect(isAccent(a)).toBe(true);
  });
  it('isAccent rejects others', () => {
    expect(isAccent('chartreuse')).toBe(false);
    expect(isAccent('')).toBe(false);
    expect(isAccent(null)).toBe(false);
  });
  it('isColorMode accepts the three modes', () => {
    expect(isColorMode('system')).toBe(true);
    expect(isColorMode('light')).toBe(true);
    expect(isColorMode('dark')).toBe(true);
  });
  it('isColorMode rejects others', () => {
    expect(isColorMode('auto')).toBe(false);
    expect(isColorMode(null)).toBe(false);
  });
});

describe('theme cache', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a valid theme', () => {
    cacheTheme('dark', 'red');
    expect(readCachedTheme()).toEqual({ mode: 'dark', accent: 'red' });
  });

  it('returns null when nothing is cached', () => {
    expect(readCachedTheme()).toBeNull();
  });

  it('returns null when the cached blob is malformed', () => {
    localStorage.setItem(__cacheKey, 'not|a|valid|thing');
    expect(readCachedTheme()).toBeNull();
  });

  it('returns null when only one of the two fields is valid', () => {
    localStorage.setItem(__cacheKey, 'dark|chartreuse');
    expect(readCachedTheme()).toBeNull();
  });
});
