/**
 * Unit coverage for the streaming-bubble UI primitives. Pure functions -
 * no runes, no DOM - tested via plain vitest.
 *
 * The companion wiring (the streaming card gated on this predicate, with
 * the throbber rendered as a standalone row below it) lives in
 * Chat.svelte; a port to another framework would reuse this module
 * untouched.
 */
import { describe, it, expect } from 'vitest';
import { streamingCardHasContent } from '../src/lib/ui/streaming-bubble';

const idle = {
  streamingReasoning: '',
  streamingText: '',
  subconsciousDismissed: false,
  rateLimitWaitUntil: null,
};

describe('streamingCardHasContent', () => {
  it('is false in the empty inter-round / pre-first-delta gap', () => {
    // No reasoning, no text, no rate-limit wait, and either no
    // subconscious rows have fired yet or they were dismissed. This is
    // the window where the card would otherwise render as an empty box.
    expect(streamingCardHasContent(idle, 0)).toBe(false);
    expect(
      streamingCardHasContent({ ...idle, subconsciousDismissed: true }, 3)
    ).toBe(false);
  });

  it('is true while the reasoning panel has streamed prose', () => {
    expect(
      streamingCardHasContent({ ...idle, streamingReasoning: 'thinking...' }, 0)
    ).toBe(true);
  });

  it('is true while answer text is streaming', () => {
    expect(
      streamingCardHasContent({ ...idle, streamingText: 'Hello' }, 0)
    ).toBe(true);
  });

  it('is true while the subconscious checklist is live', () => {
    // Rows present and not yet dismissed - the checklist is on screen.
    expect(streamingCardHasContent(idle, 2)).toBe(true);
  });

  it('is true while the rate-limit wait row is showing', () => {
    expect(
      streamingCardHasContent({ ...idle, rateLimitWaitUntil: Date.now() }, 0)
    ).toBe(true);
  });
});
