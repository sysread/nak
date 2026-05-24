import { describe, it, expect } from 'vitest';
import { slopNoticeCopy } from '../src/lib/ui/slop-notice';

describe('slopNoticeCopy', () => {
  it('returns the special-token copy for the leak guard', () => {
    const copy = slopNoticeCopy('special-token-leak');
    expect(copy.headline).toBe('oops, all slop!');
    expect(copy.detail).toMatch(/glitch token/i);
  });

  it('falls back to generic copy for an unregistered guard', () => {
    const copy = slopNoticeCopy('some-future-guard');
    expect(copy.headline).toBe('oops, all slop!');
    expect(copy.detail).toMatch(/regenerating/i);
  });
});
