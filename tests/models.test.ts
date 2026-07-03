import { describe, it, expect } from 'vitest';
import {
  AGENT_MODELS,
  EMBEDDING_STORAGE_DIMS,
  MODELS,
  SEED_MODEL_PROFILE_ID,
  THINKING_LEVELS,
  THINKING_LEVEL_LABELS,
  VENICE_EMBEDDING_DIMS,
  VENICE_EMBEDDING_MODEL,
  VERBOSITIES,
  VERBOSITY_LABELS,
  agentModel,
  coerceModelProfile,
  coerceModelProfiles,
  defaultModelProfile,
  isThinkingLevel,
  isVerbosity,
  normalizeDefaultProfile,
  padEmbeddingForStorage,
  profileModelSpec,
  resolveModelProfile,
  seedModelProfiles,
  thinkingWireForProfile,
  type AgentRole,
  type ModelProfile,
} from '../src/lib/models';

const SAMPLE_PROFILE: ModelProfile = {
  id: 'profile-1',
  name: 'Deep work',
  modelId: 'some-new-model',
  thinking: 'high',
  verbosity: 'medium',
  isDefault: false,
  contextWindow: 512_000,
  supportsReasoning: true,
  supportsVision: false,
  supportsResponseFormat: true,
  modelLabel: 'Some New Model',
};

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
    // Vision-capable entries today: analyze_image's server-side vision
    // sub-call primary (e2ee-qwen3-vl-30b-a3b-p) and its uncensored
    // fallback (venice-uncensored-1-2), plus qwen-3-7-plus (which
    // inlines image_url parts directly rather than routing through
    // analyze_image). The seed profile's deepseek-v4-flash is text-only
    // - vision goes through analyze_image.
    const visionIds = new Set([
      'venice-uncensored-1-2',
      'e2ee-qwen3-vl-30b-a3b-p',
      'qwen-3-7-plus',
    ]);
    for (const [id, spec] of Object.entries(MODELS)) {
      expect(spec.supportsVision).toBe(visionIds.has(id));
    }
  });
});

describe('seedModelProfiles', () => {
  it('is a single "Default" profile on deepseek-v4-flash, medium reasoning, low verbosity', () => {
    const seed = seedModelProfiles();
    expect(seed).toHaveLength(1);
    const p = seed[0];
    expect(p.id).toBe(SEED_MODEL_PROFILE_ID);
    expect(p.name).toBe('Default');
    expect(p.modelId).toBe('deepseek-v4-flash');
    expect(p.thinking).toBe('medium');
    expect(p.verbosity).toBe('low');
    expect(p.isDefault).toBe(true);
  });
  it('carries the curated capability snapshot of its backing model', () => {
    const p = seedModelProfiles()[0];
    const spec = MODELS['deepseek-v4-flash'];
    expect(p.contextWindow).toBe(spec.contextWindow);
    expect(p.supportsReasoning).toBe(spec.supportsReasoning);
    expect(p.supportsVision).toBe(spec.supportsVision);
    expect(p.supportsResponseFormat).toBe(spec.supportsResponseFormat);
  });
  it('returns a fresh array per call so callers can mutate safely', () => {
    const a = seedModelProfiles();
    const b = seedModelProfiles();
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
    expect(a).toEqual(b);
  });
});

describe('coerceModelProfile', () => {
  it('accepts a well-formed profile', () => {
    expect(coerceModelProfile(SAMPLE_PROFILE)).toEqual(SAMPLE_PROFILE);
  });
  it('falls back modelLabel to the model id when absent', () => {
    const noLabel: Record<string, unknown> = { ...SAMPLE_PROFILE };
    delete noLabel.modelLabel;
    expect(coerceModelProfile(noLabel)?.modelLabel).toBe(SAMPLE_PROFILE.modelId);
  });
  it('treats a missing isDefault as false', () => {
    const noFlag: Record<string, unknown> = { ...SAMPLE_PROFILE };
    delete noFlag.isDefault;
    expect(coerceModelProfile(noFlag)?.isDefault).toBe(false);
  });
  it('rejects a missing id, blank name, or missing modelId', () => {
    expect(coerceModelProfile({ ...SAMPLE_PROFILE, id: '' })).toBeNull();
    expect(coerceModelProfile({ ...SAMPLE_PROFILE, name: '   ' })).toBeNull();
    expect(coerceModelProfile({ ...SAMPLE_PROFILE, modelId: '' })).toBeNull();
  });
  it('rejects invalid thinking / verbosity values', () => {
    expect(coerceModelProfile({ ...SAMPLE_PROFILE, thinking: 'extreme' })).toBeNull();
    expect(coerceModelProfile({ ...SAMPLE_PROFILE, verbosity: 'chatty' })).toBeNull();
  });
  it('rejects a non-numeric context window and non-boolean capability flags', () => {
    expect(coerceModelProfile({ ...SAMPLE_PROFILE, contextWindow: 'big' })).toBeNull();
    expect(coerceModelProfile({ ...SAMPLE_PROFILE, supportsVision: 'yes' })).toBeNull();
  });
  it('rejects non-objects', () => {
    expect(coerceModelProfile(null)).toBeNull();
    expect(coerceModelProfile('nope')).toBeNull();
  });
});

