/**
 * Coverage for the trailing "still working" row shared by the memory
 * and wiki librarian run strips.
 */
import { describe, it, expect } from 'vitest';
import { showsRunTail, RUN_TAIL_LABEL } from '../src/lib/ui/librarian-run-tail';

const ok = { status: 'ok' } as const;
const err = { status: 'error' } as const;
const pending = { status: 'pending' } as const;

describe('showsRunTail', () => {
  it('shows nothing once the run has settled', () => {
    expect(showsRunTail([ok, ok], false)).toBe(false);
    expect(showsRunTail([], false)).toBe(false);
  });

  it('shows the tail in the gap before the first step arrives', () => {
    // The strip renders the instant a run starts, ahead of any
    // progress event; without this the opening gap has no cue at all.
    expect(showsRunTail([], true)).toBe(true);
  });

  it('shows the tail after a settled tool row', () => {
    // The regression this exists for: tool rows are pushed already
    // settled, so a run mid-retry showed a cross and then stillness.
    expect(showsRunTail([ok, err], true)).toBe(true);
    expect(showsRunTail([ok, ok], true)).toBe(true);
  });

  it('defers to a pending bottom row rather than stacking spinners', () => {
    expect(showsRunTail([ok, pending], true)).toBe(false);
    expect(showsRunTail([pending], true)).toBe(false);
  });

  it('only inspects the bottom row', () => {
    // A pending row buried mid-list (it cannot happen today, but the
    // predicate should not depend on that) must not suppress the tail.
    expect(showsRunTail([pending, ok], true)).toBe(true);
  });

  it('labels the row without naming a phase', () => {
    // Naming one ("Thinking") would be a guess the next real row could
    // contradict.
    expect(RUN_TAIL_LABEL).toBe('Working');
  });
});
