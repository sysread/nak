/**
 * Component tests for ContextRing.svelte.
 *
 * jsdom doesn't render SVG visually, but it does resolve attribute bindings
 * — which is where the load-bearing logic of this component lives. We
 * assert on the reactive outputs the user actually cares about:
 * `stroke-dashoffset` (how full the ring is), `stroke` (the HSL hue
 * ramp), and the accessible label (what a screen reader announces). If
 * those three stay truthful across the percentage range we know the ring
 * is showing the right story.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import ContextRing from '../src/components/ContextRing.svelte';
import {
  clampedPct,
  formatReceivedAt,
  pctToHue,
  pctToRingColor,
  usageSummary,
  usageTooltip,
} from '../src/lib/ui/context-ring';

afterEach(() => {
  cleanup();
});

/**
 * Pull the progress arc (the second <circle> in the SVG) off a rendered
 * container. Using element index rather than a stable selector because
 * the component doesn't set class/id on the arc — that's fine, this
 * test file is the only consumer of the structure.
 */
function getProgressArc(container: HTMLElement): SVGCircleElement {
  const circles = container.querySelectorAll('circle');
  // Two circles: index 0 is the muted track, index 1 is the progress arc.
  return circles[1] as unknown as SVGCircleElement;
}

/** Parse the "hsl(<hue> …)" stroke back to a number for assertion. */
function hueFromStroke(stroke: string | null): number {
  if (!stroke) throw new Error('no stroke on progress arc');
  const match = /hsl\((\d+)\s/.exec(stroke);
  if (!match) throw new Error(`unrecognized stroke: ${stroke}`);
  return Number(match[1]);
}

const CIRC = 2 * Math.PI * 9;

describe('ContextRing', () => {
  it('draws an empty arc when no tokens have been spent', () => {
    const { container } = render(ContextRing, {
      props: { totalTokens: 0, contextWindow: 256_000 },
    });
    const arc = getProgressArc(container);
    // At 0% the dash offset equals the full circumference — the arc is
    // entirely "hidden" behind the offset, so the user sees only the
    // track circle. If this drifts the ring would always look partially
    // full on a brand-new thread.
    expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeCloseTo(CIRC, 3);
  });

  it('draws a full arc when usage equals the context window', () => {
    const { container } = render(ContextRing, {
      props: { totalTokens: 256_000, contextWindow: 256_000 },
    });
    const arc = getProgressArc(container);
    expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeCloseTo(0, 3);
  });

  it('draws a half arc at 50%', () => {
    const { container } = render(ContextRing, {
      props: { totalTokens: 128_000, contextWindow: 256_000 },
    });
    const arc = getProgressArc(container);
    expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeCloseTo(CIRC / 2, 3);
  });

  it('clamps over-budget usage to a fully-filled ring', () => {
    // Shouldn't happen in practice (the server guarantees
    // total_tokens <= context window) but a defensive clamp prevents
    // a negative stroke-dashoffset that would render as the arc going
    // around twice.
    const { container } = render(ContextRing, {
      props: { totalTokens: 999_999, contextWindow: 1_000 },
    });
    const arc = getProgressArc(container);
    expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeCloseTo(0, 3);
  });

  it('survives a zero context window without emitting NaN', () => {
    // A row written before we knew about contextWindow lookups would
    // pass 0 here; ensure we don't leak `NaN` into the DOM.
    const { container } = render(ContextRing, {
      props: { totalTokens: 500, contextWindow: 0 },
    });
    const arc = getProgressArc(container);
    const offset = arc.getAttribute('stroke-dashoffset');
    expect(offset).not.toContain('NaN');
    // With window=0 the component treats usage as 0%: show an empty
    // ring rather than a full one, since we don't actually know how
    // close we are to the cap.
    expect(Number(offset)).toBeCloseTo(CIRC, 3);
  });

  it('uses a green hue at low usage', () => {
    const { container } = render(ContextRing, {
      props: { totalTokens: 0, contextWindow: 100 },
    });
    // hue = (1 - 0) * 120 = 120 (green).
    expect(hueFromStroke(getProgressArc(container).getAttribute('stroke'))).toBe(120);
  });

  it('uses a yellow hue at the midpoint', () => {
    const { container } = render(ContextRing, {
      props: { totalTokens: 50, contextWindow: 100 },
    });
    // hue = (1 - 0.5) * 120 = 60 (yellow).
    expect(hueFromStroke(getProgressArc(container).getAttribute('stroke'))).toBe(60);
  });

  it('uses a red hue at full usage', () => {
    const { container } = render(ContextRing, {
      props: { totalTokens: 100, contextWindow: 100 },
    });
    // hue = (1 - 1) * 120 = 0 (red).
    expect(hueFromStroke(getProgressArc(container).getAttribute('stroke'))).toBe(0);
  });

  it('announces a human-readable summary for screen readers', () => {
    const { container } = render(ContextRing, {
      props: { totalTokens: 128_400, contextWindow: 256_000 },
    });
    const wrap = container.querySelector('.context-ring');
    expect(wrap).not.toBeNull();
    const label = wrap!.getAttribute('aria-label');
    // "Context window" prefix names what the ring represents — without
    // it, a screen-reader user landing on the control hears just a
    // percentage and has no idea what's being measured. Percentage
    // leads the numeric part, exact token counts follow in parens.
    // Exact format matters for the tooltip too; the user sees this
    // string on hover.
    expect(label).toBe('Context window: 50% used (128,400 / 256,000 tokens)');
    // The tooltip (`title`) mirrors the aria-label so sighted and
    // assistive-tech readers both get the same summary.
    expect(wrap!.getAttribute('title')).toBe(label);
  });

  it('marks the SVG aria-hidden since the wrapper carries the label', () => {
    // Otherwise a screen reader would read the decorative shape in
    // addition to the summary sentence.
    const { container } = render(ContextRing, {
      props: { totalTokens: 100, contextWindow: 1000 },
    });
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  it('slides the detail row open when clicked', async () => {
    // Title attributes don't fire on touch devices, so the detail row
    // is the only surface that reveals the exact numbers on mobile.
    // If a click stops producing it, mobile users have no path to the
    // detail again.
    const { container } = render(ContextRing, {
      props: { totalTokens: 128_400, contextWindow: 256_000 },
    });
    const btn = container.querySelector('.context-ring') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    // Closed state: no detail row, aria-expanded reflects it.
    expect(container.querySelector('.ring-detail')).toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('false');

    await fireEvent.click(btn);

    const detail = container.querySelector('.ring-detail');
    expect(detail).not.toBeNull();
    expect(detail!.textContent?.trim()).toBe(
      'Context window: 50% used (128,400 / 256,000 tokens)'
    );
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });

  it('toggles closed on a second click', async () => {
    // The ring is a toggle, not a one-shot reveal. A second click
    // should collapse the row back.
    const { container } = render(ContextRing, {
      props: { totalTokens: 100, contextWindow: 1000 },
    });
    const btn = container.querySelector('.context-ring') as HTMLButtonElement;
    await fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    await fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('scrolls the detail row into view once the slide animation completes', async () => {
    // Clicking the ring on a message near the bottom of the viewport
    // slides the detail row down past the fold, leaving the user
    // staring at the same scroll position with no visible result.
    // The fix: on `introend` (when the slide has finished growing to
    // its final height), scrollIntoView the detail row. We wait for
    // introend specifically so the element's final height is measured
    // — scrolling mid-transition would aim at a stale layout.
    //
    // jsdom doesn't implement scrollIntoView, so we stub the
    // prototype, capture the call, and restore afterward so the mock
    // doesn't leak into later tests in the file.
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      const { container } = render(ContextRing, {
        props: { totalTokens: 100, contextWindow: 1000 },
      });
      const btn = container.querySelector('.context-ring') as HTMLButtonElement;
      await fireEvent.click(btn);

      const detail = container.querySelector('.ring-detail') as HTMLElement;
      expect(detail).not.toBeNull();
      // Svelte dispatches 'introend' on the element when the intro
      // transition finishes. Firing it manually keeps the test off
      // the real 220ms clock without mocking timers.
      await fireEvent(detail, new CustomEvent('introend'));

      expect(scrollSpy).toHaveBeenCalledTimes(1);
      expect(scrollSpy.mock.calls[0][0]).toEqual({
        behavior: 'smooth',
        block: 'nearest',
      });
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('closes the detail row on Escape', async () => {
    // Keyboard users need a dismissal path that doesn't require
    // re-finding the toggle.
    const { container } = render(ContextRing, {
      props: { totalTokens: 100, contextWindow: 1000 },
    });
    const btn = container.querySelector('.context-ring') as HTMLButtonElement;
    await fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });
});

// Pure-function tests for the primitive module. The component
// tests above exercise the rendered output end-to-end; these
// pin the decision logic directly so a future change to the
// formatters / clamps surfaces here without needing a mount.

describe('clampedPct', () => {
  it('returns the literal ratio for valid inputs', () => {
    expect(clampedPct(8_000, 32_000)).toBe(0.25);
  });

  it('clamps overshoot to 1', () => {
    expect(clampedPct(40_000, 32_000)).toBe(1);
  });

  it('clamps negative inputs to 0', () => {
    expect(clampedPct(-100, 32_000)).toBe(0);
  });

  it('returns 0 when the contextWindow is missing or zero', () => {
    expect(clampedPct(1000, 0)).toBe(0);
    expect(clampedPct(1000, Number.NaN)).toBe(0);
  });
});

describe('pctToHue', () => {
  it('runs 120 at 0% through 60 at 50% to 0 at 100%', () => {
    expect(pctToHue(0)).toBe(120);
    expect(pctToHue(0.5)).toBe(60);
    expect(pctToHue(1)).toBe(0);
  });
});

describe('pctToRingColor', () => {
  it('emits an HSL string with the computed hue plus fixed sat/lightness', () => {
    expect(pctToRingColor(0)).toBe('hsl(120 65% 42%)');
    expect(pctToRingColor(1)).toBe('hsl(0 65% 42%)');
  });
});

describe('usageSummary', () => {
  it('puts the percentage first and thousands-separates the counts', () => {
    expect(usageSummary(8_000, 32_000)).toBe(
      'Context window: 25% used (8,000 / 32,000 tokens)'
    );
  });
});

describe('formatReceivedAt', () => {
  it('returns null for null or undefined input', () => {
    expect(formatReceivedAt(null, 'UTC')).toBeNull();
    expect(formatReceivedAt(undefined, 'UTC')).toBeNull();
  });

  it('returns null for unparseable ISO strings', () => {
    expect(formatReceivedAt('not-a-date', 'UTC')).toBeNull();
  });

  it('renders a stamp in the requested zone', () => {
    const out = formatReceivedAt('2026-05-19T15:42:00Z', 'UTC');
    expect(out).toBeTruthy();
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/42/);
  });

  it('falls back to the browser default when the zone string is bad', () => {
    // Garbage zone makes Intl.DateTimeFormat throw; the fallback
    // renders something useful rather than blanking the line.
    const out = formatReceivedAt('2026-05-19T15:42:00Z', 'Not/A_Real_Zone');
    expect(out).toBeTruthy();
    expect(out).toMatch(/2026/);
  });
});

describe('usageTooltip', () => {
  it('returns the summary alone when there is no timestamp', () => {
    expect(usageTooltip('Summary text', null)).toBe('Summary text');
  });

  it('folds the timestamp in after a bullet when present', () => {
    expect(usageTooltip('Summary text', 'May 19, 2026, 3:42 PM')).toBe(
      'Summary text • Received May 19, 2026, 3:42 PM'
    );
  });
});
