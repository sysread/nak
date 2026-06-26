// UI-behavior primitives for the Settings -> Usage pane. Pure functions over
// plain numbers - no Svelte, no DOM - so they unit-test in isolation and the
// `.svelte` file stays glue. The companion data layer (row coercion, the
// analytics fetch) lives in `src/lib/usage.ts`; this module owns only the
// display math.

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
