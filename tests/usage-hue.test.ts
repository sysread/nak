/**
 * Unit coverage for the Usage pane's UI primitives
 * (src/lib/ui/usage.ts): relativeHue - the median-anchored log-scale
 * color mapping used for both the bar hue (over tokens) and the
 * spend-pill border hue (over dollars) - plus the bucket fan-out,
 * per-currency totals, formatters, pill tooltips, bar scaling, and
 * date-picker helpers. (Named usage-hue rather than usage because
 * tests/usage.test.ts already covers the data layer in
 * src/lib/usage.ts.)
 *
 * For relativeHue, populations are built from exact powers of e so
 * the log values land on clean integers and the median/min/max
 * anchors are obvious.
 */
import { describe, it, expect } from 'vitest';
import type { UsageModelBucket } from '../src/lib/usage';
import {
  aggregateTotalsByCurrency,
  aggregateUsage,
  currencyTitle,
  daysInPickedRange,
  formatAmount,
  formatAmountPerDay,
  formatTokens,
  isCreditCurrency,
  modelCountNoun,
  perDayTitle,
  relativeHue,
  spendPillTitle,
  todayYmd,
  usageBarPercent,
  ymdDaysAgo,
} from '../src/lib/ui/usage';

// logs sorted -> [0, 1, 2], median = 1, min = 0, max = 2.
const POP = [Math.E ** 0, Math.E ** 1, Math.E ** 2];

describe('relativeHue', () => {
  it('returns the neutral median hue for a non-positive value', () => {
    expect(relativeHue(0, POP)).toBe(140);
    expect(relativeHue(-5, POP)).toBe(140);
  });

  it('returns the neutral median hue when the population is empty', () => {
    expect(relativeHue(10, [])).toBe(140);
    expect(relativeHue(10, [0, -1])).toBe(140); // all filtered out
  });

  it('puts the population median at green (140)', () => {
    expect(relativeHue(Math.E ** 1, POP)).toBe(140);
  });

  it('puts the largest member at red (5)', () => {
    expect(relativeHue(Math.E ** 2, POP)).toBe(5);
  });

  it('puts the smallest member at blue (220)', () => {
    expect(relativeHue(Math.E ** 0, POP)).toBe(220);
  });

  it('clamps a value above the population max to the red endpoint', () => {
    expect(relativeHue(Math.E ** 5, POP)).toBe(5);
  });

  it('clamps a value below the population min to the blue endpoint', () => {
    expect(relativeHue(Math.E ** -3, POP)).toBe(220);
  });

  it('is monotonic: a larger value yields a hue closer to red', () => {
    const small = relativeHue(Math.E ** 0.5, POP);
    const mid = relativeHue(Math.E ** 1, POP);
    const large = relativeHue(Math.E ** 1.5, POP);
    expect(small).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(large);
  });

  it('sits a single-member population at the median hue', () => {
    // median == min == max, so every position collapses to 0 (green).
    expect(relativeHue(42, [42])).toBe(140);
  });
});

// A byModel entry with overridable fields, defaulting to a plain
// USD-billed LLM row.
function model(over: Partial<UsageModelBucket> = {}): UsageModelBucket {
  return { modelName: 'llama', tokens: 1000, usd: 1.5, diem: 0, ...over };
}

describe('aggregateUsage', () => {
  it('emits one bucket per currency the model actually billed in', () => {
    const buckets = aggregateUsage([model({ usd: 2, diem: 3 })]);
    expect(buckets.map((b) => b.currency).sort()).toEqual(['DIEM', 'USD']);
  });

  it('skips zero-spend currencies entirely', () => {
    const buckets = aggregateUsage([model({ usd: 2, diem: 0 })]);
    expect(buckets).toEqual([
      { sku: 'llama', currency: 'USD', tokens: 1000, amount: 2 },
    ]);
  });

  it('attributes all tokens to the larger-spend currency of a mixed row', () => {
    const buckets = aggregateUsage([model({ usd: 1, diem: 4 })]);
    const diem = buckets.find((b) => b.currency === 'DIEM');
    const usd = buckets.find((b) => b.currency === 'USD');
    expect(diem?.tokens).toBe(1000);
    expect(usd?.tokens).toBe(0);
  });

  it('drops sub-cent dust buckets', () => {
    // $0.009 renders as $0.00 at the pane's two-decimal resolution -
    // the row would be pure clutter.
    expect(aggregateUsage([model({ usd: 0.009 })])).toEqual([]);
  });

  it('sorts token-heavy rows first, then by amount among zero-token rows', () => {
    const buckets = aggregateUsage([
      model({ modelName: 'image-a', tokens: 0, usd: 0.5 }),
      model({ modelName: 'chatty', tokens: 9000, usd: 0.2 }),
      model({ modelName: 'image-b', tokens: 0, usd: 2 }),
    ]);
    expect(buckets.map((b) => b.sku)).toEqual(['chatty', 'image-b', 'image-a']);
  });
});

