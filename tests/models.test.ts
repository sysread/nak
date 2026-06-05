import { describe, it, expect } from 'vitest';
import {
  AGENT_MODELS,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_TIER,
  DEFAULT_VERBOSITY,
  EMBEDDING_STORAGE_DIMS,
  LEGACY_MODELS,
  MODELS,
  REASONING_EFFORTS,
  REASONING_EFFORT_LABELS,
  THINKING_LEVELS,
  THINKING_LEVEL_LABELS,
  TIERS,
  TIER_ORDER,
  VENICE_EMBEDDING_DIMS,
  VENICE_EMBEDDING_MODEL,
  VERBOSITIES,
  VERBOSITY_LABELS,
  agentModel,
  findContextWindowById,
  findModelById,
  isModelTier,
  isReasoningEffort,
  isThinkingLevel,
  isVerbosity,
  padEmbeddingForStorage,
  resolveThinking,
  resolveTier,
  resolveVerbosity,
  thinkingWireForTier,
  type AgentRole,
} from '../src/lib/models';

describe('MODELS (active registry)', () => {
  it('keys every entry by its own id', () => {
    for (const [key, spec] of Object.entries(MODELS)) {
      expect(spec.id).toBe(key);
    }
  });
  it('declares every capability flag as a boolean on every entry', () => {
    for (const spec of Object.values(MODELS)) {
      expect(typeof spec.supportsReasoning).toBe('boolean');
      expect(typeof spec.supportsVision).toBe('boolean');
      expect(typeof spec.supportsResponseFormat).toBe('boolean');
      expect(spec.contextWindow).toBeGreaterThan(0);
    }
  });
  it('records mistral-small as non-reasoning - the docblock says Venice 4xxs on the field', () => {
    expect(MODELS['mistral-small-3-2-24b-instruct'].supportsReasoning).toBe(false);
  });
  it('marks the vision-capable ids as supportsVision=true', () => {
    // Three vision-capable entries today: the analyze_image sub-call
    // (venice-uncensored-1-2) and the Smart tier's foreground model
    // (qwen-3-6-plus, which inlines image_url parts directly rather
    // than routing through analyze_image), plus the legacy
    // e2ee-qwen3-vl entry still in the registry for thread rows that
    // pinned it explicitly via per-thread model override.
    const visionIds = new Set([
      'venice-uncensored-1-2',
      'e2ee-qwen3-vl-30b-a3b-p',
      'qwen-3-6-plus',
    ]);
    for (const [id, spec] of Object.entries(MODELS)) {
      expect(spec.supportsVision).toBe(visionIds.has(id));
    }
  });
});

describe('TIERS (user-facing wrappers)', () => {
  it('has the three tiers with the expected Venice model ids', () => {
    // Smart fronts qwen-3-6-plus (1M context, native vision); Balanced
    // and Fast both front deepseek-v4-flash, differing only in their
    // default thinking level (low vs off).
    expect(TIERS.smart.id).toBe('qwen-3-6-plus');
    expect(TIERS.balanced.id).toBe('deepseek-v4-flash');
    expect(TIERS.fast.id).toBe('deepseek-v4-flash');
  });
  it('each tier wraps its corresponding MODELS entry', () => {
    for (const t of TIER_ORDER) {
      const spec = TIERS[t];
      const model = MODELS[spec.id as keyof typeof MODELS];
      expect(spec.contextWindow).toBe(model.contextWindow);
      expect(spec.supportsReasoning).toBe(model.supportsReasoning);
      expect(spec.supportsVision).toBe(model.supportsVision);
      expect(spec.supportsResponseFormat).toBe(model.supportsResponseFormat);
    }
  });
  it('differentiates the tiers by default thinking level', () => {
    // Smart defaults to 'medium' thinking, Balanced to 'low' (light
    // CoT), Fast to 'off' (none). These are defaults, not locks - the
    // composer picker stays available on all three so a user can
    // override per thread (see thinkingWireForTier tests below).
    expect(TIERS.smart.defaultThinking).toBe('medium');
    expect(TIERS.balanced.defaultThinking).toBe('low');
    expect(TIERS.fast.defaultThinking).toBe('off');
  });
  it('has matching tier/label and sensible context windows', () => {
    for (const t of TIER_ORDER) {
      expect(TIERS[t].tier).toBe(t);
      expect(TIERS[t].label.length).toBeGreaterThan(0);
      expect(TIERS[t].contextWindow).toBeGreaterThan(0);
    }
    // Fast fronts deepseek-v4-flash, which carries a 1M-token window
    // inherited via the spread.
    expect(TIERS.fast.contextWindow).toBe(1_000_000);
  });
});

