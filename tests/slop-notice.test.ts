import { describe, it, expect } from 'vitest';
import { slopNoticeCopy } from '../src/lib/ui/slop-notice';

describe('slopNoticeCopy', () => {
  it('returns the special-token copy for the leak guard', () => {
    const copy = slopNoticeCopy('special-token-leak');
    expect(copy.headline).toBe('oops, all slop!');
    expect(copy.detail).toMatch(/glitch token/i);
  });

  it('returns the no-answer copy for the empty-completion re-roll', () => {
    // Name mirrors EMPTY_COMPLETION_GUARD in the function's
    // stream-guards.ts; the orchestrator sends it on the guard_retry
    // signal when a round ends with reasoning but no answer.
    const copy = slopNoticeCopy('empty-completion');
    expect(copy.headline).toBe('oops, all thinking!');
    expect(copy.detail).toMatch(/without answering/i);
  });

  it('falls back to generic copy for an unregistered guard', () => {
    const copy = slopNoticeCopy('some-future-guard');
    expect(copy.headline).toBe('oops, all slop!');
    expect(copy.detail).toMatch(/regenerating/i);
  });
});
