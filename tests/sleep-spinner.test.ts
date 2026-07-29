/**
 * Coverage for the memory librarian's sleeping-Z in-flight cue. The
 * animation itself is CSS keyframes, which jsdom does not run, so these
 * assert the structural contract the stylesheet depends on - the right
 * number of glyph spans, each carrying the position class its phase
 * offset and staircase transform are keyed to.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import SleepSpinner from '../src/components/SleepSpinner.svelte';

afterEach(cleanup);

describe('SleepSpinner', () => {
  it('renders three Z glyphs', () => {
    const { container } = render(SleepSpinner);
    const zs = container.querySelectorAll('.sleep-spinner .z');
    // Three, because the strip's gutter is reserved at 3ch - a fourth
    // would overflow the column it shares with the check/cross rows.
    expect(zs).toHaveLength(3);
    expect([...zs].map((z) => z.textContent)).toEqual(['Z', 'Z', 'Z']);
  });

  it('tags the glyphs low to high in document order', () => {
    const { container } = render(SleepSpinner);
    const zs = container.querySelectorAll('.sleep-spinner .z');
    // Order is load-bearing twice over: the classes carry both the
    // staircase transform and the animation-delay that walks peak
    // brightness upward. Reordering them would send the wave down.
    expect(zs[0].classList.contains('z-low')).toBe(true);
    expect(zs[1].classList.contains('z-mid')).toBe(true);
    expect(zs[2].classList.contains('z-high')).toBe(true);
  });

  it('hides itself from assistive tech', () => {
    const { container } = render(SleepSpinner);
    const root = container.querySelector('.sleep-spinner');
    // Every call site sits inside an aria-live region. The CSS
    // animation mutates no DOM so there is nothing to re-announce, but
    // the glyph is still decorative noise next to the row's own label.
    expect(root?.getAttribute('aria-hidden')).toBe('true');
  });

  it('emits no whitespace between the glyphs', () => {
    const { container } = render(SleepSpinner);
    // The markup packs the spans tight on purpose. A newline between
    // them would collapse to a space under `white-space: pre` and push
    // the trio past the 3ch the parent column reserves.
    expect(container.querySelector('.sleep-spinner')?.textContent).toBe('ZZZ');
  });
});
