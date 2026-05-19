/**
 * UI-behavior primitives for the per-message context-window ring.
 * Pure functions only - no runes, no Svelte imports, no DOM. The
 * companion `src/components/ContextRing.svelte` composes these
 * with its own framework-native reactivity (the `open` rune, the
 * Escape `$effect`, the SVG geometry constants, the slide
 * transition, and the markup).
 *
 * SVG-side constants (radius, circumference) stay in the
 * component because they are tied to the rendered markup. Pure
 * decision logic - how to translate token counts into a
 * percentage, what color hue to pick, how to phrase the
 * tooltip - lives here.
 */

/**
 * Percentage of the context window used, clamped to [0, 1]. The
 * clamp is defensive: a provider that overshoots (shouldn't
 * happen, but) would otherwise produce a ring that goes around
 * twice or a negative stroke-dashoffset. The `contextWindow > 0`
 * guard handles the "no model context info available" case where
 * dividing yields NaN.
 */
export function clampedPct(
  totalTokens: number,
  contextWindow: number
): number {
  if (!(contextWindow > 0)) return 0;
  const raw = totalTokens / contextWindow;
  return Math.min(1, Math.max(0, raw));
}

/**
 * Hue track for the ring color. 120 (green) at 0%, 0 (red) at
 * 100%, passing through 60 (yellow) at the midpoint. A single
 * linear interp matches the "getting worse as the ring fills"
 * intuition without extra thresholds to tune.
 */
export function pctToHue(pct: number): number {
  return Math.round((1 - pct) * 120);
}

/**
 * Full HSL color string for the ring stroke. Saturation and
 * lightness are fixed so the ring reads the same across themes;
 * those numbers were picked to stay legible against both light
 * and dark message-card surfaces.
 */
export function pctToRingColor(pct: number): string {
  return `hsl(${pctToHue(pct)} 65% 42%)`;
}

/**
 * Human-readable usage summary. Percentage leads because it's
 * the headline - a glance at the ring already suggests "about
 * half full"; the reveal's job is to put a specific number to
 * that impression, then back it up with the exact token counts.
 * Thousands separators make the magnitudes legible (1,234,567
 * reads instantly; 1234567 doesn't).
 */
export function usageSummary(
  totalTokens: number,
  contextWindow: number
): string {
  const pct = clampedPct(totalTokens, contextWindow);
  const fmt = new Intl.NumberFormat();
  return `Context window: ${Math.round(pct * 100)}% used (${fmt.format(totalTokens)} / ${fmt.format(contextWindow)} tokens)`;
}

/**
 * Format an ISO timestamp in the user's preferred timezone for
 * the "Received X" line in the detail row. Returns null when the
 * input is missing or unparseable so the caller can suppress the
 * line entirely.
 *
 * Bad zone strings fall back to the browser default rather than
 * blanking the line - a stale or hand-edited setting shouldn't
 * blank a piece of metadata the user can see is available.
 */
export function formatReceivedAt(
  iso: string | null | undefined,
  timezone: string | undefined
): string | null {
  if (!iso) return null;
  const ts = new Date(iso);
  if (Number.isNaN(ts.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(ts);
  } catch {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(ts);
  }
}

/**
 * Combined tooltip / aria-label payload. Folds the timestamp in
 * with a bullet separator when present so a quick hover surfaces
 * both the usage and the received-at time without expanding the
 * detail row. The bullet character (U+2022) is the same
 * separator the rest of the action bar uses.
 */
export function usageTooltip(
  summary: string,
  receivedAt: string | null
): string {
  return receivedAt ? `${summary} • Received ${receivedAt}` : summary;
}
