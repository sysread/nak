/**
 * Unit coverage for coerceUsageAnalytics - the defensive reader that turns
 * Venice's /billing/usage-analytics response into the per-model buckets the
 * Usage pane renders. Only the `byModel` slice is consumed; the coercer drops
 * malformed entries rather than throwing, scales `totalUnits` (millions of
 * tokens) to a raw count, and zeroes tokens for non-token SKUs. The HTTP wire
 * shape (query string, headers, Venice error mapping) lives on the function
 * side and is covered by supabase/functions/tests/usage.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { coerceUsageAnalytics } from '../src/lib/usage';

function modelEntry(overrides: Record<string, unknown> = {}) {
  return {
    modelName: 'GLM 5.1',
    unitType: 'tokens',
    modelType: 'LLM',
    totalUsd: 0.4,
    totalDiem: 0,
    totalUnits: 0.05, // 0.05 million tokens = 50_000
    ...overrides,
  };
}

describe('coerceUsageAnalytics', () => {
  it('coerces a well-formed LLM model entry and scales tokens to a raw count', () => {
    const buckets = coerceUsageAnalytics({ byModel: [modelEntry()] });
    expect(buckets).toEqual([
      { modelName: 'GLM 5.1', tokens: 50_000, usd: 0.4, diem: 0 },
    ]);
  });

  it('carries both USD and DIEM totals through', () => {
    const buckets = coerceUsageAnalytics({
      byModel: [modelEntry({ totalUsd: 1.5, totalDiem: 2.25 })],
    });
    expect(buckets[0].usd).toBe(1.5);
    expect(buckets[0].diem).toBe(2.25);
  });

  it('zeroes tokens for a non-token SKU but still emits the bucket', () => {
    // Image/video models bill in their own units; they contribute no tokens
    // but must still appear so their spend shows in the list.
    const buckets = coerceUsageAnalytics({
      byModel: [modelEntry({ unitType: 'images', totalUnits: 12, totalUsd: 0.3 })],
    });
    expect(buckets).toEqual([
      { modelName: 'GLM 5.1', tokens: 0, usd: 0.3, diem: 0 },
    ]);
  });

  it('defaults a missing currency total to 0 rather than dropping the entry', () => {
    const buckets = coerceUsageAnalytics({
      byModel: [{ modelName: 'X', unitType: 'tokens', totalUnits: 0.001 }],
    });
    expect(buckets).toEqual([{ modelName: 'X', tokens: 1_000, usd: 0, diem: 0 }]);
  });

  it('drops entries missing a model name without failing the whole parse', () => {
    const buckets = coerceUsageAnalytics({
      byModel: [{ totalUsd: 1 }, modelEntry({ modelName: 'kept' })],
    });
    expect(buckets.map((b) => b.modelName)).toEqual(['kept']);
  });

  it('returns an empty list when byModel is absent or not an array', () => {
    expect(coerceUsageAnalytics({})).toEqual([]);
    expect(coerceUsageAnalytics({ byModel: 'nope' })).toEqual([]);
    expect(coerceUsageAnalytics(null)).toEqual([]);
    expect(coerceUsageAnalytics(undefined)).toEqual([]);
  });
});
