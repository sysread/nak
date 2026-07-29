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
  SPINNER_FRAME_MS,
  SPINNER_STATIC_FRAME,
  spinnerFrame,
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
    expect([0, 1, 2, 3].map(spinnerFrame)).toEqual(['-', '\\', '|', '/']);
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
    vi.advanceTimersByTime(SPINNER_FRAME_MS);
    expect(frameOf(container)).toBe('\\');
    vi.advanceTimersByTime(SPINNER_FRAME_MS * 2);
    expect(frameOf(container)).toBe('/');
  });

  it('holds a static glyph when the user asked for reduced motion', () => {
    vi.useFakeTimers();
    stubReducedMotion(true);
    const { container } = render(AsciiSpinner);

    vi.advanceTimersByTime(SPINNER_FRAME_MS * 5);
    expect(frameOf(container)).toBe(SPINNER_STATIC_FRAME);
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
