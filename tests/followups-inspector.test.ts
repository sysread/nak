// Pins the follow-ups half of the seedling inspector: lifecycle
// grouping, the open-card status chip's three readings, headlines, and
// the intents-off modal title.
import { describe, it, expect } from 'vitest';
import {
  groupFollowups,
  openStatusChip,
  followupsHeadline,
  inspectorTitle,
  type FollowupInspectorRow,
} from '../src/lib/ui/followups-inspector';

const NOW = Date.parse('2026-07-04T12:00:00Z');
const DAY = 86_400_000;

function row(
  overrides: Partial<FollowupInspectorRow> & { id: string },
): FollowupInspectorRow {
  return {
    question: 'Ask how it went',
    context: '',
    status: 'open',
    relevant_after: null,
    resolution: null,
    created_at: new Date(NOW - 2 * DAY).toISOString(),
    updated_at: new Date(NOW - DAY).toISOString(),
    ...overrides,
  };
}

describe('groupFollowups', () => {
  it('partitions by lifecycle, merging dismissed and expired into let-go', () => {
    const grouped = groupFollowups([
      row({ id: 'o1' }),
      row({ id: 'a1', status: 'answered', resolution: 'went well' }),
      row({ id: 'd1', status: 'dismissed' }),
      row({ id: 'x1', status: 'expired' }),
    ]);
    expect(grouped.open.map((r) => r.id)).toEqual(['o1']);
    expect(grouped.answered.map((r) => r.id)).toEqual(['a1']);
    expect(grouped.letGo.map((r) => r.id).sort()).toEqual(['d1', 'x1']);
  });

  it('sorts each group most-recently-updated first', () => {
    const grouped = groupFollowups([
      row({ id: 'older', updated_at: new Date(NOW - 3 * DAY).toISOString() }),
      row({ id: 'newer', updated_at: new Date(NOW - DAY).toISOString() }),
    ]);
    expect(grouped.open.map((r) => r.id)).toEqual(['newer', 'older']);
  });
});

describe('openStatusChip', () => {
  it('reads "ready to ask" once the date has passed', () => {
    const due = row({ id: 'a', relevant_after: new Date(NOW - DAY).toISOString() });
    expect(openStatusChip(due, NOW)).toBe('ready to ask');
  });

  it('names the wait for a future date', () => {
    const upcoming = row({ id: 'a', relevant_after: '2026-07-06T00:00:00Z' });
    expect(openStatusChip(upcoming, NOW)).toBe('asking after Jul 6');
  });

  it('falls back to "when it comes up" for undated or unparseable dates', () => {
    expect(openStatusChip(row({ id: 'a' }), NOW)).toBe('when it comes up');
    expect(openStatusChip(row({ id: 'a', relevant_after: 'garbage' }), NOW)).toBe(
      'when it comes up',
    );
  });
});

describe('headlines and title', () => {
  it('pluralizes over open rows only', () => {
    expect(followupsHeadline(0)).toBe('Nothing Nak is waiting to hear about');
    expect(followupsHeadline(1)).toBe('Nak is waiting to hear about 1 thing');
    expect(followupsHeadline(3)).toBe('Nak is waiting to hear about 3 things');
  });

  it('drops the intentions half of the title when intents is off', () => {
    expect(inspectorTitle(true)).toBe('Working intentions & follow-ups');
    expect(inspectorTitle(false)).toBe('Follow-ups');
  });
});
