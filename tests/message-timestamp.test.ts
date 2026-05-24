/**
 * Unit tests for the per-message action-bar timestamp helper.
 *
 * The helper renders a fixed `yyyy-mm-dd HH:mm` stamp in the user's
 * preferred zone. We assert the exact shape (zero-padded, 24-hour,
 * no locale drift) since the whole point of diverging from
 * ContextRing's locale-aware stamp is a deterministic fixed-width
 * form. The midnight case guards the `hourCycle: 'h23'` choice that
 * keeps 00:00 from rendering as 24:00.
 */
import { describe, it, expect } from 'vitest';
import { formatMessageStamp } from '../src/lib/ui/message-timestamp';

describe('formatMessageStamp', () => {
  it('returns null for null or undefined input', () => {
    expect(formatMessageStamp(null, 'UTC')).toBeNull();
    expect(formatMessageStamp(undefined, 'UTC')).toBeNull();
  });

  it('returns null for unparseable ISO strings', () => {
    expect(formatMessageStamp('not-a-date', 'UTC')).toBeNull();
  });

  it('renders yyyy-mm-dd HH:mm in the requested zone', () => {
    expect(formatMessageStamp('2026-05-19T15:42:00Z', 'UTC')).toBe(
      '2026-05-19 15:42'
    );
  });

  it('shifts the wall-clock into the requested zone', () => {
    // 15:42 UTC is 11:42 in New York (EDT, UTC-4) on this date, and
    // the date does not roll back across midnight.
    expect(formatMessageStamp('2026-05-19T15:42:00Z', 'America/New_York')).toBe(
      '2026-05-19 11:42'
    );
  });

  it('renders midnight as 00:00, never 24:00', () => {
    expect(formatMessageStamp('2026-05-19T00:00:00Z', 'UTC')).toBe(
      '2026-05-19 00:00'
    );
  });

  it('falls back to the browser default when the zone string is bad', () => {
    const out = formatMessageStamp('2026-05-19T15:42:00Z', 'Not/A_Real_Zone');
    expect(out).toBeTruthy();
    expect(out).toMatch(/^2026-05-\d{2} \d{2}:\d{2}$/);
  });
});
