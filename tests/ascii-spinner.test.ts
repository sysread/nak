/**
 * Coverage for the text spinner shown on in-flight rows of the manual
 * librarian-run strip: the frame primitives, and the component's timer
 * / reduced-motion behaviour.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import AsciiSpinner from '../src/components/AsciiSpinner.svelte';
import {
  spinnerFrame,
  spinnerFrameMs,
  spinnerStaticFrame,
  spinnerWidthCh,
} from '../src/lib/ui/ascii-spinner';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * jsdom has no matchMedia. Stub it so the component can ask about
 * reduced motion; `reduce` picks which answer it gets.
 */
function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: reduce,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

/**
 * Read the rendered frame. `flushSync` first because the interval
 * callback only assigns to a rune - Svelte 5 batches the DOM write
 * into a microtask, which a synchronous assertion would race.
 */
function frameOf(container: HTMLElement): string {
  flushSync();
  const span = container.querySelector('.ascii-spinner');
  if (!span) throw new Error('spinner not rendered');
  return span.textContent ?? '';
}

describe('spinnerFrame', () => {
  it('walks the bar sequence in order', () => {
    // Not `.map(spinnerFrame)` - map would pass the array index as the
    // variant argument.
    expect([0, 1, 2, 3].map((t) => spinnerFrame(t))).toEqual([
      '-',
      '\\',
      '|',
      '/',
    ]);
  });

  it('wraps past the end of the sequence', () => {
    expect(spinnerFrame(4)).toBe(spinnerFrame(0));
    expect(spinnerFrame(9)).toBe(spinnerFrame(1));
  });

  it('stays total on a negative tick', () => {
    // The counter only ever counts up, but a total function means no
    // caller has to prove that to avoid an undefined frame.
    expect(spinnerFrame(-1)).toBe('/');
    expect(spinnerFrame(-7)).toBe(spinnerFrame(1));
  });
});

describe('AsciiSpinner', () => {
  it('advances a frame per interval tick', () => {
    vi.useFakeTimers();
    stubReducedMotion(false);
    const { container } = render(AsciiSpinner);

    expect(frameOf(container)).toBe('-');
    vi.advanceTimersByTime(spinnerFrameMs());
    expect(frameOf(container)).toBe('\\');
    vi.advanceTimersByTime(spinnerFrameMs() * 2);
    expect(frameOf(container)).toBe('/');
  });

  it('holds a static glyph when the user asked for reduced motion', () => {
    vi.useFakeTimers();
    stubReducedMotion(true);
    const { container } = render(AsciiSpinner);

    vi.advanceTimersByTime(spinnerFrameMs() * 5);
    expect(frameOf(container)).toBe(spinnerStaticFrame());
  });

  it('stops its timer on unmount', () => {
    vi.useFakeTimers();
    stubReducedMotion(false);
    const { unmount } = render(AsciiSpinner);
    unmount();
    // A leaked interval would keep ticking after the strip closes; with
    // one spinner mounted per pending row across a long run that adds
    // up to a background timer per completed step.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the sleep variant', () => {
  it('grows a zzz and restarts', () => {
    // The memory librarian's two passes are both named after sleep
    // stages, so the sequence says which subsystem is working.
    expect([0, 1, 2, 3].map((t) => spinnerFrame(t, 'sleep'))).toEqual([
      'z',
      'zZ',
      'zZZ',
      'z',
    ]);
  });

  it('drowses far slower than the bar', () => {
    // At the bar's cadence a zzz reads as frantic, which is the
    // opposite of what a sleep pass should look like.
    expect(spinnerFrameMs('sleep')).toBeGreaterThan(spinnerFrameMs('bar') * 2);
  });

  it('reserves room for its widest frame', () => {
    // The caller sizes the cell from this; if it undercounted, a
    // growing sequence would nudge the label beside it every cycle.
    expect(spinnerWidthCh('sleep')).toBe(3);
    expect(spinnerWidthCh('bar')).toBe(1);
  });

  it('holds a full zzz under reduced motion', () => {
    expect(spinnerStaticFrame('sleep')).toBe('zZZ');
  });

  it('renders the sleep sequence when asked for it', () => {
    vi.useFakeTimers();
    stubReducedMotion(false);
    const { container } = render(AsciiSpinner, { props: { variant: 'sleep' } });

    expect(frameOf(container)).toBe('z');
    vi.advanceTimersByTime(spinnerFrameMs('sleep'));
    expect(frameOf(container)).toBe('zZ');
  });

  it('does not tick at the bar cadence when set to sleep', () => {
    // Guards the wiring: reading the interval off the default variant
    // would animate the zzz three times too fast.
    vi.useFakeTimers();
    stubReducedMotion(false);
    const { container } = render(AsciiSpinner, { props: { variant: 'sleep' } });

    vi.advanceTimersByTime(spinnerFrameMs('bar'));
    expect(frameOf(container)).toBe('z');
  });
});
