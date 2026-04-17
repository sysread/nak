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
});
