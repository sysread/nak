// UI-behavior primitives for the Settings -> Usage pane. Pure functions over
// plain numbers and the coerced analytics buckets - no Svelte, no DOM - so
// they unit-test in isolation and the `.svelte` file stays glue. The
// companion data layer (row coercion, the analytics fetch) lives in
// `src/lib/usage.ts`; this module owns the pane's display decisions: the
// per-(model, currency) bucket fan-out, the per-currency totals, the
// token/spend formatters and pill tooltips, the bar-width scaling, and the
// yyyy-mm-dd helpers behind the date pickers.

import type { UsageCurrency, UsageModelBucket } from '../usage';

/**
 * Map a value to a hue (0-360) describing where it sits relative to the rest of
 * its population. The population median lands green (~140 deg), the largest
 * member red (~5 deg), the smallest blue (~220 deg); everything in between
 * interpolates. The Usage pane drives two independent channels through this:
 * the bar hue from each model's token count, and the spend-pill border from
 * each model's dollar amount.
 *
 * Why median-anchored on a log scale, not a plain percentile tertile: usage
 * distributions are heavy-tailed - one heavy workload plus a dozen utility
 * calls would collapse the whole spectrum to two adjacent shades under straight
 * top-third / middle-third / bottom-third bucketing. Anchoring at the median
 * isolates the outlier on the high side without flattening the rest into a
 * single color, matching the intuitive read: "most of these are the green pack,
 * that one is obviously doing more work." The log() is the other half of the
 * trick - it squeezes an order-of-magnitude outlier into a comparable distance
 * on the color axis so the gradient stays readable whether the biggest member
 * is 2x or 200x the smallest.
 *
 * Small-N behavior: with 1 member everything sits at the median (green); with 2
 * the larger is at +1 (red) and the smaller at -1 (blue) - minimally useful but
 * not wrong. The coloring earns its keep at 3+ members, the common case.
 *
 * Non-positive values (a zero-token row, an empty population) fall back to the
 * neutral median hue rather than feeding log() a non-positive argument.
 */
export function relativeHue(value: number, population: number[]): number {
  // Neutral (green) - a non-positive value picks up the same color the
  // "typical" band uses rather than going through log().
  if (value <= 0) return 140;
  const logs = population
    .filter((v) => v > 0)
    .map((v) => Math.log(v))
    .sort((a, b) => a - b);
  if (logs.length === 0) return 140;
  const median = logs[Math.floor(logs.length / 2)];
  const minLog = logs[0];
  const maxLog = logs[logs.length - 1];
  const cur = Math.log(value);
  // Position in [-1, +1] anchored at the median. +1 = the biggest member,
  // -1 = the smallest, 0 = sitting on the median.
  let pos: number;
  if (cur >= median) {
    pos = maxLog === median ? 0 : (cur - median) / (maxLog - median);
  } else {
    pos = minLog === median ? 0 : -(median - cur) / (median - minLog);
  }
  pos = Math.max(-1, Math.min(1, pos));
  // Map: -1 -> 220 (blue), 0 -> 140 (green), +1 -> 5 (red). The red side uses a
  // steeper slope (140 -> 5 over [0, 1]) so outliers reach a genuinely red hue;
  // the blue side moves more gently (140 -> 220 over [-1, 0]) to avoid pushing
  // past cyan into purple.
  if (pos >= 0) return 140 - pos * 135;
  return 140 - pos * 80;
}

/**
 * One row of the Usage table - a per-model, per-currency bucket. The
 * analytics `byModel` roll-up gives one entry per model carrying both
 * USD and DIEM totals; {@link aggregateUsage} fans that into one bucket
 * per currency the model was billed in so a mixed USD+DIEM plan never
 * sums unlike units.
 *
 * Exported as the named return shape of `aggregateUsage` - consumers
 * use the inferred type rather than importing the name. Not dead code.
 */
export interface UsageBucket {
  /** Model display name (analytics `modelName`), shown in the row label. */
  sku: string;
  currency: UsageCurrency;
  /** Token count for the model (0 for non-LLM SKUs). */
  tokens: number;
  /** Spend in this bucket's currency. */
  amount: number;
}

