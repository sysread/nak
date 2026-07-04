// Pins the follow-ups due-selection logic: due detection, the expiry
// policy, the surfacing cooldown, and the capped/ordered selection.
// This is the anti-nag behavior - the difference between "raises the
// meeting once at the right moment" and "asks every thread forever".
import { describe, it, expect } from 'vitest';
import {
  DUE_SURFACE_CAP,
  DUE_SURFACE_COOLDOWN_MS,
  DUE_EXPIRY_MS,
  MAX_UNANSWERED_SURFACINGS,
  isDue,
  isExpiredByPolicy,
  isCoolingDown,
  selectDueFollowups,
  type DueCandidateRow,
} from '../supabase/functions/_shared/followups';

const NOW = Date.parse('2026-07-04T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function row(overrides: Partial<DueCandidateRow> & { id: string }): DueCandidateRow {
  return {
    last_surfaced_at: null,
    relevant_after: new Date(NOW - DAY).toISOString(),
    surface_count: 0,
    ...overrides,
  };
}

describe('isDue', () => {
  it('is true once relevant_after has passed', () => {
    expect(isDue(row({ id: 'a' }), NOW)).toBe(true);
  });

  it('is false for a future date and for undated rows', () => {
    expect(isDue(row({ id: 'a', relevant_after: new Date(NOW + DAY).toISOString() }), NOW)).toBe(
      false,
    );
    expect(isDue(row({ id: 'a', relevant_after: null }), NOW)).toBe(false);
  });

  it('treats an unparseable date as not due', () => {
    expect(isDue(row({ id: 'a', relevant_after: 'not-a-date' }), NOW)).toBe(false);
  });
});

describe('isExpiredByPolicy', () => {
  it('expires after the unanswered-surfacing budget', () => {
    expect(
      isExpiredByPolicy(row({ id: 'a', surface_count: MAX_UNANSWERED_SURFACINGS }), NOW),
    ).toBe(true);
    expect(
      isExpiredByPolicy(row({ id: 'a', surface_count: MAX_UNANSWERED_SURFACINGS - 1 }), NOW),
    ).toBe(false);
  });

  it('expires once far enough past relevant_after, even never surfaced', () => {
    const stale = row({
      id: 'a',
      relevant_after: new Date(NOW - DUE_EXPIRY_MS - HOUR).toISOString(),
    });
    expect(isExpiredByPolicy(stale, NOW)).toBe(true);
  });

  it('never expires an undated or future-dated loop', () => {
    expect(isExpiredByPolicy(row({ id: 'a', relevant_after: null, surface_count: 99 }), NOW)).toBe(
      false,
    );
    expect(
      isExpiredByPolicy(
        row({
          id: 'a',
          relevant_after: new Date(NOW + DAY).toISOString(),
          surface_count: 99,
        }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe('isCoolingDown', () => {
  it('is true within the cooldown window and false past it', () => {
    const recent = row({ id: 'a', last_surfaced_at: new Date(NOW - HOUR).toISOString() });
    const old = row({
      id: 'a',
      last_surfaced_at: new Date(NOW - DUE_SURFACE_COOLDOWN_MS - HOUR).toISOString(),
    });
    expect(isCoolingDown(recent, NOW)).toBe(true);
    expect(isCoolingDown(old, NOW)).toBe(false);
  });

  it('is false when never surfaced', () => {
    expect(isCoolingDown(row({ id: 'a' }), NOW)).toBe(false);
  });
});

describe('selectDueFollowups', () => {
  it('surfaces due rows, skips cooling ones, expires over-budget ones', () => {
    const rows = [
      row({ id: 'due' }),
      row({ id: 'cooling', last_surfaced_at: new Date(NOW - HOUR).toISOString() }),
      row({ id: 'spent', surface_count: MAX_UNANSWERED_SURFACINGS }),
      row({ id: 'future', relevant_after: new Date(NOW + DAY).toISOString() }),
      row({ id: 'undated', relevant_after: null }),
    ];
    const { due, expiredIds } = selectDueFollowups(rows, NOW);
    expect(due.map((r) => r.id)).toEqual(['due']);
    expect(expiredIds).toEqual(['spent']);
  });

  it('expiry wins over cooldown so a spent loop cannot cycle forever', () => {
    const spentAndCooling = row({
      id: 'a',
      surface_count: MAX_UNANSWERED_SURFACINGS,
      last_surfaced_at: new Date(NOW - HOUR).toISOString(),
    });
    const { due, expiredIds } = selectDueFollowups([spentAndCooling], NOW);
    expect(due).toEqual([]);
    expect(expiredIds).toEqual(['a']);
  });

  it('caps at DUE_SURFACE_CAP, longest-waiting first', () => {
    const rows = [
      row({ id: 'newest', relevant_after: new Date(NOW - 1 * DAY).toISOString() }),
      row({ id: 'oldest', relevant_after: new Date(NOW - 3 * DAY).toISOString() }),
      row({ id: 'middle', relevant_after: new Date(NOW - 2 * DAY).toISOString() }),
    ];
    const { due } = selectDueFollowups(rows, NOW);
    expect(due.length).toBe(DUE_SURFACE_CAP);
    expect(due.map((r) => r.id)).toEqual(['oldest', 'middle']);
  });
});