describe('coerceModelProfiles', () => {
  it('keeps well-formed entries and drops malformed ones', () => {
    const result = coerceModelProfiles([
      { ...SAMPLE_PROFILE, isDefault: true },
      { ...SAMPLE_PROFILE, id: 'profile-2', name: 'Broken', thinking: 'bogus' },
      { ...SAMPLE_PROFILE, id: 'profile-3', name: 'Fast replies' },
    ]);
    expect(result?.map((p) => p.id)).toEqual(['profile-1', 'profile-3']);
  });
  it('drops duplicate ids, first occurrence wins', () => {
    const result = coerceModelProfiles([
      { ...SAMPLE_PROFILE, name: 'First' },
      { ...SAMPLE_PROFILE, name: 'Second' },
    ]);
    expect(result).toHaveLength(1);
    expect(result?.[0].name).toBe('First');
  });
  it('normalizes to exactly one default - none flagged promotes the first', () => {
    const result = coerceModelProfiles([
      SAMPLE_PROFILE,
      { ...SAMPLE_PROFILE, id: 'profile-2', name: 'Other' },
    ]);
    expect(result?.map((p) => p.isDefault)).toEqual([true, false]);
  });
  it('normalizes to exactly one default - extras are cleared, first flagged wins', () => {
    const result = coerceModelProfiles([
      SAMPLE_PROFILE,
      { ...SAMPLE_PROFILE, id: 'profile-2', name: 'B', isDefault: true },
      { ...SAMPLE_PROFILE, id: 'profile-3', name: 'C', isDefault: true },
    ]);
    expect(result?.map((p) => p.isDefault)).toEqual([false, true, false]);
  });
  it('returns undefined when nothing survives', () => {
    expect(coerceModelProfiles([])).toBeUndefined();
    expect(coerceModelProfiles([{ id: '' }])).toBeUndefined();
    expect(coerceModelProfiles(null)).toBeUndefined();
    expect(coerceModelProfiles({})).toBeUndefined();
  });
});

describe('normalizeDefaultProfile', () => {
  it('passes an already-normal list through with identities intact', () => {
    const list = [
      { ...SAMPLE_PROFILE, isDefault: true },
      { ...SAMPLE_PROFILE, id: 'profile-2', name: 'Other' },
    ];
    const result = normalizeDefaultProfile(list);
    expect(result[0]).toBe(list[0]);
    expect(result[1]).toBe(list[1]);
  });
  it('returns empty for empty input', () => {
    expect(normalizeDefaultProfile([])).toEqual([]);
  });
});

describe('defaultModelProfile / resolveModelProfile', () => {
  const profiles: ModelProfile[] = [
    SAMPLE_PROFILE,
    { ...SAMPLE_PROFILE, id: 'profile-2', name: 'Everyday', isDefault: true },
  ];
  it('defaultModelProfile returns the flagged profile', () => {
    expect(defaultModelProfile(profiles).id).toBe('profile-2');
  });
  it('defaultModelProfile falls back to the first when nothing is flagged', () => {
    expect(defaultModelProfile([SAMPLE_PROFILE]).id).toBe('profile-1');
  });
  it('defaultModelProfile stays total on an empty list via the seed', () => {
    expect(defaultModelProfile([]).id).toBe(SEED_MODEL_PROFILE_ID);
  });
  it('resolveModelProfile honors a live per-thread pin', () => {
    expect(resolveModelProfile(profiles, 'profile-1').id).toBe('profile-1');
  });
  it('resolveModelProfile falls back to the default for null', () => {
    expect(resolveModelProfile(profiles, null).id).toBe('profile-2');
  });
  it('resolveModelProfile falls back to the default for deleted / legacy ids', () => {
    // A profile the user deleted...
    expect(resolveModelProfile(profiles, 'gone-profile').id).toBe('profile-2');
    // ...and a legacy pre-profile tier name still stored on old rows.
    expect(resolveModelProfile(profiles, 'balanced').id).toBe('profile-2');
  });
});

