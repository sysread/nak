import { describe, it, expect } from 'vitest';
import { coerceCatalog, type CatalogModel } from '../src/lib/models/catalog';
import {
  buildModelOptions,
  capabilityChips,
  formatContextWindow,
  formatPricing,
  tierConfigFromCatalog,
  tierRowView,
} from '../src/lib/ui/model-picker';
import { TIERS } from '../src/lib/models';

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

describe('tierConfigFromCatalog', () => {
  it('snapshots capabilities + the chosen thinking level', () => {
    expect(tierConfigFromCatalog(SAMPLE, 'low')).toEqual({
      modelId: 'glm-5-1',
      thinking: 'low',
      contextWindow: 200_000,
      supportsReasoning: true,
      supportsVision: true,
      supportsResponseFormat: true,
      label: 'GLM 5.1',
    });
  });
});

describe('tierRowView', () => {
  it('reflects the built-in spec and no override by default', () => {
    const row = tierRowView('smart', {}, []);
    expect(row.spec.id).toBe(TIERS.smart.id);
    expect(row.overridden).toBe(false);
    // The built-in id isn't in an empty catalog, so the select still
    // shows it via a synthetic option.
    expect(row.options[0].id).toBe(TIERS.smart.id);
  });
  it('reads price + chips from the live catalog row for the selected model', () => {
    const row = tierRowView('smart', { smart: tierConfigFromCatalog(SAMPLE, 'high') }, [
      SAMPLE,
    ]);
    expect(row.spec.id).toBe('glm-5-1');
    expect(row.overridden).toBe(true);
    expect(row.thinking).toBe('high');
    expect(row.priceLabel).toBe('$0.30 in / $1.20 out per 1M');
    expect(row.chips.map((c) => c.label)).toContain('Vision');
  });
});
