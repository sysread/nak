import { describe, it, expect } from 'vitest';
import { coerceCatalog, type CatalogModel } from '../src/lib/models/catalog';
import {
  buildModelOptions,
  capabilityChips,
  filterModelOptions,
  formatContextWindow,
  formatPricing,
  fuzzyMatch,
  priceCapHiddenNote,
} from '../src/lib/ui/model-picker';

// One raw /models entry in Venice's nested shape, for the coercer tests.
function rawEntry(over: Record<string, unknown> = {}): unknown {
  return {
    id: 'glm-5-1',
    model_spec: {
      name: 'GLM 5.1',
      availableContextTokens: 200_000,
      capabilities: {
        supportsVision: true,
        supportsReasoningEffort: true,
        supportsFunctionCalling: true,
        supportsResponseSchema: true,
      },
      pricing: { input: { usd: 0.3 }, output: { usd: 1.2 } },
      ...over,
    },
  };
}

const SAMPLE: CatalogModel = {
  id: 'glm-5-1',
  name: 'GLM 5.1',
  contextWindow: 200_000,
  supportsVision: true,
  supportsReasoning: true,
  supportsFunctionCalling: true,
  supportsResponseFormat: true,
  inputUsdPerM: 0.3,
  outputUsdPerM: 1.2,
  deprecated: false,
};

describe('coerceCatalog', () => {
  it('flattens the nested model_spec into a CatalogModel', () => {
    expect(coerceCatalog({ data: [rawEntry()] })).toEqual([SAMPLE]);
  });
  it('accepts a bare array as well as the data envelope', () => {
    expect(coerceCatalog([rawEntry()])).toEqual([SAMPLE]);
  });
  it('treats a model as reasoning-capable if EITHER Venice flag is set', () => {
    // supportsReasoning alone (emits a thinking pass, no granular effort
    // knob) - this is the qwen-3-7-plus case that the strict gate broke.
    const reasonOnly = rawEntry({ capabilities: { supportsReasoning: true } });
    expect(coerceCatalog([reasonOnly])[0].supportsReasoning).toBe(true);
    // Explicitly false effort knob must NOT zero out a true reasoning flag.
    const reasonNoEffort = rawEntry({
      capabilities: { supportsReasoning: true, supportsReasoningEffort: false },
    });
    expect(coerceCatalog([reasonNoEffort])[0].supportsReasoning).toBe(true);
    // Effort knob alone is also reasoning-capable.
    const effortOnly = rawEntry({ capabilities: { supportsReasoningEffort: true } });
    expect(coerceCatalog([effortOnly])[0].supportsReasoning).toBe(true);
    // Neither flag - not a reasoning model (e.g. gpt-4o).
    const neither = rawEntry({ capabilities: {} });
    expect(coerceCatalog([neither])[0].supportsReasoning).toBe(false);
  });
  it('treats a missing pricing block as null, not zero', () => {
    const free = rawEntry({ pricing: undefined });
    const model = coerceCatalog([free])[0];
    expect(model.inputUsdPerM).toBeNull();
    expect(model.outputUsdPerM).toBeNull();
  });
  it('flags deprecation when a date is present', () => {
    const dep = rawEntry({ deprecation: { date: '2025-03-01T00:00:00.000Z' } });
    expect(coerceCatalog([dep])[0].deprecated).toBe(true);
  });
  it('drops offline models and rows missing id or context window', () => {
    expect(coerceCatalog([rawEntry({ offline: true })])).toEqual([]);
    expect(coerceCatalog([{ id: '', model_spec: {} }])).toEqual([]);
    expect(coerceCatalog([rawEntry({ availableContextTokens: 0 })])).toEqual([]);
  });
  it('sorts by name', () => {
    const a = { id: 'z', model_spec: { name: 'Zeta', availableContextTokens: 1000 } };
    const b = { id: 'a', model_spec: { name: 'Alpha', availableContextTokens: 1000 } };
    expect(coerceCatalog([a, b]).map((m) => m.name)).toEqual(['Alpha', 'Zeta']);
  });
});

describe('capabilityChips', () => {
  it('emits one chip per supported feature', () => {
    expect(capabilityChips(SAMPLE).map((c) => c.label)).toEqual([
      'Reasoning',
      'Vision',
      'Tools',
    ]);
  });
  it('emits nothing for a bare model', () => {
    expect(
      capabilityChips({ supportsVision: false, supportsReasoning: false })
    ).toEqual([]);
  });
});