describe('profileModelSpec', () => {
  it('projects the capability snapshot with the Venice id as the spec id', () => {
    expect(profileModelSpec(SAMPLE_PROFILE)).toEqual({
      id: 'some-new-model',
      contextWindow: 512_000,
      supportsReasoning: true,
      supportsVision: false,
      supportsResponseFormat: true,
    });
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
    // Deepseek backs every slot except the two latency-bound,
    // non-reasoning sub-calls: web search (mistral-small) and intuition
    // (nemotron-nano). See the per-slot rationale block in
    // src/lib/models/index.ts.
    expect(AGENT_MODELS.reflection).toBe('deepseek-v4-flash');
    expect(AGENT_MODELS.wiki).toBe('deepseek-v4-flash');
    expect(AGENT_MODELS.wikiLibrarian).toBe('deepseek-v4-flash');
    expect(AGENT_MODELS.deepSleep).toBe('deepseek-v4-flash');
    expect(AGENT_MODELS.rem).toBe('deepseek-v4-flash');
    expect(AGENT_MODELS.researchDocs).toBe('deepseek-v4-flash');
    expect(AGENT_MODELS.recall).toBe('deepseek-v4-flash');
    expect(AGENT_MODELS.conversationRecall).toBe('deepseek-v4-flash');
    expect(AGENT_MODELS.wikiRecall).toBe('deepseek-v4-flash');
    // Web search and intuition are both latency-bound sub-calls that
    // pin disable_thinking, and both want a NON-reasoning model (no CoT
    // pass to burn the budget). Web search is on mistral-small, a
    // faithful summariser - faithfulness is the priority where it
    // synthesises live results. Intuition is on nemotron-nano (30B MoE,
    // 3B active), the fastest non-reasoning id, since the pre-turn pulse
    // is a primal-drive gut read awaited on the turn's critical path.
    // Distinct ids from the deepseek-backed agents so they retune
    // independently. (The bias and samskara agents also run
    // mistral-small, but server-side - see BIAS_MODEL and SAMSKARA_MODEL
    // under supabase/functions/venice/agents/.)
    expect(AGENT_MODELS.webSearch).toBe('mistral-small-3-2-24b-instruct');
    expect(AGENT_MODELS.intuition).toBe('nvidia-nemotron-3-nano-30b-a3b');
    // No vision slot here: analyze_image's vision sub-call runs
    // server-side in the venice edge function, which holds the primary
    // (e2ee-qwen3-vl-30b-a3b-p) and uncensored-fallback
    // (venice-uncensored-1-2) ids directly - AGENT_MODELS is the
    // browser-side agent registry and doesn't drive it. The five
    // curation agents (auto-title, summary, thread/memory/recipe
    // topics) are likewise absent: they run server-side in the venice
    // edge function, which holds their model ids directly.
  });
});

describe('thinking level (reasoning picker domain)', () => {
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
  it('thinkingWireForProfile maps off -> disable_thinking and levels -> reasoning_effort', () => {
    // No thread override: the profile default applies.
    expect(thinkingWireForProfile(SAMPLE_PROFILE, null)).toEqual({
      reasoningEffort: 'high',
      disableThinking: false,
    });
    // A thinking-off profile default resolves to the off switch, no
    // reasoning_effort.
    expect(
      thinkingWireForProfile({ ...SAMPLE_PROFILE, thinking: 'off' }, null)
    ).toEqual({ disableThinking: true });
    // A per-thread 'off' beats a thinking-on profile default.
    expect(thinkingWireForProfile(SAMPLE_PROFILE, 'off')).toEqual({
      disableThinking: true,
    });
    // And a per-thread level beats the profile's off default (user
    // turned thinking back on for this one conversation).
    expect(
      thinkingWireForProfile({ ...SAMPLE_PROFILE, thinking: 'off' }, 'medium')
    ).toEqual({ reasoningEffort: 'medium', disableThinking: false });
  });
  it('thinkingWireForProfile sends neither knob on a non-reasoning model', () => {
    const nonReasoning = { ...SAMPLE_PROFILE, supportsReasoning: false };
    expect(thinkingWireForProfile(nonReasoning, 'high')).toEqual({
      disableThinking: false,
    });
  });
});

describe('verbosity', () => {
  it('exposes the three OpenAI-style levels', () => {
    expect(VERBOSITIES).toEqual(['low', 'medium', 'high']);
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
