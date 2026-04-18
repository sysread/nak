import { describe, it, expect } from 'vitest';
import { coerceSettings } from '../src/lib/supabase';

describe('coerceSettings', () => {
  it('returns an empty object for non-object input', () => {
    expect(coerceSettings(null)).toEqual({});
    expect(coerceSettings(undefined)).toEqual({});
    expect(coerceSettings('smart')).toEqual({});
    expect(coerceSettings(42)).toEqual({});
  });

  it('passes through a valid defaultModel tier', () => {
    expect(coerceSettings({ defaultModel: 'smart' })).toEqual({ defaultModel: 'smart' });
    expect(coerceSettings({ defaultModel: 'balanced' })).toEqual({ defaultModel: 'balanced' });
    expect(coerceSettings({ defaultModel: 'fast' })).toEqual({ defaultModel: 'fast' });
  });

  it('drops an unknown defaultModel value', () => {
    expect(coerceSettings({ defaultModel: 'wizard' })).toEqual({});
    expect(coerceSettings({ defaultModel: '' })).toEqual({});
    expect(coerceSettings({ defaultModel: 123 })).toEqual({});
  });

  it('drops unknown keys silently', () => {
    expect(coerceSettings({ rando: 'value', defaultModel: 'fast' })).toEqual({
      defaultModel: 'fast',
    });
    expect(coerceSettings({ rando: 'value' })).toEqual({});
  });

  it('tolerates an empty object', () => {
    expect(coerceSettings({})).toEqual({});
  });

  it('passes through valid theme fields', () => {
    expect(coerceSettings({ colorMode: 'light', accent: 'teal' })).toEqual({
      colorMode: 'light',
      accent: 'teal',
    });
    expect(coerceSettings({ colorMode: 'system' })).toEqual({ colorMode: 'system' });
  });

  it('drops bad theme values', () => {
    expect(coerceSettings({ colorMode: 'neon', accent: 'chartreuse' })).toEqual({});
    expect(coerceSettings({ colorMode: null, accent: 123 })).toEqual({});
  });

  it('mixes model + theme fields correctly', () => {
    expect(
      coerceSettings({ defaultModel: 'smart', colorMode: 'dark', accent: 'pink' })
    ).toEqual({ defaultModel: 'smart', colorMode: 'dark', accent: 'pink' });
  });

  it('passes through well-formed systemPrompts', () => {
    const prompts = [
      { id: 'a', name: 'Rude reviewer', body: 'Be curt.', enabledByDefault: true },
      { id: 'b', name: 'Haiku', body: 'Reply in haiku.', enabledByDefault: false },
    ];
    expect(coerceSettings({ systemPrompts: prompts })).toEqual({ systemPrompts: prompts });
  });

  it('drops malformed systemPrompts entries without dropping the valid ones', () => {
    const result = coerceSettings({
      systemPrompts: [
        { id: 'good', name: 'Ok', body: 'ok', enabledByDefault: true },
        { id: '', name: 'missing id', body: 'x', enabledByDefault: false },
        { name: 'no id', body: 'x', enabledByDefault: false },
        { id: 'bad', name: null, body: 'x', enabledByDefault: false },
        'not an object',
        42,
      ],
    });
    expect(result.systemPrompts).toEqual([
      { id: 'good', name: 'Ok', body: 'ok', enabledByDefault: true },
    ]);
  });

  it('coerces enabledByDefault to strict true (truthy strings stay false)', () => {
    const result = coerceSettings({
      systemPrompts: [
        { id: 'a', name: 'a', body: '', enabledByDefault: 'yes' },
        { id: 'b', name: 'b', body: '', enabledByDefault: true },
      ],
    });
    expect(result.systemPrompts).toEqual([
      { id: 'a', name: 'a', body: '', enabledByDefault: false },
      { id: 'b', name: 'b', body: '', enabledByDefault: true },
    ]);
  });

  it('omits systemPrompts when the input array is empty or all-invalid', () => {
    expect(coerceSettings({ systemPrompts: [] }).systemPrompts).toBeUndefined();
    expect(
      coerceSettings({ systemPrompts: ['nope', 123, null] }).systemPrompts
    ).toBeUndefined();
  });

  it('preserves webSearchEnabled only for strict booleans', () => {
    expect(coerceSettings({ webSearchEnabled: true }).webSearchEnabled).toBe(true);
    expect(coerceSettings({ webSearchEnabled: false }).webSearchEnabled).toBe(false);
    // Truthy non-boolean: dropped so the caller-side default stays in charge.
    expect(coerceSettings({ webSearchEnabled: 'yes' }).webSearchEnabled).toBeUndefined();
    expect(coerceSettings({ webSearchEnabled: 1 }).webSearchEnabled).toBeUndefined();
    // Missing key is an absent opt-out signal — treated as "use the default".
    expect(coerceSettings({}).webSearchEnabled).toBeUndefined();
  });
});
