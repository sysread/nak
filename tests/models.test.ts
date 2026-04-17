import { describe, it, expect } from 'vitest';
import {
  MODELS,
  TIERS,
  DEFAULT_TIER,
  UTILITY_TIER,
  isModelTier,
  resolveTier,
} from '../src/lib/models';

describe('MODELS', () => {
  it('has the three tiers with the expected Venice model ids', () => {
    expect(MODELS.smart.id).toBe('kimi-k2-5');
    expect(MODELS.balanced.id).toBe('arcee-trinity-large-thinking');
    expect(MODELS.fast.id).toBe('grok-41-fast');
  });
  it('has matching tier/label and sensible context windows', () => {
    for (const t of TIERS) {
      expect(MODELS[t].tier).toBe(t);
      expect(MODELS[t].label.length).toBeGreaterThan(0);
      expect(MODELS[t].contextWindow).toBeGreaterThan(0);
    }
    // fast is documented as ~1M-token context.
    expect(MODELS.fast.contextWindow).toBeGreaterThanOrEqual(1_000_000);
  });
});

describe('DEFAULT_TIER / UTILITY_TIER', () => {
  it('default is balanced', () => {
    expect(DEFAULT_TIER).toBe('balanced');
  });
  it('utility is fast (used for auto-titling)', () => {
    expect(UTILITY_TIER).toBe('fast');
  });
});

describe('isModelTier', () => {
  it('accepts the three tier names', () => {
    expect(isModelTier('smart')).toBe(true);
    expect(isModelTier('balanced')).toBe(true);
    expect(isModelTier('fast')).toBe(true);
  });
  it('rejects anything else', () => {
    expect(isModelTier('')).toBe(false);
    expect(isModelTier('SMART')).toBe(false);
    expect(isModelTier(null)).toBe(false);
    expect(isModelTier(undefined)).toBe(false);
    expect(isModelTier(42)).toBe(false);
    expect(isModelTier({ tier: 'smart' })).toBe(false);
  });
});

describe('resolveTier', () => {
  it('returns the thread override when set', () => {
    expect(resolveTier('smart', 'fast')).toBe('smart');
  });
  it('falls back to the default when no override', () => {
    expect(resolveTier(null, 'fast')).toBe('fast');
  });
});
