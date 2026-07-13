/**
 * Unit coverage for the server-side in-flight stamp freshness rule.
 * Pure function - no runes, no DOM - tested via plain vitest. The
 * companion `src/screens/Chat.svelte` uses it to arm the reconnect
 * poll on thread open and to suppress the cut-off retry banner while
 * a turn is still running server-side (the refresh-during-pregame
 * case).
 */
import { describe, it, expect } from 'vitest';
import { streamLikelyInFlight } from '../src/lib/ui/stream-inflight';

const NOW = Date.parse('2026-07-13T12:00:00Z');

describe('streamLikelyInFlight', () => {
  it('null / undefined stamps read as no turn', () => {
    expect(streamLikelyInFlight(null, NOW)).toBe(false);
    expect(streamLikelyInFlight(undefined, NOW)).toBe(false);
  });

  it('an unparseable stamp reads as no turn', () => {
    expect(streamLikelyInFlight('not-a-date', NOW)).toBe(false);
  });

  it('a fresh stamp reads as in flight', () => {
    const stamp = new Date(NOW - 5_000).toISOString();
    expect(streamLikelyInFlight(stamp, NOW)).toBe(true);
  });

  it('a stamp near the wall-deadline ceiling still reads as in flight', () => {
    // A legitimately long turn holds the stamp for up to the 380s wall
    // deadline; the threshold is twice that, mirroring the server
    // probe's stale-row janitor.
    const stamp = new Date(NOW - 700_000).toISOString();
    expect(streamLikelyInFlight(stamp, NOW)).toBe(true);
  });

  it('a stamp past the staleness ceiling reads as dead', () => {
    const stamp = new Date(NOW - 800_000).toISOString();
    expect(streamLikelyInFlight(stamp, NOW)).toBe(false);
  });

  it('a slightly-future stamp (clock skew) reads as in flight', () => {
    const stamp = new Date(NOW + 10_000).toISOString();
    expect(streamLikelyInFlight(stamp, NOW)).toBe(true);
  });
});
