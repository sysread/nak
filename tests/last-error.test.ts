/**
 * Coverage for the chat error-copy projections in
 * src/lib/ui/last-error.ts: the thrown-value humanizer
 * (describeError) and the Venice rate-limit unwrapper
 * (formatRateLimitMessage). The jsonb-column parser
 * (parseLastError / headingFor) gets a smoke pass too so the module's
 * three surfaces share one suite.
 */
import { describe, it, expect } from 'vitest';
import {
  describeError,
  formatRateLimitMessage,
  headingFor,
  parseLastError,
} from '../src/lib/ui/last-error';
import { VeniceError } from '../src/lib/venice';

describe('describeError', () => {
  it('uses a non-empty Error message', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('falls back to the Error name, then the literal "Error", when message is empty', () => {
    // The "reasoning streams then vanishes silently" bug: an empty
    // .message left the banner blank, which read as "no error".
    const named = new Error('');
    named.name = 'AbortError';
    expect(describeError(named)).toBe('AbortError');
    const bare = new Error('   ');
    bare.name = '';
    expect(describeError(bare)).toBe('Error');
  });

  it('passes strings through and covers the empty-string hole', () => {
    expect(describeError('plain failure')).toBe('plain failure');
    expect(describeError('')).toBe('Unknown error');
  });

  it('JSON-dumps thrown objects, skipping the useless {} dump', () => {
    expect(describeError({ code: 42 })).toBe('{"code":42}');
    // An empty object skips the '{}' dump and falls through to
    // String(err) - still a non-empty banner, just an ugly one.
    expect(describeError({})).toBe('[object Object]');
  });

  it('never returns an empty string for null / undefined', () => {
    expect(describeError(null)).toBe('Unknown error');
    expect(describeError(undefined)).toBe('Unknown error');
  });
});

describe('formatRateLimitMessage', () => {
  function rateLimit(detail: string, status: number | null = 429): VeniceError {
    const prefix = `Venice rate limit hit (HTTP ${status ?? 429}). `;
    return new VeniceError(`${prefix}${detail}`, 'rate_limit', status);
  }

  it('peels the prefix and the OpenAI-compat string envelope', () => {
    const err = rateLimit('{"error":"The model is currently overloaded."}');
    expect(formatRateLimitMessage(err)).toBe('The model is currently overloaded.');
  });

  it('peels the nested {error:{message}} envelope shape', () => {
    const err = rateLimit('{"error":{"message":"Slow down."}}');
    expect(formatRateLimitMessage(err)).toBe('Slow down.');
  });

  it('falls back to the raw detail when the envelope is not JSON', () => {
    expect(formatRateLimitMessage(rateLimit('try later'))).toBe('try later');
    expect(formatRateLimitMessage(rateLimit('{broken json'))).toBe('{broken json');
  });

  it('uses the whole message when the expected prefix is absent', () => {
    const err = new VeniceError('some other 429 text', 'rate_limit', 429);
    expect(formatRateLimitMessage(err)).toBe('some other 429 text');
  });

  it('supplies a generic line when nothing usable remains', () => {
    const err = rateLimit('');
    expect(formatRateLimitMessage(err)).toBe('Rate limited. Please try again later.');
  });
});

describe('parseLastError / headingFor (column parser smoke pass)', () => {
  it('parses a well-formed envelope and maps its heading', () => {
    const parsed = parseLastError({
      kind: 'rate_limit',
      message: 'overloaded',
      retryable: true,
      occurred_at: '2026-01-01T00:00:00Z',
    });
    expect(parsed).toEqual({
      kind: 'rate_limit',
      message: 'overloaded',
      retryable: true,
      occurredAt: '2026-01-01T00:00:00Z',
    });
    expect(headingFor('rate_limit')).toBe('Rate limited by Venice');
  });

  it('rejects null / unknown-kind shapes instead of crashing the card', () => {
    expect(parseLastError(null)).toBeNull();
    expect(parseLastError({ kind: 'martian' })).toBeNull();
    expect(parseLastError(['not', 'an', 'object'])).toBeNull();
  });
});