describe('AGENT_MODELS (background agents)', () => {
  it('every agent role points at a registered model id', () => {
    for (const [role, modelId] of Object.entries(AGENT_MODELS) as Array<[AgentRole, string]>) {
      expect(MODELS).toHaveProperty(modelId);
      expect(agentModel(role).id).toBe(modelId);
    }
  });
  it('groups roles by model id as expected', () => {
    // Deepseek slots: reflection, web search, research docs, and the
    // three recall agents (memory, conversation, wiki). The recall
    // trio rides the foreground capacity pool because grounded recall
    // is fabrication-sensitive under json_object pressure - see the
    // per-slot rationale block in src/lib/models/index.ts.
    expect(AGENT_MODELS.reflection).toBe('deepseek-v4-flash');
    expect(AGENT_MODELS.webSearch).toBe('deepseek-v4-flash');
    expect(AGENT_MODELS.researchDocs).toBe('deepseek-v4-flash');
    expect(AGENT_MODELS.recall).toBe('deepseek-v4-flash');
    expect(AGENT_MODELS.conversationRecall).toBe('deepseek-v4-flash');
    expect(AGENT_MODELS.wikiRecall).toBe('deepseek-v4-flash');
    // Three mistral-small slots: intuition, summary, samskara.
    expect(AGENT_MODELS.intuition).toBe('mistral-small-3-2-24b-instruct');
    expect(AGENT_MODELS.summary).toBe('mistral-small-3-2-24b-instruct');
    expect(AGENT_MODELS.samskara).toBe('mistral-small-3-2-24b-instruct');
    // Vision sub-call.
    expect(AGENT_MODELS.visionAnalysis).toBe('venice-uncensored-1-2');
    // Auto-title: Chat.svelte's parallel background completion that
    // names a fresh thread before the main reply finishes streaming.
    expect(AGENT_MODELS.autoTitle).toBe('e2ee-gpt-oss-20b-p');
  });
});

