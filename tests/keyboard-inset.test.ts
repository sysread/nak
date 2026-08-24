import { describe, it, expect } from 'vitest';
import { keyboardInsetPx } from '../src/lib/ui/keyboard-inset';

describe('keyboardInsetPx', () => {
  it('returns 0 when the visual viewport matches the layout viewport', () => {
    expect(keyboardInsetPx(800, 800)).toBe(0);
  });

  it('returns 0 for small gaps (URL bar collapse, pinch-zoom settling)', () => {
    expect(keyboardInsetPx(800, 740)).toBe(0);
    expect(keyboardInsetPx(800, 701)).toBe(0);
  });

  it('returns the gap when it is keyboard-sized', () => {
    expect(keyboardInsetPx(800, 500)).toBe(300);
    expect(keyboardInsetPx(800, 700)).toBe(100);
  });

  it('rounds fractional viewport heights to whole pixels', () => {
    expect(keyboardInsetPx(800, 499.6)).toBe(300);
  });

  it('returns 0 when the visual viewport is larger than the layout viewport', () => {
    // Seen transiently mid-rotation; a negative inset would grow the
    // shell past the screen.
    expect(keyboardInsetPx(500, 800)).toBe(0);
  });
});