/**
 * Fan the analytics per-model roll-up into the table's per-(model,
 * currency) buckets. Each `byModel` entry carries both a USD and a
 * DIEM total; we emit one bucket per currency the model actually billed
 * in (a nonzero total) so a mixed USD+DIEM plan never sums unlike units
 * into one figure. Spend is already positive in the analytics shape, so
 * no sign inversion (the per-request ledger's signed debits are gone).
 *
 * Tokens are reported per model, NOT split by currency. A model is
 * almost always billed in a single currency within a window - Venice
 * debits DIEM first and only falls through to USD once DIEM is
 * exhausted - so the split is near-always 1:1. For the rare
 * epoch-crossing model billed in both, the whole token count is
 * attributed to the larger-spend currency and the minor row's bar is
 * left empty; the tokens are still counted exactly once in the chart
 * total.
 *
 * Buckets whose spend lands below one cent are dropped. Dust rows
 * clutter the chart without telling the user anything they'd act on,
 * and keeping them produced the `$0.00` cells this filter was added to
 * remove.
 */
export function aggregateUsage(models: UsageModelBucket[]): UsageBucket[] {
  const out: UsageBucket[] = [];
  for (const m of models) {
    const pairs: { currency: UsageCurrency; amount: number }[] = [];
    if (m.usd > 0) pairs.push({ currency: 'USD', amount: m.usd });
    if (m.diem > 0) pairs.push({ currency: 'DIEM', amount: m.diem });
    // Larger-spend currency first so it gets the token attribution.
    pairs.sort((a, b) => b.amount - a.amount);
    pairs.forEach((p, i) => {
      out.push({
        sku: m.modelName,
        currency: p.currency,
        tokens: i === 0 ? m.tokens : 0,
        amount: p.amount,
      });
    });
  }
  return (
    out
      // One-cent dust filter. The USD display resolution is two
      // decimals, so anything under $0.01 renders as zero anyway;
      // applying the same numeric threshold to DIEM drops equivalently
      // trivial credit rows without needing a per-currency table.
      .filter((b) => b.amount >= 0.01)
      .sort((a, b) => {
        // Token-heavy rows first. Zero-token rows (image, video)
        // cluster at the bottom in amount order so spend-only SKUs
        // still sort sensibly among themselves.
        if (b.tokens !== a.tokens) return b.tokens - a.tokens;
        return b.amount - a.amount;
      })
  );
}

/** One row of the per-currency spend summary at the top of the pane.
 *  Exported as the named return shape of `aggregateTotalsByCurrency` -
 *  consumers use the inferred type rather than importing the name. Not
 *  dead code. */
export interface CurrencyTotal {
  currency: UsageCurrency;
  amount: number;
}

/**
 * Roll the per-model buckets up into one total per currency. We
 * group rather than collapse so a user on a mixed USD + credits
 * plan sees two totals — summing across currencies would be
 * meaningless (a dollar and a credit aren't the same unit). USD
 * sorts first so the cash total — the one that actually hit the
 * user's card — reads as the primary figure; credit currencies
 * fall in stable alpha order after.
 */
export function aggregateTotalsByCurrency(buckets: UsageBucket[]): CurrencyTotal[] {
  const sums = new Map<UsageCurrency, number>();
  for (const b of buckets) {
    sums.set(b.currency, (sums.get(b.currency) ?? 0) + b.amount);
  }
  return Array.from(sums.entries())
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => {
      if (a.currency === 'USD') return -1;
      if (b.currency === 'USD') return 1;
      return a.currency.localeCompare(b.currency);
    });
}

const tokenFormatter = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** Compact token count for a chart cell; zero renders as an em-dash
 *  placeholder so spend-only rows (image, video) don't show a bare 0. */
export function formatTokens(n: number): string {
  if (n === 0) return '—';
  return tokenFormatter.format(n);
}

/**
 * Always render spend with the `$` sigil. Non-USD charges (VCU,
 * DIEM, BUNDLED_CREDITS) get a muted pill style and a hover
 * tooltip spelling out the origin — that's where "this was paid
 * with credits, not cash" gets communicated. Keeping the numeric
 * body identical across currencies lets every pill align cleanly
 * in the spend column without the currency code widening the
 * cell for a subset of rows.
 */
