import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REASONING_EFFORT,
  DEFAULT_TIER,
  MODELS,
  REASONING_EFFORTS,
  REASONING_EFFORT_LABELS,
  TIERS,
  UTILITY_TIER,
  VENICE_EMBEDDING_MODEL,
  VENICE_EMBEDDING_DIMS,
  EMBEDDING_STORAGE_DIMS,
  findContextWindowById,
  findModelById,
  padEmbeddingForStorage,
  isModelTier,
  isReasoningEffort,
  resolveReasoningEffort,
  resolveTier,
} from '../src/lib/models';

describe('MODELS', () => {
  it('has the three tiers with the expected Venice model ids', () => {
    expect(MODELS.smart.id).toBe('kimi-k2-5');
    expect(MODELS.balanced.id).toBe('gemma-4-uncensored');
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

describe('embedding constants', () => {
  it('stores the Venice embeddings model id', () => {
    expect(VENICE_EMBEDDING_MODEL).toBe('text-embedding-bge-m3');
  });
  it('has storage dim > native dim so padding always has room', () => {
    expect(EMBEDDING_STORAGE_DIMS).toBeGreaterThanOrEqual(VENICE_EMBEDDING_DIMS);
  });
  it('native dim matches bge-m3 (1024)', () => {
    // If Venice ever swaps the model, this constant and the schema must
    // move together — the test exists so the swap isn't silent.
    expect(VENICE_EMBEDDING_DIMS).toBe(1024);
  });
  it('storage dim matches the column in supabase/schema.sql (2048)', () => {
    expect(EMBEDDING_STORAGE_DIMS).toBe(2048);
  });
});

describe('padEmbeddingForStorage', () => {
  it('pads a native-length vector to storage length with zeros', () => {
    const input = Array.from({ length: VENICE_EMBEDDING_DIMS }, (_, i) => i * 0.001);
    const padded = padEmbeddingForStorage(input);
    expect(padded).toHaveLength(EMBEDDING_STORAGE_DIMS);
    // Prefix is preserved exactly.
    for (let i = 0; i < VENICE_EMBEDDING_DIMS; i++) {
      expect(padded[i]).toBe(input[i]);
    }
    // Suffix is all zeros — the invariant that makes cosine similarity
    // equal between padded and unpadded vectors.
    for (let i = VENICE_EMBEDDING_DIMS; i < EMBEDDING_STORAGE_DIMS; i++) {
      expect(padded[i]).toBe(0);
    }
  });

  it('returns a copy on the fast path so callers cannot mutate the caller buffer', () => {
    const input = new Array<number>(EMBEDDING_STORAGE_DIMS).fill(0.5);
    const padded = padEmbeddingForStorage(input);
    expect(padded).not.toBe(input);
    expect(padded).toEqual(input);
  });

  it('handles a zero-length input (edge case: null embedding)', () => {
    const padded = padEmbeddingForStorage([]);
    expect(padded).toHaveLength(EMBEDDING_STORAGE_DIMS);
    expect(padded.every((v) => v === 0)).toBe(true);
  });

  it('handles an arbitrary length shorter than storage', () => {
    const input = [1, 2, 3, 4];
    const padded = padEmbeddingForStorage(input);
    expect(padded).toHaveLength(EMBEDDING_STORAGE_DIMS);
    expect(padded.slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(padded.slice(4).every((v) => v === 0)).toBe(true);
  });

  it('throws when the input is longer than storage dim — this is a config bug, not silent truncation', () => {
    const tooLong = new Array<number>(EMBEDDING_STORAGE_DIMS + 1).fill(0);
    expect(() => padEmbeddingForStorage(tooLong)).toThrow(/exceeds storage dim/);
  });

  it('is cosine-invariant (dot product of padded vectors equals dot product of originals)', () => {
    const a = Array.from({ length: VENICE_EMBEDDING_DIMS }, (_, i) => Math.sin(i));
    const b = Array.from({ length: VENICE_EMBEDDING_DIMS }, (_, i) => Math.cos(i));
    const aDot = (x: number[], y: number[]) =>
      x.reduce((sum, v, i) => sum + v * y[i], 0);
    const original = aDot(a, b);
    const padded = aDot(padEmbeddingForStorage(a), padEmbeddingForStorage(b));
    expect(padded).toBeCloseTo(original, 10);
  });
});

describe('findContextWindowById', () => {
  it('returns the window for a currently-fronted model id', () => {
    expect(findContextWindowById('gemma-4-uncensored')).toBe(
      MODELS.balanced.contextWindow
    );
    expect(findContextWindowById('kimi-k2-5')).toBe(MODELS.smart.contextWindow);
  });

  // Historical assistant rows carry ids that used to front a tier — if
  // the fallback breaks, every pre-swap message silently loses its
  // context-ring indicator. Pin the trinity window here because that's
  // the concrete regression that motivated the retired-models map.
  it('returns the pinned window for a retired model id', () => {
    expect(findModelById('arcee-trinity-large-thinking')).toBeNull();
    expect(findContextWindowById('arcee-trinity-large-thinking')).toBe(256_000);
  });

  it('returns null for an unknown id and for null/empty input', () => {
    expect(findContextWindowById('never-existed')).toBeNull();
    expect(findContextWindowById(null)).toBeNull();
    expect(findContextWindowById(undefined)).toBeNull();
    expect(findContextWindowById('')).toBeNull();
  });
});