describe('aggregateTotalsByCurrency', () => {
  it('sums per currency without collapsing unlike units', () => {
    const totals = aggregateTotalsByCurrency([
      { sku: 'a', currency: 'DIEM', tokens: 0, amount: 1 },
      { sku: 'b', currency: 'USD', tokens: 0, amount: 2 },
      { sku: 'c', currency: 'USD', tokens: 0, amount: 3 },
    ]);
    expect(totals).toEqual([
      { currency: 'USD', amount: 5 },
      { currency: 'DIEM', amount: 1 },
    ]);
  });

  it('puts the cash total first regardless of input order', () => {
    const totals = aggregateTotalsByCurrency([
      { sku: 'a', currency: 'DIEM', tokens: 0, amount: 1 },
      { sku: 'b', currency: 'USD', tokens: 0, amount: 1 },
    ]);
    expect(totals[0].currency).toBe('USD');
  });
});

describe('formatTokens', () => {
  it('renders zero as an em-dash placeholder, not a bare 0', () => {
    expect(formatTokens(0)).toBe('—');
  });

  it('renders non-zero counts in the locale compact notation', () => {
    const compact = new Intl.NumberFormat(undefined, {
      notation: 'compact',
      maximumFractionDigits: 1,
    });
    expect(formatTokens(1500)).toBe(compact.format(1500));
    expect(formatTokens(2_000_000)).toBe(compact.format(2_000_000));
  });
});

describe('formatAmount', () => {
  it('keeps the $ sigil and two decimals across currencies', () => {
    expect(formatAmount(1.234, 'USD')).toBe('$1.23');
    expect(formatAmount(1.234, 'DIEM')).toBe('$1.23');
  });
});

describe('formatAmountPerDay', () => {
  it('renders a zero average without decimals', () => {
    expect(formatAmountPerDay(0, 'USD')).toBe('$0/day');
  });

  it('keeps three decimals for sub-cent averages so they do not read as $0.00', () => {
    expect(formatAmountPerDay(0.0042, 'USD')).toBe('$0.004/day');
  });

  it('rounds to cents once the average clears half a cent', () => {
    expect(formatAmountPerDay(0.005, 'USD')).toBe('$0.01/day');
    expect(formatAmountPerDay(1.239, 'DIEM')).toBe('$1.24/day');
  });
});

describe('currency helpers', () => {
  it('spells out the DIEM credit origin and falls back to the raw code', () => {
    expect(currencyTitle('DIEM')).toBe('Paid with DIEM credits');
    expect(currencyTitle('USD')).toBe('Paid with USD');
  });

  it('treats everything but USD as a credit denomination', () => {
    expect(isCreditCurrency('USD')).toBe(false);
    expect(isCreditCurrency('DIEM')).toBe(true);
  });

  it('gives spend pills a tooltip only for credit rows', () => {
    expect(spendPillTitle('USD')).toBeUndefined();
    expect(spendPillTitle('DIEM')).toBe('Paid with DIEM credits');
  });

  it('builds the per-day tooltip with day pluralization and the credit suffix', () => {
    expect(perDayTitle(1, 'USD')).toBe('Average per day over 1 day');
    expect(perDayTitle(7, 'USD')).toBe('Average per day over 7 days');
    expect(perDayTitle(7, 'DIEM')).toBe(
      'Average per day over 7 days - Paid with DIEM credits'
    );
  });
});

describe('daysInPickedRange', () => {
  it('counts inclusively: May 1 to May 7 is 7 days', () => {
    expect(daysInPickedRange('2026-05-01', '2026-05-07')).toBe(7);
  });

  it('clamps a same-day selection to 1 so averages never divide by zero', () => {
    expect(daysInPickedRange('2026-05-01', '2026-05-01')).toBe(1);
  });

  it('falls back to 1 on an unparseable bound', () => {
    expect(daysInPickedRange('garbage', '2026-05-07')).toBe(1);
  });
});

describe('usageBarPercent', () => {
  it('scales a row against the token-heaviest row', () => {
    expect(usageBarPercent(50, 100)).toBe(50);
    expect(usageBarPercent(100, 100)).toBe(100);
  });

  it('floors a tiny non-zero row at 2% so it stays visible', () => {
    expect(usageBarPercent(1, 10_000)).toBe(2);
  });

  it('collapses zero-token rows and all-zero charts to nothing', () => {
    expect(usageBarPercent(0, 100)).toBe(0);
    expect(usageBarPercent(10, 0)).toBe(0);
  });
});

describe('modelCountNoun', () => {
  it('carries its own leading space (the template concatenates it after the bold count)', () => {
    expect(modelCountNoun(1)).toBe(' model');
    expect(modelCountNoun(2)).toBe(' models');
    expect(modelCountNoun(0)).toBe(' models');
  });
});

describe('date-picker helpers', () => {
  const NOW = new Date('2026-07-03T15:00:00Z');

  it('renders today as the yyyy-mm-dd shape <input type="date"> consumes', () => {
    expect(todayYmd(NOW)).toBe('2026-07-03');
  });

  it('walks back N calendar days for the default window lower bound', () => {
    expect(ymdDaysAgo(7, NOW)).toBe('2026-06-26');
    // Month boundary crossing.
    expect(ymdDaysAgo(3, new Date('2026-07-01T15:00:00Z'))).toBe('2026-06-28');
  });

  it('does not mutate the injected clock', () => {
    const pinned = new Date('2026-07-03T15:00:00Z');
    ymdDaysAgo(7, pinned);
    expect(pinned.toISOString()).toBe('2026-07-03T15:00:00.000Z');
  });
});
