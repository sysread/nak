/**
 * Unit coverage for the server-side liveness heartbeat freshness rule.
 * Pure function - no runes, no DOM - tested via plain vitest. The
 * companion `src/screens/Chat.svelte` uses it to arm the reconnect
 * poll on thread open, to suppress the cut-off retry banner while a
 * turn is still running server-side (the refresh-during-pregame
 * case), and to flip that verdict within a minute once a hard-killed
 * function stops refreshing the heartbeat.
 */
import { describe, it, expect } from 'vitest';
import { streamLikelyInFlight } from '../src/lib/ui/stream-inflight';

const NOW = Date.parse('2026-07-13T12:00:00Z');

describe('streamLikelyInFlight', () => {
  it('null / undefined heartbeats read as no turn', () => {
    expect(streamLikelyInFlight(null, NOW)).toBe(false);
    expect(streamLikelyInFlight(undefined, NOW)).toBe(false);
  });

  it('an unparseable heartbeat reads as no turn', () => {
    expect(streamLikelyInFlight('not-a-date', NOW)).toBe(false);
  });

  it('a fresh heartbeat reads as in flight', () => {
    const beat = new Date(NOW - 5_000).toISOString();
    expect(streamLikelyInFlight(beat, NOW)).toBe(true);
  });

  it('a heartbeat just inside the 60s ceiling still reads as in flight', () => {
    // The orchestrator beats every 15s; a couple of missed beats (a
    // slow write, a briefly blocked event loop) must not read as a
    // death.
    const beat = new Date(NOW - 59_000).toISOString();
    expect(streamLikelyInFlight(beat, NOW)).toBe(true);
  });

  it('a heartbeat past the 60s ceiling reads as dead', () => {
    // Four missed beats: the function stopped refreshing - the same
    // ceiling the server probe and the cron sweep apply.
    const beat = new Date(NOW - 61_000).toISOString();
    expect(streamLikelyInFlight(beat, NOW)).toBe(false);
  });

  it('a slightly-future heartbeat (clock skew) reads as in flight', () => {
    const beat = new Date(NOW + 10_000).toISOString();
    expect(streamLikelyInFlight(beat, NOW)).toBe(true);
  });
});