describe('formatContextWindow', () => {
  it('formats whole and fractional millions and sub-million windows', () => {
    expect(formatContextWindow(1_000_000)).toBe('1M');
    expect(formatContextWindow(1_500_000)).toBe('1.5M');
    expect(formatContextWindow(256_000)).toBe('256k');
  });
});

describe('formatPricing', () => {
  it('formats a full price pair', () => {
    expect(formatPricing(SAMPLE)).toBe('$0.30 in / $1.20 out per 1M');
  });
  it('reads n/a when both sides are absent', () => {
    expect(formatPricing({ inputUsdPerM: null, outputUsdPerM: null })).toBe(
      'Pricing n/a'
    );
  });
});

describe('fuzzyMatch', () => {
  it('scores an in-order subsequence and rejects a miss', () => {
    expect(fuzzyMatch('qwn', 'Qwen 3.7 Plus')).not.toBeNull();
    expect(fuzzyMatch('xyz', 'Qwen 3.7 Plus')).toBeNull();
  });
  it('treats an empty query as a match-all (score 0)', () => {
    expect(fuzzyMatch('', 'anything')).toBe(0);
    expect(fuzzyMatch('   ', 'anything')).toBe(0);
  });
  it('is case-insensitive', () => {
    expect(fuzzyMatch('GPT', 'gpt-oss')).not.toBeNull();
  });
  it('ranks a contiguous hit above a scattered one (boundary held equal)', () => {
    // Both start with 'a' (same word-boundary bonus), so the only
    // difference is the contiguous run in the first.
    const contiguous = fuzzyMatch('abc', 'abcdef')!;
    const scattered = fuzzyMatch('abc', 'axbxcx')!;
    expect(contiguous).toBeGreaterThan(scattered);
  });
  it('rewards a word-boundary hit', () => {
    const boundary = fuzzyMatch('f', 'deep flash')!;
    const midword = fuzzyMatch('f', 'deepflash')!;
    expect(boundary).toBeGreaterThan(midword);
  });
});

describe('filterModelOptions', () => {
  const fixture = (name: string, id: string): CatalogModel => ({ ...SAMPLE, name, id });
  const opts = buildModelOptions(
    [
      fixture('Qwen 3.7 Plus', 'qwen-3-7-plus'),
      fixture('DeepSeek V4 Flash', 'deepseek-v4-flash'),
      fixture('GPT OSS 20B', 'gpt-oss-20b'),
    ],
    null
  );
  it('returns every option (original order) for an empty query', () => {
    expect(filterModelOptions(opts, '').map((o) => o.id)).toEqual(
      opts.map((o) => o.id)
    );
    expect(filterModelOptions(opts, '   ')).toHaveLength(opts.length);
  });
  it('filters to fuzzy-matching options', () => {
    const r = filterModelOptions(opts, 'deep');
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('deepseek-v4-flash');
  });
  it('matches on the model id, not just the label', () => {
    // "oss-20" appears only in the id, proving the id is searched too.
    const r = filterModelOptions(opts, 'oss-20');
    expect(r.map((o) => o.id)).toContain('gpt-oss-20b');
  });
  it('orders best match first', () => {
    const r = filterModelOptions(opts, 'qwen');
    expect(r[0].id).toBe('qwen-3-7-plus');
  });
});

describe('buildModelOptions', () => {
  it('lists catalog models without a synthetic entry when the current is present', () => {
    const opts = buildModelOptions([SAMPLE], { id: SAMPLE.id, label: SAMPLE.name });
    expect(opts).toHaveLength(1);
    expect(opts[0].model).toBe(SAMPLE);
  });
  it('prepends a synthetic "current" option when the pick is off-catalog', () => {
    const opts = buildModelOptions([SAMPLE], { id: 'retired-x', label: 'Retired X' });
    expect(opts[0].id).toBe('retired-x');
    expect(opts[0].model).toBeNull();
    expect(opts[0].label).toContain('current');
  });
});

describe('priceCapHiddenNote', () => {
  it('returns null when nothing is hidden', () => {
    expect(priceCapHiddenNote(0)).toBeNull();
    expect(priceCapHiddenNote(-1)).toBeNull();
  });
  it('pluralizes the count', () => {
    expect(priceCapHiddenNote(1)).toBe("1 model is hidden by this instance's price cap.");
    expect(priceCapHiddenNote(3)).toBe("3 models are hidden by this instance's price cap.");
  });
});
