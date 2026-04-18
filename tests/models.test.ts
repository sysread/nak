import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REASONING_EFFORT,
  DEFAULT_TIER,
  MODELS,
  REASONING_EFFORTS,
  REASONING_EFFORT_LABELS,
  TIERS,
  UTILITY_TIER,
  isModelTier,
  isReasoningEffort,
  resolveReasoningEffort,
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

describe('reasoning effort', () => {
  it('exposes the three OpenAI-style levels', () => {
    expect(REASONING_EFFORTS).toEqual(['low', 'medium', 'high']);
  });
  it('defaults to low (keeps turn latency in the chat-turn ballpark)', () => {
    expect(DEFAULT_REASONING_EFFORT).toBe('low');
  });
  it('has a human-readable label for every level', () => {
    for (const e of REASONING_EFFORTS) {
      expect(REASONING_EFFORT_LABELS[e]).toMatch(/^[A-Z]/);
    }
  });
  it('isReasoningEffort accepts the three levels and rejects the rest', () => {
    expect(isReasoningEffort('low')).toBe(true);
    expect(isReasoningEffort('medium')).toBe(true);
    expect(isReasoningEffort('high')).toBe(true);
    expect(isReasoningEffort('extreme')).toBe(false);
    expect(isReasoningEffort('LOW')).toBe(false);
    expect(isReasoningEffort(null)).toBe(false);
    expect(isReasoningEffort(undefined)).toBe(false);
    expect(isReasoningEffort(1)).toBe(false);
  });
  it('every MODELS entry declares supportsReasoning', () => {
    for (const t of TIERS) {
      expect(typeof MODELS[t].supportsReasoning).toBe('boolean');
    }
  });
  it('resolveReasoningEffort prefers thread override over default', () => {
    expect(resolveReasoningEffort('high', 'low')).toBe('high');
    expect(resolveReasoningEffort(null, 'medium')).toBe('medium');
  });
});
