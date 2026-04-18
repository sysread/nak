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
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import ContextRing from '../src/components/ContextRing.svelte';

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
    // Thousands separators + middle-dot + percentage. Exact format
    // matters for the tooltip too; the user sees this string on hover.
    expect(label).toBe('128,400 / 256,000 tokens \u00b7 50%');
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
});