export function formatAmount(amount: number, _currency: UsageCurrency): string {
  void _currency;
  return `$${amount.toFixed(2)}`;
}

/**
 * Sub-cent precision for the avg-per-day pill. The totals pill
 * rounds to two decimals because dollars and cents is the usual
 * display unit, but daily averages from a 7-day window of light
 * traffic can easily land at fractions of a cent - rounding those
 * to `$0.00` defeats the pill's purpose. Three decimals keeps the
 * pill readable while still showing signal on a sub-cent average.
 */
export function formatAmountPerDay(amount: number, _currency: UsageCurrency): string {
  void _currency;
  if (amount === 0) return '$0/day';
  if (amount < 0.005) return `$${amount.toFixed(3)}/day`;
  return `$${amount.toFixed(2)}/day`;
}

/**
 * Human-facing tooltip text for a non-USD pill. Only DIEM reaches
 * here today (USD pills carry no tooltip), but a `default` keeps a
 * future analytics currency from rendering blank - it falls back to
 * the raw identifier rather than silently hiding the distinction.
 */
export function currencyTitle(currency: UsageCurrency): string {
  return currency === 'DIEM'
    ? 'Paid with DIEM credits'
    : `Paid with ${currency}`;
}

/** Non-USD spend renders as a muted "credit" pill - USD is the cash
 *  that actually hit the user's card, everything else is a credit
 *  denomination the eye can skip past. */
export function isCreditCurrency(currency: UsageCurrency): boolean {
  return currency !== 'USD';
}

/** Hover title for a spend pill: the credit-origin explainer for
 *  non-USD rows, or undefined for USD (cash needs no footnote and an
 *  empty tooltip would just flicker). */
export function spendPillTitle(currency: UsageCurrency): string | undefined {
  return isCreditCurrency(currency) ? currencyTitle(currency) : undefined;
}

/** Hover title for an avg-per-day pill: names the day count the
 *  average divides over, plus the credit-origin explainer when the
 *  paired total is a non-USD pill. */
export function perDayTitle(rangeDays: number, currency: UsageCurrency): string {
  return `Average per day over ${rangeDays} day${rangeDays === 1 ? '' : 's'}${
    isCreditCurrency(currency) ? ' - ' + currencyTitle(currency) : ''
  }`;
}

/**
 * Inclusive day count for the picked range. The date pickers read
 * as yyyy-mm-dd in the user's local calendar; "from May 1 to May 7"
 * intuitively covers 7 days, not 6 (the diff between midnights) and
 * not 8 (the exclusive upper bound the fetch uses). The clamp at 1
 * keeps a same-day selection from dividing by zero.
 */
export function daysInPickedRange(start: string, end: string): number {
  const startMs = new Date(`${start}T00:00:00Z`).getTime();
  const endMs = new Date(`${end}T00:00:00Z`).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 1;
  const diffDays = Math.round((endMs - startMs) / (24 * 60 * 60 * 1000));
  return Math.max(1, diffDays + 1);
}

/**
 * Bar width (a percentage) for a chart row, scaled against the
 * token-heaviest row. Width is `max(2%, share-of-max)` so a non-zero
 * but tiny row still registers as a visible bar rather than an
 * invisible sliver; a truly zero-token row (image SKU) collapses to
 * nothing, as does an all-zero chart.
 */
export function usageBarPercent(tokens: number, maxTokens: number): number {
  return maxTokens > 0 && tokens > 0
    ? Math.max(2, (tokens / maxTokens) * 100)
    : 0;
}

/** Count-to-noun for the totals strip. The leading space is part of
 *  the rendered output - the template drops the fragment directly
 *  after the bolded count with no whitespace of its own. */
export function modelCountNoun(count: number): string {
  return count === 1 ? ' model' : ' models';
}

/** Today as the yyyy-mm-dd string `<input type="date">` consumes.
 *  `now` is injectable so tests can pin the clock; callers omit it. */
export function todayYmd(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** yyyy-mm-dd for N days before `now` - the lower bound of the
 *  pane's default rolling window. Same injectable clock as todayYmd. */
export function ymdDaysAgo(days: number, now: Date = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