describe('DEFAULT_TIER', () => {
  it('default is balanced', () => {
    expect(DEFAULT_TIER).toBe('balanced');
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
  it('resolveThinking prefers thread override over every default', () => {
    expect(resolveThinking('high', 'low')).toBe('high');
    expect(resolveThinking('high', 'low', 'medium')).toBe('high');
    // A per-thread 'off' override wins even when the tier default would
    // have turned thinking on.
    expect(resolveThinking('off', 'low', 'medium')).toBe('off');
  });

  it('resolveThinking prefers tier default over user default', () => {
    // Tier-level default (Smart: 'medium', Balanced/Fast: 'off') has to
    // win over the account default so the tiers feel different when the
    // user hasn't set a per-thread level.
    expect(resolveThinking(null, 'medium', 'high')).toBe('high');
    expect(resolveThinking(null, 'low', 'off')).toBe('off');
  });

  it('resolveThinking falls through to user default when no tier default is set', () => {
    expect(resolveThinking(null, 'medium')).toBe('medium');
    expect(resolveThinking(null, 'medium', undefined)).toBe('medium');
    expect(resolveThinking(null, 'medium', null)).toBe('medium');
  });
});

describe('thinking level (composer picker domain)', () => {
  it('exposes off + the three effort levels in picker order', () => {
    expect(THINKING_LEVELS).toEqual(['off', 'low', 'medium', 'high']);
  });
  it('has a human-readable label for every level', () => {
    for (const l of THINKING_LEVELS) {
      expect(THINKING_LEVEL_LABELS[l]).toMatch(/^[A-Z]/);
    }
    expect(THINKING_LEVEL_LABELS.off).toBe('Off');
  });
  it('isThinkingLevel accepts off plus the three levels and rejects the rest', () => {
    expect(isThinkingLevel('off')).toBe(true);
    expect(isThinkingLevel('low')).toBe(true);
    expect(isThinkingLevel('high')).toBe(true);
    expect(isThinkingLevel('none')).toBe(false);
    expect(isThinkingLevel('OFF')).toBe(false);
    expect(isThinkingLevel(null)).toBe(false);
    expect(isThinkingLevel(undefined)).toBe(false);
  });
  it('thinkingWireForTier maps off -> disable_thinking and levels -> reasoning_effort', () => {
    // Smart defaults to 'medium', Balanced to 'low' - both thinking-on,
    // so they forward reasoning_effort.
    expect(thinkingWireForTier(TIERS.smart, null, 'medium')).toEqual({
      reasoningEffort: 'medium',
      disableThinking: false,
    });
    expect(thinkingWireForTier(TIERS.balanced, null, 'medium')).toEqual({
      reasoningEffort: 'low',
      disableThinking: false,
    });
    // Fast defaults to 'off' -> the off-switch, no reasoning_effort.
    expect(thinkingWireForTier(TIERS.fast, null, 'medium')).toEqual({
      disableThinking: true,
    });
    // A per-thread 'off' beats a thinking-on tier default.
    expect(thinkingWireForTier(TIERS.balanced, 'off', 'medium')).toEqual({
      disableThinking: true,
    });
    // And a per-thread level beats the tier's off default (user turned
    // thinking back on for this one conversation on Fast).
    expect(thinkingWireForTier(TIERS.fast, 'high', 'medium')).toEqual({
      reasoningEffort: 'high',
      disableThinking: false,
    });
  });
});

describe('verbosity', () => {
  it('exposes the three OpenAI-style levels', () => {
    expect(VERBOSITIES).toEqual(['low', 'medium', 'high']);
  });
  it('defaults to medium (neutral; neither terse nor verbose by fiat)', () => {
    expect(DEFAULT_VERBOSITY).toBe('medium');
  });
  it('has a human-readable label for every level', () => {
    for (const v of VERBOSITIES) {
      expect(VERBOSITY_LABELS[v]).toMatch(/^[A-Z]/);
    }
  });
  it('isVerbosity accepts the three levels and rejects the rest', () => {
    expect(isVerbosity('low')).toBe(true);
    expect(isVerbosity('medium')).toBe(true);
    expect(isVerbosity('high')).toBe(true);
    expect(isVerbosity('extreme')).toBe(false);
    expect(isVerbosity('LOW')).toBe(false);
    expect(isVerbosity(null)).toBe(false);
    expect(isVerbosity(undefined)).toBe(false);
    expect(isVerbosity(1)).toBe(false);
  });
  it('resolveVerbosity prefers thread override over default', () => {
    expect(resolveVerbosity('high', 'low')).toBe('high');
    expect(resolveVerbosity(null, 'medium')).toBe('medium');
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
    // move together - the test exists so the swap isn't silent.
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
    for (let i = 0; i < VENICE_EMBEDDING_DIMS; i++) {
      expect(padded[i]).toBe(input[i]);
    }
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

  it('throws when the input is longer than storage dim - this is a config bug, not silent truncation', () => {
    const tooLong = new Array<number>(EMBEDDING_STORAGE_DIMS + 1).fill(0);
    expect(() => padEmbeddingForStorage(tooLong)).toThrow(/exceeds storage dim/);
  });

  it('is cosine-invariant (dot product of padded vectors equals dot product of originals)', () => {
    const a = Array.from({ length: VENICE_EMBEDDING_DIMS }, (_, i) => Math.sin(i));
    const b = Array.from({ length: VENICE_EMBEDDING_DIMS }, (_, i) => Math.cos(i));
    const dot = (x: number[], y: number[]) =>
      x.reduce((sum, v, i) => sum + v * y[i], 0);
    const original = dot(a, b);
    const padded = dot(padEmbeddingForStorage(a), padEmbeddingForStorage(b));
    expect(padded).toBeCloseTo(original, 10);
  });
});

describe('findModelById', () => {
  it('returns the spec for currently-active ids', () => {
    expect(findModelById('deepseek-v4-flash')).toBe(MODELS['deepseek-v4-flash']);
    expect(findModelById('qwen-3-6-plus')).toBe(MODELS['qwen-3-6-plus']);
    expect(findModelById('mistral-small-3-2-24b-instruct')).toBe(
      MODELS['mistral-small-3-2-24b-instruct']
    );
  });
  it('returns null for retired ids - retired specs do not carry the same shape', () => {
    expect(findModelById('arcee-trinity-large-thinking')).toBeNull();
    expect(findModelById('grok-41-fast')).toBeNull();
    expect(findModelById('kimi-k2-5')).toBeNull();
    expect(findModelById('zai-org-glm-5-1')).toBeNull();
    expect(findModelById('deepseek-v4-pro')).toBeNull();
    expect(findModelById('qwen3-5-35b-a3b')).toBeNull();
  });
  it('returns null for unknown / empty inputs', () => {
    expect(findModelById('never-existed')).toBeNull();
    expect(findModelById(null)).toBeNull();
    expect(findModelById(undefined)).toBeNull();
    expect(findModelById('')).toBeNull();
  });
});

describe('findContextWindowById', () => {
  it('returns the window for a currently-active id', () => {
    expect(findContextWindowById('deepseek-v4-flash')).toBe(MODELS['deepseek-v4-flash'].contextWindow);
    expect(findContextWindowById('qwen-3-6-plus')).toBe(MODELS['qwen-3-6-plus'].contextWindow);
  });

  // Historical assistant rows carry ids that used to front a tier - if
  // the legacy fallback breaks, every pre-swap message silently loses
  // its context-ring indicator. Pin every retired id so each swap
  // generation stays readable.
  it('falls back to LEGACY_MODELS for retired ids', () => {
    expect(findContextWindowById('arcee-trinity-large-thinking')).toBe(256_000);
    expect(findContextWindowById('gemma-4-uncensored')).toBe(256_000);
    expect(findContextWindowById('kimi-k2-5')).toBe(256_000);
    expect(findContextWindowById('kimi-k2-6')).toBe(256_000);
    expect(findContextWindowById('minimax-m27')).toBe(198_000);
    expect(findContextWindowById('grok-41-fast')).toBe(1_000_000);
    expect(findContextWindowById('zai-org-glm-5-1')).toBe(200_000);
    expect(findContextWindowById('qwen3-5-35b-a3b')).toBe(256_000);
    expect(findContextWindowById('zai-org-glm-5')).toBe(198_000);
    expect(findContextWindowById('zai-org-glm-4.7')).toBe(198_000);
    expect(findContextWindowById('deepseek-v4-pro')).toBe(1_000_000);
  });

  it('returns null for an unknown id and for null/empty input', () => {
    expect(findContextWindowById('never-existed')).toBeNull();
    expect(findContextWindowById(null)).toBeNull();
    expect(findContextWindowById(undefined)).toBeNull();
    expect(findContextWindowById('')).toBeNull();
  });
});

describe('LEGACY_MODELS', () => {
  it('keys every entry by its own id', () => {
    for (const [key, spec] of Object.entries(LEGACY_MODELS)) {
      expect(spec.id).toBe(key);
    }
  });
  it('declares a positive context window on every entry', () => {
    for (const spec of Object.values(LEGACY_MODELS)) {
      expect(spec.contextWindow).toBeGreaterThan(0);
    }
  });
  it('does not overlap with active MODELS', () => {
    for (const id of Object.keys(LEGACY_MODELS)) {
      expect(MODELS).not.toHaveProperty(id);
    }
  });
});
